import { createHash, createHmac, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { IWAN_APP_SECRET, validateIwanConfig } from './iwan.ts'
import type { IwanConfig } from './types.ts'

const AUTH_URL = 'https://auth.ivpn.ustc.edu.cn/login/oauth/authorize'
const ISSUER = 'https://auth.ivpn.ustc.edu.cn'
const TOKEN_URL = 'https://auth.ivpn.ustc.edu.cn/api/login/oauth/access_token'
const CONTROLLER = 'https://crtl.ivpn.ustc.edu.cn'
const CLIENT_ID = 'afc6479ffb531d71daef'
const REDIRECT = 'com.panabit.mobile://oauth2redirect'
const SCOPE = 'openid profile email offline_access'
const DOMAIN = 'iwan.ustc'
const APP_ID = 'controller-ustc'
const TRANSACTION_TTL_MS = 10 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 1024 * 1024

interface Transaction {
  verifier: string
  expiresAt: number
}

export interface OidcBegin {
  authUrl: string
  expiresInSeconds: number
}

export type IwanRequester = (
  url: URL,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
) => Promise<unknown>

export class IwanAuthenticator {
  private readonly pending = new Map<string, Transaction>()

  constructor(private readonly requester: IwanRequester = requestJson) {}

  begin(): OidcBegin {
    const verifier = randomBytes(64).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + TRANSACTION_TTL_MS
    for (const [key, transaction] of this.pending) {
      if (transaction.expiresAt <= Date.now()) this.pending.delete(key)
    }
    this.pending.set(state, { verifier, expiresAt })
    const url = new URL(AUTH_URL)
    url.searchParams.set('client_id', CLIENT_ID)
    url.searchParams.set('redirect_uri', REDIRECT)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPE)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    return { authUrl: url.toString(), expiresInSeconds: TRANSACTION_TTL_MS / 1_000 }
  }

  async complete(callbackUrl: string): Promise<IwanConfig> {
    const { code, verifier } = this.takeTransaction(callbackUrl)
    const tokenBody = Buffer.from(JSON.stringify({
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }))
    const token = await this.requester(new URL(TOKEN_URL), tokenBody, { 'content-type': 'application/json' })
    if (!isRecord(token) || typeof token.access_token !== 'string' || token.access_token.length === 0) {
      throw new Error('OIDC response has no access token')
    }
    const username = typeof token.id_token === 'string' ? usernameFromIdToken(token.id_token) : undefined
    return this.fetchServers(token.access_token, username ?? 'unknown')
  }

  private takeTransaction(callbackUrl: string): { code: string; verifier: string } {
    let url: URL
    try { url = new URL(callbackUrl) } catch (error) {
      throw new TypeError('invalid callback URL', { cause: error })
    }
    if (url.protocol !== 'com.panabit.mobile:' || url.hostname !== 'oauth2redirect') {
      throw new TypeError('callback URL has an unexpected scheme or target')
    }
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (state === null || state.length === 0) throw new TypeError('callback URL has no state')
    if (code === null || code.length === 0) throw new TypeError('callback URL has no authorization code')
    const transaction = this.pending.get(state)
    this.pending.delete(state)
    if (transaction === undefined) throw new TypeError('OIDC transaction is missing or already consumed')
    if (transaction.expiresAt <= Date.now()) throw new TypeError('OIDC transaction expired')
    const issuer = url.searchParams.get('iss')
    if (issuer !== null && issuer.replace(/\/+$/u, '') !== ISSUER) {
      throw new TypeError('callback URL has an unexpected issuer')
    }
    return { code, verifier: transaction.verifier }
  }

  private async fetchServers(accessToken: string, username: string): Promise<IwanConfig> {
    const body: Record<string, unknown> = {
      domain: DOMAIN,
      type: 'android',
      oem_name: 'panabit',
      device_id: randomBytes(8).toString('hex'),
      userName: username,
      serverlist_version: '0',
      ipfilter_version: '0',
      branding_version: '0',
    }
    await this.controllerPost('/m/auth', body, accessToken)
    await this.controllerPost('/m/keepalive', { ...body, type: 'keepalive' }, accessToken)
    const response = await this.controllerPost('/m/config', body, accessToken)
    const serverList = readServerList(response)
    return validateIwanConfig({
      domain: DOMAIN,
      servers: serverList.map((server, index) => {
        const host = requiredString(server, 'serverName')
        const port = typeof server.serverPort === 'number' ? server.serverPort : 6001
        const lineUsername = requiredString(server, 'userName')
        return {
          id: `line-${createHash('sha256').update(`${index}\0${host}\0${port}\0${lineUsername}`).digest('hex').slice(0, 16)}`,
          name: requiredString(server, 'name'),
          host,
          port,
          username: lineUsername,
          passWord: requiredString(server, 'passWord'),
        }
      }),
    })
  }

  private controllerPost(path: string, body: Record<string, unknown>, accessToken: string): Promise<unknown> {
    const timestamp = Math.floor(Date.now() / 1_000).toString()
    const nonce = randomBytes(16).toString('hex').toUpperCase()
    const bytes = Buffer.from(JSON.stringify(body))
    const bodyHash = createHash('sha256').update(bytes).digest('hex')
    const canonical = `POST\n${path}\n\n${bodyHash}\n${timestamp}\n${nonce}`
    const signature = createHmac('sha256', IWAN_APP_SECRET).update(canonical).digest('hex')
    return this.requester(new URL(path, CONTROLLER), bytes, {
      authorization: `Bearer ${accessToken}`,
      'x-auth-appid': APP_ID,
      'x-auth-timestamp': timestamp,
      'x-auth-nonce': nonce,
      'x-auth-sign': signature,
      'content-type': 'application/json',
    })
  }

}

function requestJson(url: URL, body: Buffer, headers: Readonly<Record<string, string>>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST',
      agent: false,
      headers: { ...headers, 'content-length': String(body.length), accept: 'application/json' },
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('iWAN control response is too large'))
          return
        }
        chunks.push(bytes)
      })
      response.once('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`${url.hostname} answered HTTP ${status}`))
          return
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch (error) {
          reject(new Error(`${url.hostname} returned invalid JSON`, { cause: error }))
        }
      })
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`${url.hostname} connection timed out`)))
    request.once('error', reject)
    request.end(body)
  })
}

function readServerList(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !isRecord(value.serverlist) || !Array.isArray(value.serverlist.serverlist)) {
    throw new Error('controller response has no server list')
  }
  return value.serverlist.serverlist.map(server => {
    if (!isRecord(server)) throw new Error('controller response contains an invalid server')
    return server
  })
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== 'string' || result.length === 0) throw new Error(`server has no ${key}`)
  return result
}

function usernameFromIdToken(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (!isRecord(value)) return undefined
    for (const key of ['name', 'preferred_username', 'sub']) {
      if (typeof value[key] === 'string') return value[key]
    }
  } catch {}
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
