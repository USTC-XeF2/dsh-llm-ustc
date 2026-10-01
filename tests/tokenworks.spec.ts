import type { Context } from '@deepseek-ai/cordis'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOKENWORKS_SESSION_REF } from '../src/constants.ts'
import { TokenworksAuth, type TokenworksRequester } from '../src/tokenworks.ts'

const issuer = 'https://id.ustc.edu.cn/doc/oidc'
const root = 'https://id.ustc.edu.cn/doc/claude/tokenworks-content'
const bootstrapUrl = 'https://id.ustc.edu.cn/doc/claude/bootstrap'
const publisher = generateKeyPairSync('ed25519')
const signer = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publisherKey = publisher.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const jwk = { ...signer.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

function idToken(nonce?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: 'tokenworks', sub: 'account-1', name: 'Test User',
    iat: Math.floor(Date.now() / 1_000), exp: Math.floor(Date.now() / 1_000) + 3_600,
    ...(nonce === undefined ? {} : { nonce }),
  })).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signer.privateKey).toString('base64url')}`
}

function fixture() {
  const credentials = new Map<string, string>()
  const set = vi.fn(async (ref: string, value: string) => { credentials.set(ref, value) })
  const ctx = { credentials: {
    describe: async (ref: string) => ({ configured: credentials.has(ref), writable: true }),
    resolve: async (ref: string) => credentials.has(ref) ? { value: credentials.get(ref)! } : undefined,
    set,
    unset: async (ref: string) => { credentials.delete(ref) },
  } } as unknown as Context
  const bundle = Buffer.from(JSON.stringify({ configuration: { organizations: [{
    id: 'ustc', oidc: { issuer, clientId: 'tokenworks', scopes: ['openid', 'profile', 'offline_access'] },
  }] } }))
  const manifest = Buffer.from(JSON.stringify({
    publisher: 'ustc-tokenworks', channel: 'stable',
    bundle: { url: `${root}/bundles/test.json`, bytes: bundle.length, sha256: createHash('sha256').update(bundle).digest('hex') },
  }))
  const envelope = { payload: manifest.toString('base64url'), signature: sign(null, manifest, publisher.privateKey).toString('base64url') }
  let nonce: string | undefined
  let bootstrap = () => json({
    inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://api.llm.ustc.edu.cn/v1',
    inferenceGatewayApiKey: 'gateway-secret', configRecheckIntervalMinutes: 2,
    expiresAt: Date.now() / 1_000 + 600,
  })
  let tokens = async () => json({
    access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer',
    expires_in: 3_600, id_token: idToken(nonce),
  })
  const request = vi.fn<TokenworksRequester>(async (url) => {
    if (url === `${root}/stable/latest.json`) return json(envelope)
    if (url === `${root}/bundles/test.json`) return new Response(bundle.toString('utf8'))
    if (url.endsWith('/.well-known/openid-configuration')) return json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`, code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    })
    if (url === `${issuer}/jwks`) return json({ keys: [jwk] })
    if (url === `${issuer}/token`) return tokens()
    if (url === bootstrapUrl) return bootstrap()
    throw new Error(`Unexpected request: ${url}`)
  })
  const auth = new TokenworksAuth(ctx, request, publisherKey)
  const start = async () => {
    const { authUrl } = await auth.begin()
    const url = new URL(authUrl)
    nonce = url.searchParams.get('nonce')!
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, iss: issuer, code: 'test-code' }).toString()
    return { url, callback }
  }
  const savedSession = (expiresAt = Date.now() + 3_600_000) => {
    credentials.set(TOKENWORKS_SESSION_REF, JSON.stringify({
      accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt,
      clientId: 'tokenworks', subject: 'account-1', name: 'Test User',
    }))
  }
  return { auth, credentials, set, request, envelope, start, savedSession,
    setBootstrap: (handler: typeof bootstrap) => { bootstrap = handler },
    setTokens: (handler: typeof tokens) => { tokens = handler },
  }
}

const active: TokenworksAuth[] = []
afterEach(() => { for (const auth of active.splice(0)) auth.dispose(); vi.restoreAllMocks() })
function setup() { const value = fixture(); active.push(value.auth); return value }

describe('Tokenworks authentication', () => {
  it('verifies signed configuration, completes loopback PKCE, and exposes no credentials to the browser', async () => {
    const { auth, start, credentials, request } = setup()
    const { url, callback } = await start()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const wrongState = new URL(callback)
    wrongState.searchParams.set('state', 'incorrect')
    expect((await fetch(wrongState)).status).toBe(400)
    expect((await auth.snapshot()).pending).toBe(true)
    expect((await fetch(callback)).status).toBe(200)
    const exchange = request.mock.calls.find(([endpoint]) => endpoint.endsWith('/token'))!
    const body = new URLSearchParams(exchange[1]!.body as string)
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(body.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'))
    expect(await auth.apiKey()).toBe('gateway-secret')
    expect(await auth.apiKey()).toBe('gateway-secret')
    expect(request.mock.calls.filter(([endpoint]) => endpoint === bootstrapUrl)).toHaveLength(1)
    expect(JSON.parse(credentials.get(TOKENWORKS_SESSION_REF)!)).toMatchObject({ refreshToken: 'refresh-secret' })
    expect(await auth.snapshot()).toEqual({ configured: true, writable: true, pending: false, name: 'Test User' })
    expect(JSON.stringify(await auth.snapshot())).not.toMatch(/gateway-secret|access-secret|refresh-secret/)
    await auth.logout()
    expect(credentials.has(TOKENWORKS_SESSION_REF)).toBe(false)
    await expect(auth.apiKey()).rejects.toThrow('Sign in to Tokenworks first')
  })

  it('rejects modified publisher content before opening a login callback', async () => {
    const { auth, envelope } = setup()
    envelope.payload = Buffer.from('{"publisher":"another"}').toString('base64url')
    await expect(auth.begin()).rejects.toThrow('signature')
    expect((await auth.snapshot()).pending).toBe(false)
  })

  it.each(['issuer', 'nonce', 'gateway'])('rejects a mismatched %s without saving the login session', async mismatch => {
    const { auth, start, credentials, setTokens, setBootstrap } = setup()
    const { callback } = await start()
    if (mismatch === 'issuer') callback.searchParams.delete('iss')
    if (mismatch === 'nonce') setTokens(async () => json({ access_token: 'secret', token_type: 'Bearer', expires_in: 3_600, id_token: idToken('wrong-nonce') }))
    if (mismatch === 'gateway') setBootstrap(() => json({ inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://other.example', inferenceGatewayApiKey: 'secret' }))
    expect((await fetch(callback)).status).toBe(400)
    expect(credentials.size).toBe(0)
    expect(await auth.snapshot()).toMatchObject({ configured: false, pending: false, error: expect.any(String) })
  })

  it('consumes a callback only once even while the token exchange is in flight', async () => {
    const { start, setTokens, credentials } = setup()
    let release!: () => void
    let entered!: () => void
    const entry = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const { callback, url } = await start()
    setTokens(async () => {
      entered()
      await blocked
      return json({ access_token: 'secret', token_type: 'Bearer', expires_in: 3_600, id_token: idToken(url.searchParams.get('nonce')!) })
    })
    const first = fetch(callback)
    await entry
    expect((await fetch(callback)).status).toBe(400)
    release()
    expect((await first).status).toBe(200)
    expect(credentials.size).toBe(1)
  })

  it('refreshes an expired persisted session once for concurrent key requests', async () => {
    const { auth, savedSession, request, credentials } = setup()
    savedSession(Date.now() - 1)
    expect(await Promise.all([auth.apiKey(), auth.apiKey()])).toEqual(['gateway-secret', 'gateway-secret'])
    const calls = request.mock.calls.filter(([endpoint]) => endpoint.endsWith('/token'))
    expect(calls).toHaveLength(1)
    const body = new URLSearchParams(calls[0]![1]!.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-refresh')
    expect(JSON.parse(credentials.get(TOKENWORKS_SESSION_REF)!)).toMatchObject({ accessToken: 'access-secret', refreshToken: 'refresh-secret' })
  })

  it.each([401, 403])('does not reuse a key after bootstrap rejects access with HTTP %s', async status => {
    const { auth, savedSession, setBootstrap } = setup()
    savedSession()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(await auth.apiKey()).toBe('gateway-secret')
    clock.mockReturnValue(now + 121_000)
    setBootstrap(() => json({}, status))
    await expect(auth.apiKey()).rejects.toThrow(status === 401 ? 'expired' : 'not granted')
    expect((await auth.snapshot()).configured).toBe(status !== 401)
    await expect(auth.apiKey()).rejects.toThrow()
  })

  it('retains a still-valid key during a service outage, but never beyond its expiry', async () => {
    const { auth, savedSession, setBootstrap } = setup()
    savedSession()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(await auth.apiKey()).toBe('gateway-secret')
    setBootstrap(() => json({}, 503))
    clock.mockReturnValue(now + 121_000)
    expect(await auth.apiKey()).toBe('gateway-secret')
    clock.mockReturnValue(now + 601_000)
    await expect(auth.apiKey()).rejects.toThrow('temporarily unavailable')
  })

  it('cannot restore a session when signing out during token refresh', async () => {
    const { auth, savedSession, setTokens, credentials, set } = setup()
    savedSession(Date.now() - 1)
    let release!: () => void
    let entered!: () => void
    const entry = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    setTokens(async () => {
      entered()
      await blocked
      return json({ access_token: 'new-secret', token_type: 'Bearer', expires_in: 3_600 })
    })
    const fetching = auth.apiKey()
    const failure = expect(fetching).rejects.toThrow('sign-in changed')
    await entry
    await auth.logout()
    release()
    await failure
    expect(credentials.size).toBe(0)
    expect(set).not.toHaveBeenCalled()
  })
})
