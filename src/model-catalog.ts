import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { API_KEY_REF } from './constants.ts'
import type { HelperManager } from './helper.ts'
import { normalizeModels, StateStore } from './state.ts'
import type { CachedModel } from './types.ts'

export class ModelCatalog {
  constructor(
    private readonly ctx: Context,
    private readonly helper: HelperManager,
    private readonly store: StateStore,
  ) {
    this.helper.onRecoveredModels(async models => { await this.accept(models) })
  }

  models(): CachedModel[] {
    return this.store.models()
  }

  async refresh(signal?: AbortSignal): Promise<CachedModel[]> {
    const credential = await this.ctx.credentials.resolve(credentialRef(API_KEY_REF))
    if (credential === undefined) throw new Error(`${API_KEY_REF} is not configured`)
    const timeout = AbortSignal.timeout(20_000)
    const response = await this.helper.fetch('/v1/models', {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential.value.trim()}`,
      },
    })
    if (!response.ok) throw await apiError(response)
    const value = await response.json() as unknown
    if (!isRecord(value) || !Array.isArray(value.data)) throw new TypeError('USTC /v1/models returned an invalid listing')
    return this.accept(value.data.flatMap(item => {
      if (!isRecord(item) || typeof item.id !== 'string') return []
      return [{ id: item.id, name: typeof item.name === 'string' ? item.name : item.id }]
    }))
  }

  async accept(input: readonly CachedModel[]): Promise<CachedModel[]> {
    const models = normalizeModels(input)
    await this.store.setModels(models)
    return models
  }

}

async function apiError(response: Response): Promise<Error> {
  let message = `USTC API answered HTTP ${response.status}`
  try {
    const value = await response.json() as unknown
    if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') message = value.error.message
  } catch {}
  return new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
