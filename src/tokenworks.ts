import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { TOKENWORKS_SESSION_REF } from './constants.ts'

const ISSUER = 'https://id.ustc.edu.cn/doc/oidc'
const CONTENT_ROOT = 'https://id.ustc.edu.cn/doc/claude/tokenworks-content'
const BOOTSTRAP_URL = 'https://id.ustc.edu.cn/doc/claude/bootstrap'
const PUBLISHER_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAQaBXGreNtCH3e1iRrPECbtZofjjB/OJefrBKgEpQ5lI=\n-----END PUBLIC KEY-----'
const LOGIN_TTL = 10 * 60_000

interface Session {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  clientId: string
  subject: string
  name: string
}

interface LoginConfig {
  clientId: string
  scopes: string[]
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  requiresIssuer: boolean
}

interface PendingLogin {
  server: Server
  timer: ReturnType<typeof setTimeout>
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  config: LoginConfig
  generation: number
  consumed: boolean
}

export type TokenworksRequester = (url: string, init?: RequestInit) => Promise<Response>

/** Only obtains a gateway key; inference still uses the existing USTC helper. */
export class TokenworksAuth {
  private pending: PendingLogin | undefined
  private config: Promise<LoginConfig> | undefined
  private key: { value: string; expiresAt: number; recheckAt: number } | undefined
  private fetching: Promise<string> | undefined
  private credentialWrites: Promise<void> = Promise.resolve()
  private generation = 0
  private error: string | undefined
  private readonly ref = credentialRef(TOKENWORKS_SESSION_REF)

  constructor(
    private readonly ctx: Context,
    private readonly request: TokenworksRequester = requestDirect,
    private readonly publisherKey = PUBLISHER_KEY,
  ) {}

  async snapshot(): Promise<{ configured: boolean; writable: boolean; pending: boolean; name?: string; error?: string }> {
    const [info, session] = await Promise.all([this.ctx.credentials.describe(this.ref), this.readSession()])
    return {
      configured: session !== undefined,
      writable: info.writable,
      pending: this.pending !== undefined,
      ...(session === undefined ? {} : { name: session.name }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  async begin(): Promise<{ authUrl: string }> {
    this.cancel()
    this.error = undefined
    const generation = this.generation
    const config = await this.loginConfig()
    if (generation !== this.generation) throw new Error('Tokenworks sign-in was cancelled')
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      const pending = this.pending
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      if (pending?.server !== server || pending.consumed || url.searchParams.get('state') !== pending.state) {
        response.writeHead(400).end('登录状态无效，请重新开始登录。')
        return
      }
      pending.consumed = true
      void this.complete(pending, url).then(() => {
        response.end('词元工坊登录完成，可以关闭此页并返回 DSH。')
      }, error => {
        if (pending.generation === this.generation) this.error = error instanceof Error ? error.message : 'Tokenworks sign-in failed'
        response.writeHead(400).end('词元工坊登录失败，请返回 DSH 查看错误并重试。')
      }).finally(() => { if (this.pending === pending) this.closeLogin() })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
    if (generation !== this.generation) {
      server.close()
      throw new Error('Tokenworks sign-in was cancelled')
    }
    const address = server.address() as { port: number }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const timer = setTimeout(() => {
      this.cancel()
      this.error = 'Tokenworks sign-in expired; start again'
    }, LOGIN_TTL)
    timer.unref()
    server.unref()
    this.pending = { server, timer, state, nonce, verifier, redirectUri, config, generation, consumed: false }
    const url = new URL(config.authorizationEndpoint)
    url.search = new URLSearchParams({
      client_id: config.clientId, response_type: 'code', redirect_uri: redirectUri,
      scope: config.scopes.join(' '), state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return { authUrl: url.href }
  }

  cancel(): void {
    ++this.generation
    this.closeLogin()
    this.fetching = undefined
  }

  async logout(): Promise<void> {
    this.cancel()
    this.key = undefined
    this.error = undefined
    await this.writeSession(undefined, this.generation)
  }

  dispose(): void {
    this.cancel()
    this.key = undefined
  }

  async apiKey(): Promise<string> {
    if (this.key !== undefined && Date.now() < this.key.recheckAt && Date.now() < this.key.expiresAt) return this.key.value
    if (this.fetching !== undefined) return this.fetching
    const generation = this.generation
    const fetching = this.fetchKey(generation)
    this.fetching = fetching
    try { return await fetching } finally { if (this.fetching === fetching) this.fetching = undefined }
  }

  private closeLogin(): void {
    if (this.pending === undefined) return
    clearTimeout(this.pending.timer)
    this.pending.server.close()
    this.pending = undefined
  }

  private async complete(pending: PendingLogin, url: URL): Promise<void> {
    const issuer = url.searchParams.get('iss')
    if ((pending.config.requiresIssuer || issuer !== null) && issuer !== ISSUER) throw new Error('Tokenworks callback issuer does not match')
    if (url.searchParams.has('error')) throw new Error('Tokenworks sign-in was denied')
    const code = url.searchParams.get('code')
    if (!code) throw new Error('Tokenworks callback has no authorization code')
    const token = await this.exchange(pending.config, {
      grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
    })
    const claims = await this.verifyIdToken(token.id_token, pending.config, pending.nonce)
    const session = this.sessionFromToken(token, pending.config.clientId, claims)
    const key = await this.bootstrap(session.accessToken)
    if (pending.generation !== this.generation) throw new Error('Tokenworks sign-in was cancelled')
    await this.writeSession(session, pending.generation)
    if (pending.generation !== this.generation) throw new Error('Tokenworks sign-in was cancelled')
    this.key = key
    this.error = undefined
  }

  private async fetchKey(generation: number): Promise<string> {
    try {
      let session = await this.readSession()
      if (session === undefined) throw new Error('Sign in to Tokenworks first')
      if (Date.now() + 30_000 >= session.expiresAt) {
        if (!session.refreshToken) throw new LoginExpired()
        const config = await this.loginConfig()
        if (config.clientId !== session.clientId) throw new LoginExpired()
        const token = await this.exchange(config, { grant_type: 'refresh_token', refresh_token: session.refreshToken })
        const claims = token.id_token === undefined ? { sub: session.subject, name: session.name } : await this.verifyIdToken(token.id_token, config)
        if (claims.sub !== session.subject) throw new Error('Tokenworks refreshed account does not match')
        session = this.sessionFromToken(token, session.clientId, claims, session.refreshToken)
        if (generation !== this.generation) throw new Error('Tokenworks sign-in changed')
        await this.writeSession(session, generation)
      }
      const key = await this.bootstrap(session.accessToken)
      if (generation !== this.generation) throw new Error('Tokenworks sign-in changed')
      this.key = key
      return key.value
    } catch (error) {
      if (generation !== this.generation) throw new Error('Tokenworks sign-in changed')
      if (error instanceof LoginExpired) {
        this.key = undefined
        await this.writeSession(undefined, generation)
      } else if (error instanceof AccessDenied) {
        this.key = undefined
      } else if (error instanceof NetworkError && this.key !== undefined && Date.now() < this.key.expiresAt) {
        this.key.recheckAt = Math.min(this.key.expiresAt, Date.now() + 60_000)
        return this.key.value
      }
      throw error
    }
  }

  private async readSession(): Promise<Session | undefined> {
    const hit = await this.ctx.credentials.resolve(this.ref)
    return hit === undefined ? undefined : JSON.parse(hit.value) as Session
  }

  // Serialize writes so a refresh completing during sign-out cannot restore the session.
  private writeSession(session: Session | undefined, generation: number): Promise<void> {
    this.credentialWrites = this.credentialWrites.catch(() => {}).then(async () => {
      if (generation !== this.generation) return
      if (session === undefined) await this.ctx.credentials.unset(this.ref)
      else await this.ctx.credentials.set(this.ref, JSON.stringify(session))
    })
    return this.credentialWrites
  }

  private async exchange(config: LoginConfig, fields: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.request(config.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, ...fields }).toString(),
    })
    const token = await readJson(response)
    if (token.error === 'invalid_grant' || response.status === 401) throw new LoginExpired()
    if (!response.ok) throw new Error(`Tokenworks token endpoint answered HTTP ${response.status}`)
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') throw new Error('Tokenworks returned an invalid access token')
    return token
  }

  private sessionFromToken(token: Record<string, unknown>, clientId: string, claims: Record<string, unknown>, previousRefresh?: string): Session {
    if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('Tokenworks returned an invalid token lifetime')
    const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token : previousRefresh
    return {
      accessToken: token.access_token as string,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: Date.now() + token.expires_in * 1_000, clientId, subject: claims.sub as string,
      name: [claims.name, claims.preferred_username, claims.email, claims.sub].find(value => typeof value === 'string') as string,
    }
  }

  private async bootstrap(accessToken: string): Promise<NonNullable<TokenworksAuth['key']>> {
    const response = await this.request(BOOTSTRAP_URL, { headers: { authorization: `Bearer ${accessToken}` } })
    if (response.status === 401) throw new LoginExpired()
    if (response.status === 403) throw new AccessDenied()
    if (response.status >= 500) throw new NetworkError('Tokenworks gateway key service is temporarily unavailable')
    if (!response.ok) throw new Error(`Tokenworks bootstrap answered HTTP ${response.status}`)
    const value = await readJson(response)
    const upstream = new URL(String(value.inferenceGatewayBaseUrl))
    if (upstream.origin !== 'https://api.llm.ustc.edu.cn' || upstream.username || upstream.password || upstream.search || upstream.hash) {
      throw new Error('Tokenworks gateway is not the USTC API')
    }
    if (value.inferenceProvider !== 'gateway' || (value.inferenceCredentialKind ?? 'static') !== 'static' || (value.inferenceGatewayAuthScheme ?? 'bearer') !== 'bearer' || Object.keys(value.inferenceCustomHeaders ?? {}).length > 0) {
      throw new Error('Tokenworks gateway authentication is unsupported')
    }
    if (typeof value.inferenceGatewayApiKey !== 'string' || !value.inferenceGatewayApiKey.trim()) throw new Error('Tokenworks bootstrap has no gateway key')
    const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt * (value.expiresAt < 1e12 ? 1_000 : 1) : Infinity
    if (!(expiresAt > Date.now())) throw new Error('Tokenworks gateway key has expired')
    const minutes = typeof value.configRecheckIntervalMinutes === 'number' ? Math.max(2, Math.min(30, value.configRecheckIntervalMinutes)) : 10
    return { value: value.inferenceGatewayApiKey.trim(), expiresAt, recheckAt: Math.min(expiresAt, Date.now() + minutes * 60_000) }
  }

  private loginConfig(): Promise<LoginConfig> {
    this.config ??= this.loadLoginConfig().catch(error => { this.config = undefined; throw error })
    return this.config
  }

  private async loadLoginConfig(): Promise<LoginConfig> {
    const envelope = await this.json(`${CONTENT_ROOT}/stable/latest.json`) as { payload: string; signature: string }
    const bytes = Buffer.from(envelope.payload, 'base64url')
    if (!verify(null, bytes, this.publisherKey, Buffer.from(envelope.signature, 'base64url'))) throw new Error('Tokenworks content signature does not match')
    const manifest = JSON.parse(bytes.toString('utf8')) as { publisher: string; channel: string; bundle: { url: string; bytes: number; sha256: string } }
    if (manifest.publisher !== 'ustc-tokenworks' || manifest.channel !== 'stable' || !manifest.bundle.url.startsWith(`${CONTENT_ROOT}/bundles/`)) throw new Error('Tokenworks content publisher does not match')
    const bundleResponse = await this.request(manifest.bundle.url)
    if (!bundleResponse.ok) throw new Error(`Tokenworks content answered HTTP ${bundleResponse.status}`)
    const bundle = Buffer.from(await bundleResponse.arrayBuffer())
    if (bundle.length !== manifest.bundle.bytes || createHash('sha256').update(bundle).digest('hex') !== manifest.bundle.sha256) throw new Error('Tokenworks content checksum does not match')
    const content = JSON.parse(bundle.toString('utf8')) as { configuration: { organizations: { id: string; oidc: { issuer: string; clientId: string; scopes: string[] } }[] } }
    const oidc = content.configuration.organizations.find(org => org.id === 'ustc')?.oidc
    if (oidc?.issuer !== ISSUER || !oidc.clientId || !oidc.scopes.includes('openid')) throw new Error('Tokenworks OIDC configuration is invalid')
    const discovery = await this.json(`${ISSUER}/.well-known/openid-configuration`) as Record<string, unknown>
    if (discovery.issuer !== ISSUER || !(discovery.code_challenge_methods_supported as string[])?.includes('S256')) throw new Error('Tokenworks OIDC issuer does not support PKCE')
    const endpoint = (value: unknown): string => {
      const url = new URL(String(value))
      if (url.origin !== new URL(ISSUER).origin || url.username || url.password) throw new Error('Tokenworks OIDC endpoint has an unexpected origin')
      return url.href
    }
    return {
      clientId: oidc.clientId, scopes: oidc.scopes,
      authorizationEndpoint: endpoint(discovery.authorization_endpoint), tokenEndpoint: endpoint(discovery.token_endpoint),
      jwksUri: endpoint(discovery.jwks_uri), requiresIssuer: discovery.authorization_response_iss_parameter_supported === true,
    }
  }

  private async verifyIdToken(token: unknown, config: LoginConfig, nonce?: string): Promise<Record<string, unknown>> {
    if (typeof token !== 'string') throw new Error('Tokenworks response has no ID token')
    const [headerPart, payloadPart, signature, extra] = token.split('.')
    if (!headerPart || !payloadPart || !signature || extra !== undefined) throw new Error('Tokenworks ID token is invalid')
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg: string; kid: string }
    if (header.alg !== 'RS256') throw new Error('Tokenworks ID token algorithm is unsupported')
    const jwks = await this.json(config.jwksUri) as { keys: (JsonWebKey & { kid?: string; use?: string; alg?: string })[] }
    const keys = jwks.keys.filter(key => key.kty === 'RSA' && key.kid === header.kid && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'))
    if (keys.length !== 1 || !verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: keys[0]!, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error('Tokenworks ID token signature does not match')
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const now = Date.now() / 1_000
    const validAudience = aud.includes(config.clientId) && (aud.length === 1 || claims.azp === config.clientId) && (claims.azp === undefined || claims.azp === config.clientId)
    const validLifetime = typeof claims.exp === 'number' && claims.exp >= now - 60 && typeof claims.iat === 'number' && claims.iat <= now + 60
    if (claims.iss !== ISSUER || !validAudience || !validLifetime || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)) {
      throw new Error('Tokenworks ID token claims do not match')
    }
    return claims
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.request(url)
    if (!response.ok) throw new Error(`Tokenworks identity service answered HTTP ${response.status}`)
    return readJson(response)
  }
}

class LoginExpired extends Error { constructor() { super('Tokenworks sign-in expired; sign in again') } }
class AccessDenied extends Error { constructor() { super('Tokenworks has not granted access to the USTC API') } }
class NetworkError extends Error {}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown> } catch {
    throw new Error('Tokenworks returned invalid JSON')
  }
}

// Direct HTTPS only: no global fetch/proxy agent, redirect following or helper tunnel.
function requestDirect(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), agent: false }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 4 * 1024 * 1024) request.destroy(new Error('Tokenworks response is too large'))
        else chunks.push(chunk)
      })
      response.once('error', () => reject(new NetworkError('Tokenworks connection interrupted')))
      response.once('end', () => {
        const status = response.statusCode ?? 502
        const body = [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks))
        resolve(new Response(body, { status }))
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('timeout')), 8_000)
    request.once('close', () => clearTimeout(timer))
    request.once('error', () => reject(new NetworkError('Tokenworks identity service connection failed')))
    request.end(init.body)
  })
}
