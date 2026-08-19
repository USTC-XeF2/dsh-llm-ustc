import { createDecipheriv, createHash } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { IWAN_CONFIG_REF } from './constants.ts'
import type { IwanConfig, IwanServer, PublicServer, TunnelCredential } from './types.ts'

export const IWAN_APP_SECRET = 'ca6a3532abd2986a03b86b3a'

export function parseIwanConfig(raw: string): IwanConfig {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new TypeError(`${IWAN_CONFIG_REF} is not valid JSON`, { cause: error })
  }
  return validateIwanConfig(value)
}

export function validateIwanConfig(value: unknown): IwanConfig {
  if (!isRecord(value) || typeof value.domain !== 'string' || value.domain.length === 0 || !Array.isArray(value.servers) || value.servers.length === 0) {
    throw new TypeError(`${IWAN_CONFIG_REF} does not contain a valid iWAN configuration`)
  }
  const servers = value.servers.map(validateServer)
  return { domain: value.domain, servers }
}

export function publicIwanServers(raw: string | undefined): PublicServer[] {
  if (raw === undefined) return []
  try {
    return parseIwanConfig(raw).servers.map(server => ({
      id: server.id,
      name: server.name,
      endpoint: `${server.host}:${server.port}`,
    }))
  } catch {
    return []
  }
}

export function selectedTunnel(raw: string | undefined, serverId: string | undefined): TunnelCredential | undefined {
  if (raw === undefined || serverId === undefined) return undefined
  const config = parseIwanConfig(raw)
  const server = config.servers.find(candidate => candidate.id === serverId)
  if (server === undefined) throw new TypeError(`selected iWAN line ${JSON.stringify(serverId)} is unavailable`)
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    password: decryptPassword(config.domain, server.username, server.passWord),
  }
}

export function decryptPassword(domain: string, username: string, encrypted: string): string {
  const packed = Buffer.from(encrypted, 'base64url')
  if (packed.length < 28) throw new TypeError('iWAN line credential is malformed')
  const nonce = packed.subarray(0, 12)
  const ciphertext = packed.subarray(12, -16)
  const tag = packed.subarray(-16)
  const key = createHash('sha256').update(`${IWAN_APP_SECRET}|${domain}|${username}`).digest()
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(`${domain}|${username}`))
    decipher.setAuthTag(tag)
    const password = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    if (password.length === 0) throw new TypeError('iWAN line credential is empty')
    return password
  } catch (error) {
    throw new TypeError('iWAN line credential could not be decrypted', { cause: error })
  }
}

function validateServer(value: unknown): IwanServer {
  if (!isRecord(value)
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.name !== 'string' || value.name.length === 0
    || typeof value.host !== 'string' || !isIPv4(value.host)
    || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535
    || typeof value.username !== 'string' || value.username.length === 0
    || typeof value.passWord !== 'string' || value.passWord.length === 0) {
    throw new TypeError(`${IWAN_CONFIG_REF} contains an invalid iWAN line`)
  }
  return {
    id: value.id,
    name: value.name,
    host: value.host,
    port: value.port as number,
    username: value.username,
    passWord: value.passWord,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
