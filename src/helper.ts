import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { HELPER_PROTOCOL, IWAN_CONFIG_REF } from './constants.ts'
import type { ResolvedConfig } from './config.ts'
import { resolveHelperBinary } from './native.ts'
import type { CachedModel, HelperStatus, IwanConfig, PublicServer } from './types.ts'

interface Handshake {
  protocol: string
  port: number
  pid: number
}

export interface HelperEndpoint {
  baseURL: string
  generation: number
  headers: Readonly<Record<string, string>>
}

export interface OidcBegin {
  authUrl: string
  expiresInSeconds: number
}

export interface OidcComplete {
  servers: PublicServer[]
  iwanConfig: IwanConfig
}

export class HelperManager {
  private child: ChildProcessWithoutNullStreams | undefined
  private sessionToken: string | undefined
  private baseURL: string | undefined
  private starting: Promise<string> | undefined
  private lifecycle: Promise<void> = Promise.resolve()
  private closed = false
  private recoveredModels: ((models: CachedModel[]) => Promise<void>) | undefined
  private config: ResolvedConfig
  private generation = 0

  constructor(private readonly ctx: Context, config: ResolvedConfig) {
    this.config = config
  }

  reconfigure(config: ResolvedConfig): void {
    if (sameConfig(this.config, config)) return
    this.config = config
    this.lifecycle = this.lifecycle.then(() => this.stopNow())
  }

  stageSelectedServer(serverId: string): () => void {
    const previous = this.config
    this.config = { ...previous, selectedServerId: serverId }
    return () => { this.config = previous }
  }

  onRecoveredModels(handler: (models: CachedModel[]) => Promise<void>): void {
    this.recoveredModels = handler
  }

  async ensureStarted(): Promise<string> {
    if (this.closed) throw new Error('USTC helper manager is disposed')
    await this.lifecycle
    if (this.baseURL !== undefined && this.child?.exitCode === null) return this.baseURL
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  async endpoint(): Promise<HelperEndpoint> {
    const baseURL = await this.ensureStarted()
    const sessionToken = this.sessionToken
    if (sessionToken === undefined) throw new Error('USTC helper started without a session token')
    return {
      baseURL: `${baseURL}/v1`,
      generation: this.generation,
      headers: { 'x-dsh-ustc-session': sessionToken },
    }
  }

  async stop(): Promise<void> {
    this.lifecycle = this.lifecycle.then(() => this.stopNow())
    await this.lifecycle
  }

  private async stopNow(): Promise<void> {
    if (this.starting !== undefined) {
      try { await this.starting } catch {}
    }
    const child = this.child
    this.child = undefined
    this.baseURL = undefined
    this.sessionToken = undefined
    if (child === undefined || child.exitCode !== null) return
    child.stdin.end()
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()) })
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1_000))])
    if (child.exitCode === null) child.kill()
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await this.fetch(path, {
      ...init,
      signal: init.signal == null ? timeout : AbortSignal.any([init.signal, timeout]),
    })
    const text = await response.text()
    let value: unknown
    try { value = JSON.parse(text) } catch { value = undefined }
    if (!response.ok) {
      const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
        ? value.error.message
        : `USTC helper request failed (HTTP ${response.status})`
      throw new Error(message)
    }
    return value as T
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('helper request path must be absolute')
    const baseURL = await this.ensureStarted()
    const headers = new Headers(init.headers)
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
    headers.set('x-dsh-ustc-session', this.sessionToken!)
    return fetch(`${baseURL}${path}`, {
      ...init,
      headers,
    })
  }

  status(): Promise<HelperStatus> {
    return this.request('/_control/status')
  }

  async refreshRoute(apiKey?: string): Promise<HelperStatus> {
    const status = await this.status()
    if (!status.iwanConfigured || status.selectedServerId === undefined) return status
    await this.selectServer(status.selectedServerId, apiKey)
    return this.status()
  }

  async statusIfRunning(): Promise<HelperStatus | undefined> {
    const baseURL = this.baseURL
    const sessionToken = this.sessionToken
    if (baseURL === undefined || sessionToken === undefined || this.child?.exitCode !== null) return undefined
    try {
      const response = await fetch(`${baseURL}/_control/status`, {
        headers: { accept: 'application/json', 'x-dsh-ustc-session': sessionToken },
        signal: AbortSignal.timeout(1_000),
      })
      return response.ok ? await response.json() as HelperStatus : undefined
    } catch {
      return undefined
    }
  }

  servers(): Promise<PublicServer[]> {
    return this.request('/_control/servers')
  }

  beginOidc(): Promise<OidcBegin> {
    return this.request('/_control/oidc/begin', { method: 'POST' })
  }

  async completeOidc(callbackUrl: string): Promise<OidcComplete> {
    const result = await this.request<OidcComplete>('/_control/oidc/complete', {
      method: 'POST',
      body: JSON.stringify({ callbackUrl }),
    })
    await this.ctx.credentials.set(credentialRef(IWAN_CONFIG_REF), JSON.stringify(result.iwanConfig))
    return result
  }

  async selectServer(serverId: string, apiKey?: string): Promise<void> {
    await this.request('/_control/select', {
      method: 'POST',
      body: JSON.stringify({ serverId }),
      ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }),
    }, 20_000)
  }

  private async start(): Promise<string> {
    const binary = await resolveHelperBinary()
    const sessionToken = randomBytes(32).toString('base64url')
    const credential = await this.ctx.credentials.resolve(credentialRef(IWAN_CONFIG_REF))
    const iwanConfig = credential === undefined ? undefined : parseIwanConfig(credential.value)
    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: sanitizedEnvironment(process.env),
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    let stderr = ''
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192)
      const message = redact(chunk.trim())
      if (message.length === 0) return
      if (message.includes('USTC upstream transport error') || message.includes('iWAN data path stopped')) {
        this.ctx.logger.warn('dsh-llm-ustc helper: %s', message)
      } else {
        this.ctx.logger.debug('dsh-llm-ustc helper: %s', message)
      }
    })
    child.stdin.write(`${JSON.stringify({
      sessionToken,
      ...(iwanConfig === undefined ? {} : { iwanConfig }),
      ...this.config.selectedServerId === undefined ? {} : { selectedServerId: this.config.selectedServerId },
      directReprobeSeconds: this.config.directReprobeSeconds,
    })}\n`)
    const lines = createInterface({ input: child.stdout })
    const handshake = await new Promise<Handshake>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('USTC helper startup timed out')), 8_000)
      lines.once('line', line => {
        clearTimeout(timer)
        try { resolve(parseHandshake(line)) } catch (error) { reject(error) }
      })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`USTC helper exited during startup (${code ?? 'signal'}): ${redact(stderr)}`))
      })
    })
    if (handshake.protocol !== HELPER_PROTOCOL) {
      child.kill()
      throw new Error(`USTC helper protocol ${handshake.protocol} is incompatible with ${HELPER_PROTOCOL}`)
    }
    lines.on('line', line => {
      if (this.child !== child) return
      const models = parseHelperEvent(line)
      if (models === undefined || this.recoveredModels === undefined) return
      void this.recoveredModels(models).catch(error => {
        this.ctx.logger.warn('dsh-llm-ustc could not persist recovered models: %s', redact(String(error)))
      })
    })
    child.once('exit', () => {
      if (this.child === child) {
        this.child = undefined
        this.baseURL = undefined
        this.sessionToken = undefined
      }
    })
    this.sessionToken = sessionToken
    this.baseURL = `http://127.0.0.1:${handshake.port}`
    this.generation += 1
    return this.baseURL
  }
}

export function parseHelperEvent(line: string): CachedModel[] | undefined {
  try {
    const value = JSON.parse(line) as unknown
    if (!isRecord(value) || value.event !== 'models' || !Array.isArray(value.models)) return undefined
    const models = value.models.flatMap(model => {
      if (!isRecord(model) || typeof model.id !== 'string' || typeof model.name !== 'string') return []
      return [{ id: model.id, name: model.name }]
    })
    return models.length === 0 ? undefined : models
  } catch {
    return undefined
  }
}

function parseHandshake(line: string): Handshake {
  const value = JSON.parse(line) as unknown
  if (!isRecord(value) || typeof value.protocol !== 'string' || !Number.isSafeInteger(value.port) || typeof value.pid !== 'number') {
    throw new TypeError('USTC helper returned an invalid startup handshake')
  }
  const port = value.port as number
  if (port < 1 || port > 65_535) throw new TypeError('USTC helper returned an invalid port')
  return { protocol: value.protocol, port, pid: value.pid }
}

export function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...source }
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === 'http_proxy' || name.toLowerCase() === 'https_proxy' || name.toLowerCase() === 'all_proxy' || name.toLowerCase() === 'no_proxy') {
      delete result[name]
    }
  }
  return result
}

function parseIwanConfig(raw: string): IwanConfig {
  const value = JSON.parse(raw) as unknown
  if (!isRecord(value) || typeof value.domain !== 'string' || !Array.isArray(value.servers) || value.servers.length === 0) {
    throw new TypeError(`${IWAN_CONFIG_REF} does not contain a valid iWAN configuration`)
  }
  return value as unknown as IwanConfig
}

function sameConfig(left: ResolvedConfig, right: ResolvedConfig): boolean {
  return left.selectedServerId === right.selectedServerId && left.directReprobeSeconds === right.directReprobeSeconds
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [redacted]')
    .replace(/com\.panabit\.mobile:\/\/[^\s]+/giu, 'com.panabit.mobile://[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/gu, match => `${match.slice(0, 6)}...[redacted]`)
}

export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}
