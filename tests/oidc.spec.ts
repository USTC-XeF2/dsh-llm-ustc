import { createCipheriv, createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { decryptPassword, IWAN_APP_SECRET, selectedTunnel } from '../src/iwan.ts'
import { IwanAuthenticator, type IwanRequester } from '../src/oidc.ts'

describe('iWAN Host authentication', () => {
  it('uses PKCE and accepts a callback without an issuer', async () => {
    const calls: { url: URL; body: unknown; headers: Readonly<Record<string, string>> }[] = []
    const idToken = `header.${Buffer.from(JSON.stringify({ preferred_username: 'student' })).toString('base64url')}.signature`
    const requester: IwanRequester = vi.fn(async (url, body, headers) => {
      calls.push({ url, body: JSON.parse(body.toString('utf8')) as unknown, headers })
      if (url.pathname.endsWith('/access_token')) return { access_token: 'access-token', id_token: idToken }
      if (url.pathname === '/m/config') {
        return {
          serverlist: {
            serverlist: [{
              serverName: '202.38.64.106', serverPort: 6001, userName: 'student',
              name: 'Education', passWord: 'encrypted-password',
            }],
          },
        }
      }
      return {}
    })
    const authenticator = new IwanAuthenticator(requester)
    const begin = authenticator.begin()
    const authUrl = new URL(begin.authUrl)
    const state = authUrl.searchParams.get('state')

    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy()
    expect(state).toBeTruthy()

    const config = await authenticator.complete(`com.panabit.mobile://oauth2redirect?state=${state!}&code=one-time-code`)
    expect(config.servers[0]).toMatchObject({ host: '202.38.64.106', port: 6001, username: 'student' })
    expect(calls.map(call => call.url.hostname)).toEqual([
      'auth.ivpn.ustc.edu.cn',
      'crtl.ivpn.ustc.edu.cn',
      'crtl.ivpn.ustc.edu.cn',
      'crtl.ivpn.ustc.edu.cn',
    ])
    expect(calls[1]?.headers.authorization).toBe('Bearer access-token')
    await expect(authenticator.complete(`com.panabit.mobile://oauth2redirect?state=${state!}&code=replay`))
      .rejects.toThrow('already consumed')
  })

  it('rejects and consumes a callback with a different issuer', async () => {
    const requester: IwanRequester = vi.fn(async () => ({}))
    const authenticator = new IwanAuthenticator(requester)
    const state = new URL(authenticator.begin().authUrl).searchParams.get('state')!
    const wrong = `com.panabit.mobile://oauth2redirect?iss=https%3A%2F%2Fevil.example&state=${state}&code=code`
    const retry = `com.panabit.mobile://oauth2redirect?state=${state}&code=code`

    await expect(authenticator.complete(wrong)).rejects.toThrow('unexpected issuer')
    await expect(authenticator.complete(retry)).rejects.toThrow('already consumed')
    expect(requester).not.toHaveBeenCalled()
  })
})

describe('iWAN line credential projection', () => {
  it('decrypts the selected server before starting the native tunnel', () => {
    const domain = 'iwan.ustc'
    const username = 'student'
    const password = 'secret-password'
    const encrypted = encryptPassword(domain, username, password)
    const raw = JSON.stringify({
      domain,
      servers: [{ id: 'line-one', name: 'Line One', host: '202.38.64.106', port: 6001, username, passWord: encrypted }],
    })

    expect(decryptPassword(domain, username, encrypted)).toBe(password)
    expect(selectedTunnel(raw, 'line-one')).toEqual({
      host: '202.38.64.106', port: 6001, username, password,
    })
  })
})

function encryptPassword(domain: string, username: string, password: string): string {
  const nonce = Buffer.alloc(12, 7)
  const key = createHash('sha256').update(`${IWAN_APP_SECRET}|${domain}|${username}`).digest()
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`${domain}|${username}`))
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url')
}
