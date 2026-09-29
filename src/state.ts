import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_MODEL } from './constants.ts'
import type { CachedModel, PluginState } from './types.ts'

const FALLBACK: PluginState = {
  models: [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }],
}

export class StateStore {
  readonly filename: string
  private current: PluginState = structuredClone(FALLBACK)
  private writes: Promise<void> = Promise.resolve()

  constructor(dshHome = resolveDshHome()) {
    this.filename = dshCachePath({ dshHome }, 'dsh-llm-ustc', 'models.json')
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.filename, 'utf8')) as unknown
      this.current = parseState(value)
      if (JSON.stringify(value) !== JSON.stringify(this.current)) await this.persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  snapshot(): PluginState {
    return structuredClone(this.current)
  }

  models(): CachedModel[] {
    return this.current.models.map(model => ({ ...model }))
  }

  async setModels(models: readonly CachedModel[]): Promise<void> {
    const normalized = normalizeModels(models)
    this.current = {
      ...this.current,
      models: normalized,
      modelsUpdatedAt: new Date().toISOString(),
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.current, null, 2)}\n`
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.filename), { recursive: true })
      const temporary = `${this.filename}.${process.pid}.tmp`
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filename)
    })
    await this.writes
  }
}

export function normalizeModels(models: readonly CachedModel[]): CachedModel[] {
  const unique = new Map<string, CachedModel>()
  for (const model of models) {
    const id = model.id.trim()
    if (id.length === 0 || id.length > 256 || /^claude/iu.test(id) || unique.has(id)) continue
    const name = model.name.trim()
    unique.set(id, { id, name: name.length === 0 ? id : name })
  }
  if (unique.size === 0) throw new TypeError('USTC model listing contains no usable model ids')
  return [...unique.values()].sort((left, right) => {
    if (left.id === DEFAULT_MODEL) return -1
    if (right.id === DEFAULT_MODEL) return 1
    return left.id.localeCompare(right.id)
  })
}

function parseState(value: unknown): PluginState {
  if (!isRecord(value) || !Array.isArray(value.models)) return structuredClone(FALLBACK)
  let models: CachedModel[]
  try {
    models = normalizeModels(value.models.filter(isCachedModel))
  } catch {
    models = structuredClone(FALLBACK.models)
  }
  return {
    models,
    ...(typeof value.modelsUpdatedAt === 'string' ? { modelsUpdatedAt: value.modelsUpdatedAt } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCachedModel(value: unknown): value is CachedModel {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}
