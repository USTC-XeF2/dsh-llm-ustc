import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { UstcAdapter } from '../src/adapter.ts'
import { DEFAULT_MODEL } from '../src/constants.ts'
import type { HelperManager } from '../src/helper.ts'
import { ModelCatalog } from '../src/model-catalog.ts'
import { normalizeModels, StateStore } from '../src/state.ts'

describe('model catalog', () => {
  it('persists deletions including an empty catalog without changing the fetch time, and restores models on sync', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ustc-models-'))
    try {
      const models = [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }, { id: 'glm-5', name: 'GLM' }]
      const store = new StateStore(directory)
      await store.setModels(models)
      const updatedAt = store.snapshot().modelsUpdatedAt
      await store.removeModel('glm-5')
      const reloaded = new StateStore(directory)
      await reloaded.load()
      expect(reloaded.models()).toEqual([models[0]])
      expect(reloaded.snapshot().modelsUpdatedAt).toBe(updatedAt)

      await reloaded.removeModel(DEFAULT_MODEL)
      const empty = new StateStore(directory)
      await empty.load()
      expect(empty.models()).toEqual([])
      expect(empty.snapshot().modelsUpdatedAt).toBe(updatedAt)

      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: models })))
      const catalog = new ModelCatalog(async () => 'test-key', {
        onDirectRecovered: () => {}, fetch,
      } as unknown as HelperManager, empty)
      await catalog.refresh()
      expect(catalog.models()).toEqual(models)
      expect(fetch).toHaveBeenCalledOnce()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('refreshes in TypeScript after the helper reports direct recovery', async () => {
    let recover = async (): Promise<void> => { throw new Error('recovery handler was not registered') }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const setModels = vi.fn().mockResolvedValue(undefined)
    const helper = {
      onDirectRecovered: (handler: () => Promise<void>) => { recover = handler },
      fetch,
    } as unknown as HelperManager
    const store = { setModels, models: () => [] } as unknown as StateStore
    new ModelCatalog(async () => 'host-owned-key', helper, store)

    await recover()

    expect(fetch).toHaveBeenCalledWith('/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer host-owned-key' }),
    }))
    expect(setModels).toHaveBeenCalledWith([{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }])
  })
})

describe('helper authentication', () => {
  it('adds the private helper session header to chat completion requests', async () => {
    let key = 'test-api-key'
    const adapter = new UstcAdapter({
      get: () => undefined,
    } as never, {
      endpoint: async () => ({
        baseURL: 'http://127.0.0.1:9/v1',
        generation: 1,
        headers: { 'x-dsh-ustc-session': 'private-session' },
      }),
    } as never, {
      models: () => [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }],
    } as never, async () => key)

    const originalFetch = globalThis.fetch
    let headers: Headers | undefined
    globalThis.fetch = async (_input, init) => {
      headers = new Headers(init?.headers)
      return new Response([
        'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      for await (const _chunk of adapter.stream({
        provider: 'ustc',
        model: DEFAULT_MODEL,
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user' },
        })],
      })) {}
      expect(headers?.get('authorization')).toBe('Bearer test-api-key')
      key = 'tokenworks-gateway-key'
      for await (const _chunk of adapter.stream({
        provider: 'ustc', model: DEFAULT_MODEL,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello again' }], source: { kind: 'user' } })],
      })) {}
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(headers?.get('authorization')).toBe('Bearer tokenworks-gateway-key')
    expect(headers?.get('x-dsh-ustc-session')).toBe('private-session')
  })
})
