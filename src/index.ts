import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { UstcAdapter } from './adapter.ts'
import { Config, resolveConfig, type Config as PluginConfig } from './config.ts'
import { PROVIDER, PROVIDER_NAME, SETTINGS_NS } from './constants.ts'
import { HelperManager } from './helper.ts'
import { ModelCatalog } from './model-catalog.ts'
import { StateStore } from './state.ts'
import { installWeb, UstcWebBackend } from './web.ts'

export const name = 'dsh-llm-ustc'
export const inject = ['llm', 'credentials', 'settings']
export { Config }

export async function apply(ctx: Context, config: PluginConfig = {}): Promise<() => Promise<void>> {
  const scope = ctx.settings.register(settingsNamespace(SETTINGS_NS), Config, {
    base: config,
    applies: 'live',
    validate: resolveConfig,
  })
  const store = new StateStore()
  await store.load()
  const helper = new HelperManager(ctx, resolveConfig(scope.get()))
  const catalog = new ModelCatalog(ctx, helper, store)
  const adapter = new UstcAdapter(ctx, helper, catalog)
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    settingsNs: SETTINGS_NS,
    settingsPath: [],
    declared: false,
  }])
  const watch = scope.watch(next => {
    helper.reconfigure(resolveConfig(next))
    adapter.invalidate()
  })
  installWeb(ctx, new UstcWebBackend(ctx, helper, catalog, store))
  return async () => {
    watch()
    directory()
    registration()
    await helper.dispose()
  }
}
