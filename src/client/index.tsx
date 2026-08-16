import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, IconChevronDownOutline14, IconRefreshOutline14, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const LOCALE_NS = 'llm-ustc'
const SETTINGS_ROUTE = '/_dsh/llm-ustc/settings'

const en = {
  title: 'USTC LLM',
  intro: 'Manage the USTC API credential, model catalog, and iWAN access.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  apiKeyLabel: 'USTC API Key',
  apiKeyPlaceholder: 'Enter a new key',
  configured: 'Configured',
  readOnly: 'The active credential or settings provider is read-only.',
  save: 'Save key',
  saving: 'Saving...',
  remove: 'Remove key',
  iwan: 'iWAN access',
  beginOidc: 'Start USTC sign-in',
  startingOidc: 'Starting...',
  logoutIwan: 'Sign out',
  loggingOut: 'Signing out...',
  openLogin: 'Open sign-in page',
  callbackLabel: 'Callback URL',
  callbackPlaceholder: 'Paste the complete com.panabit.mobile:// callback URL',
  completeOidc: 'Finish sign-in',
  completingOidc: 'Finishing...',
  noLine: 'Select a line',
  selectLine: 'Apply line',
  applyingLine: 'Applying...',
  route: 'Current route',
  refreshRoute: 'Refresh route',
  directRoute: 'Direct',
  iwanRoute: 'iWAN',
  models: 'Model catalog',
  syncModels: 'Sync models',
  syncingModels: 'Syncing...',
  refreshedAt: 'Refreshed',
  never: 'Never',
  loading: 'Loading...',
  helperStopped: 'Helper not started',
  retry: 'Retry',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  title: '科大大模型',
  intro: '管理科大 API 凭据、模型目录和 iWAN 访问。',
  expand: '展开设置',
  collapse: '收起设置',
  apiKeyLabel: '科大 API Key',
  apiKeyPlaceholder: '输入新的 Key',
  configured: '已配置',
  readOnly: '当前凭据或设置提供方为只读。',
  save: '保存 Key',
  saving: '正在保存...',
  remove: '移除 Key',
  iwan: 'iWAN 访问',
  beginOidc: '开始科大登录',
  startingOidc: '正在启动...',
  logoutIwan: '退出登录',
  loggingOut: '正在退出...',
  openLogin: '打开登录页面',
  callbackLabel: '回调 URL',
  callbackPlaceholder: '粘贴完整的 com.panabit.mobile:// 回调 URL',
  completeOidc: '完成登录',
  completingOidc: '正在完成...',
  noLine: '选择线路',
  selectLine: '应用线路',
  applyingLine: '正在应用...',
  route: '当前路由',
  refreshRoute: '刷新路由',
  directRoute: '直连',
  iwanRoute: 'iWAN',
  models: '模型目录',
  syncModels: '同步模型',
  syncingModels: '正在同步...',
  refreshedAt: '刷新时间',
  never: '从未',
  loading: '正在加载...',
  helperStopped: 'Helper 尚未启动',
  retry: '重试',
}

type Translate = (key: LocaleKey) => string

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** USTC LLM provider settings copy. */
    'llm-ustc': LocaleKey
  }
}

interface PublicServer {
  id: string
  name: string
  endpoint: string
}

interface HelperStatus {
  protocol: 'v1'
  target: 'api.llm.ustc.edu.cn:443'
  route: 'direct' | 'iwan'
  iwanConfigured: boolean
  selectedServerId?: string
  tunnelRunning: boolean
}

interface SettingsSnapshot {
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

interface OidcBegin {
  authUrl: string
  expiresInSeconds: number
}

interface ApiSuccess<T> { ok: true; value: T }
interface ApiFailure { ok: false; error: { code: string; message: string } }

type Action = 'load' | 'saveApiKey' | 'unsetApiKey' | 'beginOidc' | 'completeOidc' | 'logoutIwan' | 'refreshRoute' | 'selectServer' | 'syncModels'

interface ViewState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: SettingsSnapshot | undefined
  oidc?: OidcBegin | undefined
  action?: Action | undefined
  error?: string | undefined
}

async function apiRequest<T>(request?: Record<string, unknown>): Promise<T> {
  const response = await fetch(SETTINGS_ROUTE, request === undefined ? {
    credentials: 'same-origin',
  } : {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = await response.json() as ApiSuccess<T> | ApiFailure
  if (!response.ok || !body.ok) {
    const failure = body as ApiFailure
    throw new Error(failure.error?.message ?? `USTC settings request failed (HTTP ${response.status})`)
  }
  return body.value
}

export class UstcSettingsController {
  private current: ViewState = { status: 'idle' }
  private readonly listeners = new Set<() => void>()
  private generation = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): ViewState => this.current

  private set(next: ViewState): void {
    this.current = next
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    this.set({ ...this.current, status: 'loading', action: 'load', error: undefined })
    try {
      const snapshot = await apiRequest<SettingsSnapshot>()
      if (generation !== this.generation) return
      this.set({ status: 'ready', snapshot, oidc: this.current.oidc })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.current, status: 'error', action: undefined, error: messageOf(error) })
    }
  }

  refreshIfLoaded(): void {
    if (this.current.status !== 'idle' && this.current.action === undefined) void this.load()
  }

  async run<T>(action: Action, request: Record<string, unknown>, apply: (value: T, state: ViewState) => ViewState): Promise<void> {
    this.set({ ...this.current, action, error: undefined })
    try {
      const value = await apiRequest<T>({ action, ...request })
      this.set(apply(value, this.current))
    } catch (error) {
      this.set({ ...this.current, action: undefined, error: messageOf(error) })
    }
  }

  mutateSnapshot(action: Action, request: Record<string, unknown> = {}): Promise<void> {
    return this.run<SettingsSnapshot>(action, request, (snapshot, state) => ({
      status: 'ready', snapshot, oidc: state.oidc,
    }))
  }

  beginOidc(): Promise<void> {
    return this.run<OidcBegin>('beginOidc', {}, (oidc, state) => ({ ...state, action: undefined, oidc }))
  }

  completeOidc(callbackUrl: string): Promise<void> {
    return this.run<{ servers: PublicServer[]; snapshot: SettingsSnapshot }>('completeOidc', { callbackUrl }, (value) => ({
      status: 'ready', snapshot: value.snapshot,
    }))
  }

}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Injected {
  controller: UstcSettingsController
  t: Translate
}

type PluginSettingsProps = PropsRuntime<'settings.plugin.item'> & Partial<Injected>

function IwanSettingsItem({ controller, t }: PluginSettingsProps) {
  if (controller === undefined || t === undefined) return null
  return <UstcCard controller={controller} t={t} />
}

function UstcCard({ controller, t }: Injected) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => { if (state.status === 'idle') void controller.load() }, [controller, state.status])

  return <li className="ulu-card" data-open={open || undefined}>
    <button
      type="button"
      className="ulu-card-header"
      aria-expanded={open}
      aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
      onClick={() => { setOpen(value => !value) }}
    >
      <span className="ulu-card-head-text"><span className="ulu-card-name">{t('title')}</span><span className="ulu-card-description">{t('intro')}</span></span>
      <IconChevronDownOutline14 className="ulu-card-chevron" />
    </button>
    {open ? <div className="ulu-card-body"><LoadedSettings controller={controller} t={t} state={state} /></div> : null}
  </li>
}

function LoadedSettings({ controller, t, state }: Injected & { state: ViewState }) {
  const snapshot = state.snapshot
  const [apiKey, setApiKey] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [selectedServerId, setSelectedServerId] = useState('')

  useEffect(() => { setSelectedServerId(snapshot?.selectedServerId ?? '') }, [snapshot?.selectedServerId])

  if ((state.status === 'idle' || state.status === 'loading') && snapshot === undefined) {
    return <div className="ulu-loading">{t('loading')}</div>
  }
  if (snapshot === undefined) {
    return <div className="ulu-load-error"><p className="ulu-alert error">{state.error ?? t('helperStopped')}</p><Button size="sm" variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button></div>
  }

  const busy = state.action !== undefined && state.action !== 'load'
  const selectedExists = snapshot.iwan.servers.some(server => server.id === selectedServerId)

  return <div className="ulu-settings">
    <div className="ulu-status-row">
      <span>{t('route')}</span>
      <span className="ulu-route-value">
        <strong>{snapshot.helper?.route === 'iwan' ? t('iwanRoute') : t('directRoute')}</strong>
        <Tooltip label={t('refreshRoute')} side="top">
          <span className="ulu-route-refresh">
            <Button type="button" variant="toolbar" size="sm" icon={<IconRefreshOutline14 className={state.action === 'refreshRoute' ? 'ulu-spin' : undefined} />} aria-label={t('refreshRoute')} disabled={busy} onClick={() => { void controller.mutateSnapshot('refreshRoute') }} />
          </span>
        </Tooltip>
      </span>
    </div>
    {!snapshot.writable || !snapshot.apiKey.writable || !snapshot.iwan.writable ? <p className="ulu-alert warning">{t('readOnly')}</p> : null}

    <section className="ulu-section">
      <div className="ulu-section-title"><h3>{t('apiKeyLabel')}</h3></div>
      <Input type="password" autoComplete="off" aria-label={t('apiKeyLabel')} placeholder={snapshot.apiKey.configured ? t('configured') : t('apiKeyPlaceholder')} value={apiKey} onChange={event => { setApiKey(event.target.value) }} />
      <div className="ulu-actions">
        <Button size="sm" variant="primary" disabled={busy || !snapshot.apiKey.writable || apiKey.trim().length === 0} onClick={() => {
          void controller.mutateSnapshot('saveApiKey', { value: apiKey }).then(() => { setApiKey('') })
        }}>{state.action === 'saveApiKey' ? t('saving') : t('save')}</Button>
        <Button size="sm" variant="outline" disabled={busy || !snapshot.apiKey.writable || !snapshot.apiKey.configured} onClick={() => { void controller.mutateSnapshot('unsetApiKey') }}>{t('remove')}</Button>
      </div>
    </section>

    <section className="ulu-section">
      <div className="ulu-section-title">
        <h3>{t('iwan')}</h3>
        {snapshot.iwan.configured ? <Button size="sm" variant="outline" disabled={busy || !snapshot.iwan.writable || !snapshot.writable} onClick={() => { void controller.mutateSnapshot('logoutIwan', { expectedRevision: snapshot.revision }) }}>{state.action === 'logoutIwan' ? t('loggingOut') : t('logoutIwan')}</Button> : null}
      </div>
      {snapshot.iwan.configured ? null : <div className="ulu-login-row">
        <Button variant="primary" disabled={busy || !snapshot.iwan.writable} onClick={() => { void controller.beginOidc() }}>{state.action === 'beginOidc' ? t('startingOidc') : t('beginOidc')}</Button>
        {state.oidc === undefined ? null : <a className="ulu-link" href={state.oidc.authUrl} target="_blank" rel="noopener noreferrer">{t('openLogin')}</a>}
      </div>}
      {snapshot.iwan.configured || state.oidc === undefined ? null : <div className="ulu-row">
        <div className="ulu-field">
          <label htmlFor="ulu-callback-url">{t('callbackLabel')}</label>
          <Input id="ulu-callback-url" value={callbackUrl} placeholder={t('callbackPlaceholder')} onChange={event => { setCallbackUrl(event.target.value) }} />
        </div>
        <Button variant="outline" disabled={busy || callbackUrl.trim().length === 0} onClick={() => { void controller.completeOidc(callbackUrl) }}>{state.action === 'completeOidc' ? t('completingOidc') : t('completeOidc')}</Button>
      </div>}
      {snapshot.iwan.configured ? <div className="ulu-row">
        <select className="ulu-line-select" aria-label={t('noLine')} value={selectedServerId} onChange={event => { setSelectedServerId(event.target.value) }}><option value="">{t('noLine')}</option>{snapshot.iwan.servers.map(server => <option value={server.id} key={server.id}>{server.name} ({server.endpoint})</option>)}</select>
        <Button variant="outline" disabled={busy || !snapshot.writable || !selectedExists || selectedServerId === snapshot.selectedServerId} onClick={() => { void controller.mutateSnapshot('selectServer', { serverId: selectedServerId, expectedRevision: snapshot.revision }) }}>{state.action === 'selectServer' ? t('applyingLine') : t('selectLine')}</Button>
      </div> : null}
    </section>

    <section className="ulu-section">
      <div className="ulu-section-title">
        <div><h3>{t('models')}</h3><p>{t('refreshedAt')}: {snapshot.modelsUpdatedAt === undefined ? t('never') : new Date(snapshot.modelsUpdatedAt).toLocaleString()}</p></div>
        <Button size="sm" variant="outline" disabled={busy || !snapshot.apiKey.configured} onClick={() => { void controller.mutateSnapshot('syncModels') }}>{state.action === 'syncModels' ? t('syncingModels') : t('syncModels')}</Button>
      </div>
      <div className="ulu-model-list">{snapshot.models.map(model => <div className="ulu-model-entry" key={model.id}><code>{model.id}</code>{model.name === model.id ? null : <span>{model.name}</span>}</div>)}</div>
    </section>
  </div>
}

const CSS = `
.ulu-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}.ulu-card:hover{border-color:var(--dsw-alias-label-dimmed)}.ulu-card[data-open=true]{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}
.ulu-card-header{appearance:none;display:flex;width:100%;align-items:center;gap:12px;padding:14px 16px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.ulu-card-header:focus-visible{outline:none;box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}.ulu-card-head-text{display:flex;min-width:0;flex:1;flex-direction:column;gap:4px}.ulu-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.ulu-card-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.ulu-card-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}.ulu-card[data-open=true] .ulu-card-chevron{transform:rotate(180deg)}.ulu-card-body{margin:0 16px;padding-bottom:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.ulu-settings{color:var(--dsw-alias-label-primary)}
.ulu-section{display:grid;min-width:0;gap:6px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}.ulu-section>*{min-width:0}.ulu-section-title{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:14px}.ulu-section-title>div{min-width:0}.ulu-section-title h3{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;letter-spacing:0;line-height:1.5}.ulu-section-title p{max-width:620px;margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.ulu-row{display:grid;min-width:0;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px}.ulu-field{display:grid;min-width:0;gap:6px}.ulu-field>*{min-width:0;max-width:100%;box-sizing:border-box}.ulu-field>label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}.ulu-field>span{width:100%}.ulu-line-select{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.ulu-line-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.ulu-actions,.ulu-login-row{display:flex;min-width:0;align-items:center;gap:8px;flex-wrap:wrap}.ulu-link{display:inline-flex;min-height:34px;align-items:center;color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:500;text-decoration:none}.ulu-link:hover{text-decoration:underline}
.ulu-status-row{display:flex;min-height:34px;align-items:center;justify-content:space-between;gap:16px;color:var(--dsw-alias-label-secondary);font-size:12px}.ulu-status-row strong{color:var(--dsw-alias-label-primary);font-weight:500}.ulu-route-value{display:flex;align-items:center;gap:5px}.ulu-route-refresh{display:inline-flex}.ulu-route-refresh>button{width:28px;padding:0}.ulu-spin{animation:ulu-spin .7s linear infinite}@keyframes ulu-spin{to{transform:rotate(360deg)}}.ulu-alert{margin:0;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:1.5}.ulu-alert.warning{color:var(--dsw-alias-label-warning,#8c641b)}.ulu-alert.error{color:var(--dsw-alias-label-error,#a43d39)}
.ulu-loading{padding:16px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}.ulu-load-error{display:flex;align-items:center;justify-content:space-between;gap:12px}.ulu-load-error .ulu-alert{flex:1;border-top:0}
.ulu-model-list{display:flex;max-height:300px;min-width:0;flex-direction:column;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2)}.ulu-model-entry{display:grid;min-width:0;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:8px;padding:9px 2px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px}.ulu-model-entry code,.ulu-model-entry span{min-width:0;overflow-wrap:anywhere}.ulu-model-entry span{color:var(--dsw-alias-label-tertiary)}
`

function installStyles(): () => void {
  const id = 'dsh-llm-ustc/client'
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.pluginCss = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-llm-ustc: styles')
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'dsh-llm-ustc: locale')
  const t = ctx.locale.bind(LOCALE_NS)
  const controller = new UstcSettingsController()
  ctx.effect(() => {
    const dispose = ctx.on('connection/reset', () => { controller.refreshIfLoaded() })
    return () => { dispose() }
  }, 'dsh-llm-ustc: settings invalidations')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'llm-ustc',
    order: 25,
    inject: () => ({ controller, t }),
  }, IwanSettingsItem))
}
