import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { API_KEY_REF, IWAN_CONFIG_REF, SETTINGS_NS, SETTINGS_ROUTE } from './constants.ts'
import type { Config } from './config.ts'
import { resolveConfig } from './config.ts'
import type { HelperManager } from './helper.ts'
import { parseIwanConfig, publicIwanServers } from './iwan.ts'
import type { ModelCatalog } from './model-catalog.ts'
import { IwanAuthenticator } from './oidc.ts'
import type { StateStore } from './state.ts'
import type { PublicServer } from './types.ts'

export interface SettingsSnapshot {
  writable: boolean
  revision: number
  selectedServerId?: string
  apiKey: { configured: boolean; source?: string; writable: boolean }
  iwan: {
    configured: boolean
    source?: string
    writable: boolean
    servers: PublicServer[]
  }
  usingIwan: boolean
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
    private readonly iwanAuth: IwanAuthenticator = new IwanAuthenticator(),
    private readonly settingsId = SETTINGS_NS,
    private readonly config?: Config,
  ) {}

  async snapshot(): Promise<SettingsSnapshot> {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === this.settingsId)
    if (descriptor === undefined) throw new Error('llm-ustc settings namespace is not registered')
    const value = descriptor.value as { selectedServerId?: string }
    const [apiKey, iwan, iwanSecret] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(API_KEY_REF)),
      this.ctx.credentials.describe(credentialRef(IWAN_CONFIG_REF)),
      this.ctx.credentials.resolve(credentialRef(IWAN_CONFIG_REF)),
    ])
    const state = this.store.snapshot()
    return {
      writable: this.ctx.settings.writable,
      revision: descriptor.revision,
      ...(value.selectedServerId === undefined ? {} : { selectedServerId: value.selectedServerId }),
      apiKey: publicCredential(apiKey),
      iwan: {
        ...publicCredential(iwan),
        servers: publicIwanServers(iwanSecret?.value),
      },
      usingIwan: this.helper.route,
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
        return this.iwanAuth.begin()
      case 'completeOidc': {
        const config = await this.iwanAuth.complete(request.callbackUrl)
        await this.ctx.credentials.set(credentialRef(IWAN_CONFIG_REF), JSON.stringify(config))
        await this.helper.stop()
        return { servers: publicIwanServers(JSON.stringify(config)), snapshot: await this.snapshot() }
      }
      case 'logoutIwan':
        await this.ctx.settings.mutate(this.settingsId, [{ op: 'unset', path: ['selectedServerId'] }], request.expectedRevision)
        await this.ctx.credentials.unset(credentialRef(IWAN_CONFIG_REF))
        if (this.config !== undefined) this.helper.reconfigure(resolveConfig(this.config))
        await this.helper.stop()
        return this.snapshot()
      case 'refreshRoute': {
        await this.helper.refreshRoute()
        return this.snapshot()
      }
      case 'selectServer': {
        const iwan = await this.ctx.credentials.resolve(credentialRef(IWAN_CONFIG_REF))
        if (iwan === undefined || !parseIwanConfig(iwan.value).servers.some(server => server.id === request.serverId)) {
          throw new TypeError('selected iWAN line is unavailable')
        }
        const rollback = this.helper.stageSelectedServer(request.serverId)
        try {
          await this.ctx.settings.update(this.settingsId, { selectedServerId: request.serverId }, request.expectedRevision)
        } catch (error) {
          rollback()
          throw error
        }
        if (this.config !== undefined) this.helper.reconfigure(resolveConfig(this.config))
        await this.helper.refreshRoute()
        return this.snapshot()
      }
      case 'syncModels':
        await this.catalog.refresh()
        return this.snapshot()
    }
  }
}

export function installWeb(ctx: Context, backend: UstcWebBackend): void {
  ctx.inject(['connection'], connectionCtx => {
    connectionCtx.connection.fetch.register({
      path: SETTINGS_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async request => {
        try {
          if (request.method === 'GET') return responseJson(200, { ok: true, value: await backend.snapshot() })
          const input = parseWebRequest(await readJson(request))
          return responseJson(200, { ok: true, value: await backend.handle(input) })
        } catch (error) {
          const status = error instanceof SettingsConflictError ? 409 : error instanceof TypeError ? 400 : 500
          return responseError(status, error instanceof SettingsConflictError ? 'SETTINGS_CONFLICT' : 'REQUEST_FAILED', publicMessage(error))
        }
      },
    })
  })
}

function publicCredential(info: { configured: boolean; source?: string; writable: boolean }): { configured: boolean; source?: string; writable: boolean } {
  return { configured: info.configured, ...(info.source === undefined ? {} : { source: info.source }), writable: info.writable }
}

function responseJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  } })
}

function responseError(status: number, code: string, message: string): Response {
  return responseJson(status, { ok: false, error: { code, message } })
}

async function readJson(req: Request): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const reader = req.body?.getReader()
  if (reader === undefined) throw new TypeError('request body is empty')
  const parts: Buffer[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const bytes = Buffer.from(value)
    size += bytes.length
    if (size > 64 * 1024) {
      await reader.cancel()
      throw new TypeError('request body exceeds 65536 bytes')
    }
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
