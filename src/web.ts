import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { API_KEY_REF, IWAN_CONFIG_REF, SETTINGS_NS, SETTINGS_ROUTE } from './constants.ts'
import type { Config } from './config.ts'
import type { HelperManager } from './helper.ts'
import type { ModelCatalog } from './model-catalog.ts'
import type { StateStore } from './state.ts'
import type { HelperStatus, IwanConfig, PublicServer } from './types.ts'

export interface SettingsSnapshot {
  writable: boolean
  revision: number
  selectedServerId?: string
  directReprobeSeconds: number
  apiKey: { configured: boolean; source?: string; writable: boolean }
  iwan: {
    configured: boolean
    source?: string
    writable: boolean
    servers: PublicServer[]
  }
  helper?: HelperStatus
  models: { id: string; name: string }[]
  modelsUpdatedAt?: string
}

type WebRequest =
  | { action: 'saveApiKey'; value: string }
  | { action: 'unsetApiKey' }
  | { action: 'beginOidc' }
  | { action: 'completeOidc'; callbackUrl: string }
  | { action: 'logoutIwan'; expectedRevision: number }
  | { action: 'refreshRoute' }
  | { action: 'selectServer'; serverId: string; expectedRevision: number }
  | { action: 'syncModels' }

export class UstcWebBackend {
  constructor(
    private readonly ctx: Context,
    private readonly helper: HelperManager,
    private readonly catalog: ModelCatalog,
    private readonly store: StateStore,
  ) {}

  async snapshot(): Promise<SettingsSnapshot> {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === SETTINGS_NS)
    if (descriptor === undefined) throw new Error('llm-ustc settings namespace is not registered')
    const value = descriptor.value as Config
    const [apiKey, iwan, iwanSecret, helper] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(API_KEY_REF)),
      this.ctx.credentials.describe(credentialRef(IWAN_CONFIG_REF)),
      this.ctx.credentials.resolve(credentialRef(IWAN_CONFIG_REF)),
      this.helper.statusIfRunning(),
    ])
    const state = this.store.snapshot()
    return {
      writable: this.ctx.settings.writable,
      revision: descriptor.revision,
      ...(value.selectedServerId === undefined ? {} : { selectedServerId: value.selectedServerId }),
      directReprobeSeconds: value.directReprobeSeconds ?? 300,
      apiKey: publicCredential(apiKey),
      iwan: {
        ...publicCredential(iwan),
        servers: publicIwanServers(iwanSecret?.value),
      },
      ...(helper === undefined ? {} : { helper }),
      models: state.models,
      ...(state.modelsUpdatedAt === undefined ? {} : { modelsUpdatedAt: state.modelsUpdatedAt }),
    }
  }

  async handle(request: WebRequest): Promise<unknown> {
    switch (request.action) {
      case 'saveApiKey': {
        const key = request.value.trim()
        if (key.length === 0) throw new TypeError('API Key may not be empty')
        await this.ctx.credentials.set(credentialRef(API_KEY_REF), key)
        await this.helper.stop()
        return this.snapshot()
      }
      case 'unsetApiKey':
        await this.ctx.credentials.unset(credentialRef(API_KEY_REF))
        await this.helper.stop()
        return this.snapshot()
      case 'beginOidc':
        return this.helper.beginOidc()
      case 'completeOidc': {
        const result = await this.helper.completeOidc(request.callbackUrl)
        return { servers: result.servers, snapshot: await this.snapshot() }
      }
      case 'logoutIwan':
        await this.ctx.settings.mutate(settingsNamespace(SETTINGS_NS), [{ op: 'unset', path: ['selectedServerId'] }], request.expectedRevision)
        await this.ctx.credentials.unset(credentialRef(IWAN_CONFIG_REF))
        await this.helper.stop()
        await this.helper.status()
        return this.snapshot()
      case 'refreshRoute': {
        const key = await this.ctx.credentials.resolve(credentialRef(API_KEY_REF))
        await this.helper.refreshRoute(key?.value.trim())
        return this.snapshot()
      }
      case 'selectServer': {
        const key = await this.ctx.credentials.resolve(credentialRef(API_KEY_REF))
        const rollback = this.helper.stageSelectedServer(request.serverId)
        try {
          await this.ctx.settings.update(settingsNamespace(SETTINGS_NS), { selectedServerId: request.serverId }, request.expectedRevision)
        } catch (error) {
          rollback()
          throw error
        }
        await this.helper.selectServer(request.serverId, key?.value.trim())
        return this.snapshot()
      }
      case 'syncModels':
        await this.catalog.refresh()
        return this.snapshot()
    }
  }
}

export function installWeb(ctx: Context, backend: UstcWebBackend): void {
  ctx.inject(['webServer'], webCtx => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') return responseJson(res, 200, { ok: true, value: await backend.snapshot() })
          if (req.method !== 'POST') return responseError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET or POST')
          if (!sameOriginPost(req)) return responseError(res, 403, 'CROSS_ORIGIN', 'cross-origin request refused')
          const request = parseWebRequest(await readJson(req))
          responseJson(res, 200, { ok: true, value: await backend.handle(request) })
        } catch (error) {
          const status = error instanceof SettingsConflictError ? 409 : error instanceof TypeError ? 400 : 500
          responseError(res, status, error instanceof SettingsConflictError ? 'SETTINGS_CONFLICT' : 'REQUEST_FAILED', publicMessage(error))
        }
      },
    })
    webCtx.effect(() => dispose, 'dsh-llm-ustc: web settings route')
  })
}

function publicCredential(info: { configured: boolean; source?: string; writable: boolean }): { configured: boolean; source?: string; writable: boolean } {
  return { configured: info.configured, ...(info.source === undefined ? {} : { source: info.source }), writable: info.writable }
}

export function publicIwanServers(raw: string | undefined): PublicServer[] {
  if (raw === undefined) return []
  try {
    const value = JSON.parse(raw) as IwanConfig
    if (!Array.isArray(value.servers)) return []
    return value.servers.flatMap(server => {
      if (typeof server.id !== 'string' || typeof server.name !== 'string' || typeof server.host !== 'string' || !Number.isSafeInteger(server.port)) return []
      return [{ id: server.id, name: server.name, endpoint: `${server.host}:${server.port}` }]
    })
  } catch {
    return []
  }
}

function responseJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(bytes.length))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

function responseError(res: ServerResponse, status: number, code: string, message: string): void {
  responseJson(res, status, { ok: false, error: { code, message } })
}

function sameOriginPost(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return ['same-origin', 'same-site', 'none'].includes(req.headers['sec-fetch-site'] ?? '')
  if (req.headers.host === undefined) return false
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.headers.host
  } catch { return false }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const parts: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += bytes.length
    if (size > 64 * 1024) throw new TypeError('request body exceeds 65536 bytes')
    parts.push(bytes)
  }
  if (parts.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
}

function parseWebRequest(value: unknown): WebRequest {
  if (!isRecord(value) || typeof value.action !== 'string') throw new TypeError('request action is required')
  switch (value.action) {
    case 'saveApiKey':
      if (typeof value.value !== 'string') throw new TypeError('API Key must be a string')
      return { action: value.action, value: value.value }
    case 'completeOidc':
      if (typeof value.callbackUrl !== 'string') throw new TypeError('callbackUrl must be a string')
      return { action: value.action, callbackUrl: value.callbackUrl }
    case 'selectServer':
      if (typeof value.serverId !== 'string' || !Number.isSafeInteger(value.expectedRevision)) throw new TypeError('serverId and expectedRevision are required')
      return { action: value.action, serverId: value.serverId, expectedRevision: value.expectedRevision as number }
    case 'logoutIwan':
      if (!Number.isSafeInteger(value.expectedRevision)) throw new TypeError('expectedRevision is required')
      return { action: value.action, expectedRevision: value.expectedRevision as number }
    case 'unsetApiKey': case 'beginOidc': case 'refreshRoute': case 'syncModels':
      return { action: value.action }
    default:
      throw new TypeError(`unsupported action: ${value.action}`)
  }
}

export function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/com\.panabit\.mobile:\/\/\S+/giu, 'com.panabit.mobile://[redacted]')
    .replace(/\b(?:sk-)?[A-Za-z0-9_-]{32,}\b/gu, '[redacted]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
