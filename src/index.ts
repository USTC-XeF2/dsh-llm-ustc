import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { UstcAdapter } from './adapter.ts'
import { Config, resolveConfig, type Config as PluginConfig } from './config.ts'
import { API_KEY_REF, PROVIDER, PROVIDER_NAME, SETTINGS_NS } from './constants.ts'
import { HelperManager } from './helper.ts'
import { ModelCatalog } from './model-catalog.ts'
import { StateStore } from './state.ts'
import { TokenworksAuth } from './tokenworks.ts'
import { installWeb, UstcWebBackend } from './web.ts'

export const name = 'dsh-llm-ustc'
export const inject = ['llm', 'credentials', 'settings']
export { Config }

export async function apply(ctx: Context, config: PluginConfig): Promise<() => Promise<void>> {
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsId = ctx.fiber.entry?.options.id ?? SETTINGS_NS
  const store = new StateStore()
  await store.load()
  const helper = new HelperManager(ctx, resolveConfig(config))
  const tokenworks = new TokenworksAuth(ctx)
  const resolveApiKey = async (): Promise<string> => {
    if (config.keySource.get() === 'tokenworks') return tokenworks.apiKey()
    const hit = await ctx.credentials.resolve(credentialRef(API_KEY_REF))
    if (hit === undefined) throw new LlmError(`USTC LLM credential ${API_KEY_REF} is not configured`, 'MISSING_CREDENTIAL')
    return assertUsableApiKey(hit.value, name, API_KEY_REF)
  }
  const catalog = new ModelCatalog(resolveApiKey, helper, store)
  const adapter = new UstcAdapter(ctx, helper, catalog, resolveApiKey)
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    settingsNs: settingsId,
    settingsPath: [],
    declared: false,
  }])
  ctx.on('settings/document-updated', ns => {
    if (ns === settingsId) helper.reconfigure(resolveConfig(config))
  })
  installWeb(ctx, new UstcWebBackend(ctx, helper, catalog, store, undefined, settingsId, config, tokenworks))
  return async () => {
    directory()
    registration()
    tokenworks.dispose()
    await helper.dispose()
  }
}
