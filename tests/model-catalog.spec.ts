import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { UstcAdapter } from '../src/adapter.ts'
import { DEFAULT_MODEL } from '../src/constants.ts'
import { normalizeModels } from '../src/state.ts'

describe('model catalog', () => {
  it('keeps server ids, removes duplicates and Claude placeholders, and prefers the documented default', () => {
    expect(normalizeModels([
      { id: 'z-model', name: 'Z' },
      { id: ` ${DEFAULT_MODEL} `, name: '' },
      { id: 'z-model', name: 'ignored duplicate' },
      { id: 'claude-haiku-4-5', name: 'Claude placeholder' },
      { id: 'Claude-Sonnet-4-6', name: 'Case-insensitive placeholder' },
      { id: 'a-model', name: 'A' },
    ])).toEqual([
      { id: DEFAULT_MODEL, name: DEFAULT_MODEL },
      { id: 'a-model', name: 'A' },
      { id: 'z-model', name: 'Z' },
    ])
  })
})

describe('helper authentication', () => {
  it('adds the private helper session header to chat completion requests', async () => {
    const adapter = new UstcAdapter({
      credentials: {
        resolve: async () => ({ value: 'test-api-key' }),
      },
      get: () => undefined,
    } as never, {
      endpoint: async () => ({
        baseURL: 'http://127.0.0.1:9/v1',
        generation: 1,
        headers: { 'x-dsh-ustc-session': 'private-session' },
      }),
    } as never, {
      models: () => [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }],
    } as never)

    const originalFetch = globalThis.fetch
    let headers: Headers | undefined
    globalThis.fetch = async (_input, init) => {
      headers = new Headers(init?.headers)
      return new Response([
        'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-flash-ascend","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"deepseek-v4-flash-ascend","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
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
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(headers?.get('authorization')).toBe('Bearer test-api-key')
    expect(headers?.get('x-dsh-ustc-session')).toBe('private-session')
  })
})
