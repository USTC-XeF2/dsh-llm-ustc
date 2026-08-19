import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  assertUsableApiKey,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  API_KEY_REF,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER,
  PROVIDER_NAME,
} from './constants.ts'
import type { HelperManager } from './helper.ts'
import type { ModelCatalog } from './model-catalog.ts'

const RETRY_POLICY = resolveRetryPolicy(undefined, 'llm-ustc.retryPolicy')

const USTC_REASONING_EFFORTS = [
  { id: ReasoningEffortId('off'), name: 'Off' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('max'), name: 'Max' },
] as const

const LONG_CONTEXT_WINDOW = 1_000_000
const K3_CONTEXT_WINDOW = 600_000

export class UstcAdapter extends LlmAdapter {
  private delegate: { key: string; adapter: PiAiAdapter } | undefined

  constructor(
    private readonly ctx: Context,
    private readonly helper: HelperManager,
    private readonly catalog: ModelCatalog,
  ) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    this.assertProvider(provider)
    return { id: PROVIDER, name: PROVIDER_NAME }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.assertProvider(provider)
    return RETRY_POLICY
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    return this.catalog.models().map(model => ({
      provider: PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.assertProvider(provider)
    const match = this.catalog.models().find(candidate => candidate.id === model)
    const capabilities = modelCapabilities(model)
    return {
      provider: PROVIDER,
      id: model,
      name: match?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: capabilities.contextWindow },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      ...(capabilities.reasoning ? { reasoning: { efforts: USTC_REASONING_EFFORTS } } : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertProvider(options.provider)
    const adapter = await this.currentDelegate()
    try {
      for await (const chunk of adapter.stream(options)) {
        yield normalizeChunk(chunk)
      }
    } catch (error) {
      throw normalizeThrownError(error)
    }
  }

  invalidate(): void {
    this.delegate = undefined
  }

  private async currentDelegate(): Promise<PiAiAdapter> {
    const endpoint = await this.helper.endpoint()
    const models = this.catalog.models()
    const key = `${endpoint.baseURL}\0${endpoint.generation}\0${models.map(model => `${model.id}\0${model.name}`).join('\0')}`
    if (this.delegate?.key === key) return this.delegate.adapter
    const profile = makeProfile(endpoint.baseURL, models, endpoint.headers)
    const profiles = new Map([[PROVIDER, profile]])
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => {
        const hit = await this.ctx.credentials.resolve(credentialRef(API_KEY_REF))
        if (hit === undefined) throw new LlmError(
          `USTC LLM credential ${API_KEY_REF} is not configured`,
          'MISSING_CREDENTIAL',
        )
        return assertUsableApiKey(hit.value, 'dsh-llm-ustc', API_KEY_REF)
      },
      resolveAttachments: () => this.ctx.get('attachments'),
    })
    this.delegate = { key, adapter }
    return adapter
  }

  private assertProvider(provider: string): void {
    if (provider !== PROVIDER) throw new LlmError(`USTC adapter does not own provider ${JSON.stringify(provider)}`, 'NO_ADAPTER')
  }
}

export function normalizeFailure(message: string, code: string): string {
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid.*(?:api[ -]?key|credential)/iu.test(message)) return 'AUTH'
  if (/\b429\b|rate.?limit/iu.test(message)) return 'RATE_LIMIT'
  if (/\b404\b|model.*(?:not found|does not exist|unknown)/iu.test(message)) return 'UNKNOWN_MODEL'
  if (/\b5\d\d\b|service unavailable/iu.test(message)) return 'SERVER'
  if (/\b(?:dns|network|connection|socket|fetch|transport)\b|\bECONN[A-Z]+\b/u.test(message)) return 'TRANSPORT'
  return code
}

function normalizeChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
  const failure = chunk.reason.failure
  return {
    ...chunk,
    reason: {
      kind: 'error',
      failure: { ...failure, code: normalizeFailure(failure.message, failure.code) },
    },
  }
}

function normalizeThrownError(error: unknown): unknown {
  if (!(error instanceof LlmError)) return error
  const code = normalizeFailure(error.message, error.code)
  return code === error.code ? error : new LlmError(error.message, code, { cause: error })
}

function makeProfile(
  baseURL: string,
  cached: readonly { id: string; name: string }[],
  headers: Readonly<Record<string, string>>,
): ResolvedPiAiProviderProfile {
  const models: Model<'openai-completions'>[] = cached.map(model => {
    const capabilities = modelCapabilities(model.id)
    return {
      id: model.id,
      name: model.name,
      api: 'openai-completions',
      provider: PROVIDER,
      baseUrl: baseURL,
      reasoning: capabilities.reasoning,
      ...(capabilities.reasoning ? {
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: 'high',
          xhigh: null,
          max: 'max',
        },
      } : {}),
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: capabilities.contextWindow,
      maxTokens: DEFAULT_MAX_TOKENS,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: capabilities.reasoning,
        ...(capabilities.reasoning ? { thinkingFormat: 'deepseek' } : {}),
        requiresReasoningContentOnAssistantMessages: capabilities.reasoning,
        supportsUsageInStreaming: true,
        maxTokensField: 'max_tokens',
        supportsStrictMode: false,
        supportsLongCacheRetention: false,
      },
    }
  })
  const provider = createProvider({
    id: PROVIDER,
    name: PROVIDER_NAME,
    baseUrl: baseURL,
    auth: {
      apiKey: {
        name: PROVIDER_NAME,
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key },
          source: API_KEY_REF,
        }),
      },
    },
    models,
    api: openAICompletionsApi(),
  })
  return {
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    apiKeyEnv: credentialRef(API_KEY_REF),
    api: 'openai-completions',
    baseURL,
    headers: { ...headers },
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultInput: ['text'],
    streamIdleTimeoutMs: 300_000,
    retryPolicy: RETRY_POLICY,
    piProvider: provider,
    configuredMaxTokens: new Map(models.map(model => [model.id, DEFAULT_MAX_TOKENS])),
  }
}

function modelCapabilities(model: string): { contextWindow: number; reasoning: boolean } {
  const id = model.toLowerCase()
  if (id.startsWith('deepseek-v4') || id.startsWith('glm-5')) {
    return { contextWindow: LONG_CONTEXT_WINDOW, reasoning: true }
  }
  if (id === 'k3') return { contextWindow: K3_CONTEXT_WINDOW, reasoning: true }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, reasoning: false }
}
