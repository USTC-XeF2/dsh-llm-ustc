import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { HELPER_PROTOCOL, IWAN_CONFIG_REF } from './constants.ts'
import type { ResolvedConfig } from './config.ts'
import { selectedTunnel } from './iwan.ts'
import { resolveHelperBinary } from './native.ts'

export interface HelperEndpoint {
  baseURL: string
  generation: number
  headers: Readonly<Record<string, string>>
}

export class HelperManager {
  private child: ChildProcessWithoutNullStreams | undefined
  private sessionToken: string | undefined
  private baseURL: string | undefined
  private starting: Promise<string> | undefined
  private lifecycle: Promise<void> = Promise.resolve()
  private closed = false
  private usingIwan = false
  private directRecovered: (() => Promise<void>) | undefined
  private config: ResolvedConfig
  private generation = 0

  constructor(private readonly ctx: Context, config: ResolvedConfig) {
    this.config = config
  }

  reconfigure(config: ResolvedConfig): void {
    if (this.config.selectedServerId === config.selectedServerId && this.config.directRecoverySeconds === config.directRecoverySeconds) return
    this.config = config
    this.lifecycle = this.lifecycle.then(() => this.stopNow())
  }

  stageSelectedServer(serverId: string): () => void {
    const previous = this.config
    this.config = { ...previous, selectedServerId: serverId }
    return () => { this.config = previous }
  }

  onDirectRecovered(handler: () => Promise<void>): void {
    this.directRecovered = handler
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
    return {
      baseURL: `${baseURL}/v1`,
      generation: this.generation,
      headers: { 'x-dsh-ustc-session': this.sessionToken! },
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
    this.usingIwan = false
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

  get route(): boolean {
    return this.usingIwan
  }

  async refreshRoute(): Promise<void> {
    if (this.config.selectedServerId === undefined) {
      await this.stop()
      return
    }
    await this.stop()
    const response = await this.fetch('/_route', {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
    })
    const usingIwan = await response.json() as unknown
    if (!response.ok) {
      const message = isRecord(usingIwan) && isRecord(usingIwan.error) && typeof usingIwan.error.message === 'string'
        ? usingIwan.error.message
        : `USTC helper request failed (HTTP ${response.status})`
      throw new Error(message)
    }
    this.usingIwan = usingIwan as boolean
  }

  private async start(): Promise<string> {
    const binary = await resolveHelperBinary()
    const sessionToken = randomBytes(32).toString('base64url')
    const credential = await this.ctx.credentials.resolve(credentialRef(IWAN_CONFIG_REF))
    const tunnel = selectedTunnel(credential?.value, this.config.selectedServerId)
    const env = { ...process.env }
    for (const name of Object.keys(env)) {
      if (['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].includes(name.toLowerCase())) delete env[name]
    }
    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
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
      ...(tunnel === undefined ? {} : { tunnel }),
      directRecoverySeconds: this.config.directRecoverySeconds,
    })}\n`)
    const lines = createInterface({ input: child.stdout })
    const handshake = await new Promise<{ protocol: string; port: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('USTC helper startup timed out')), 8_000)
      lines.once('line', line => {
        clearTimeout(timer)
        try { resolve(JSON.parse(line) as { protocol: string; port: number }) } catch (error) { reject(error) }
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
      let route: boolean | undefined
      try {
        const value = JSON.parse(line) as unknown
        route = isRecord(value) && value.event === 'route' && typeof value.iwan === 'boolean'
          ? value.iwan
          : undefined
      } catch { route = undefined }
      if (route === undefined) return
      const recovered = this.usingIwan && !route
      this.usingIwan = route
      if (!recovered || this.directRecovered === undefined) return
      void this.directRecovered().catch(error => {
        this.ctx.logger.warn('dsh-llm-ustc could not refresh models after direct recovery: %s', redact(String(error)))
      })
    })
    child.once('exit', () => {
      if (this.child === child) {
        this.child = undefined
        this.baseURL = undefined
        this.sessionToken = undefined
        this.usingIwan = false
      }
    })
    this.sessionToken = sessionToken
    this.baseURL = `http://127.0.0.1:${handshake.port}`
    this.generation += 1
    return this.baseURL
  }
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
