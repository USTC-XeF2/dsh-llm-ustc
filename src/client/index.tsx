import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, IconCloseOutlineRegular, IconRefreshOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const LOCALE_NS = 'llm-ustc'
const SETTINGS_ROUTE = '/api/llm-ustc/settings'

const en = {
  apiKeyLabel: 'USTC API Key',
  keySource: 'Key source',
  manualKey: 'Enter API Key',
  tokenworksKey: 'Tokenworks sign-in',
  beginTokenworks: 'Sign in to Tokenworks',
  awaitingLogin: 'Waiting for browser sign-in...',
  cancelLogin: 'Cancel sign-in',
  signedIn: 'Signed in',
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
  removeModel: 'Remove model',
  modelsEmpty: 'No models',
  refreshedAt: 'Refreshed',
  never: 'Never',
  loading: 'Loading...',
  helperStopped: 'Helper not started',
  retry: 'Retry',
} as const

type LocaleKey = keyof typeof en

const zh: Record<LocaleKey, string> = {
  apiKeyLabel: '科大 API Key',
  keySource: 'Key 来源',
  manualKey: '手动输入 API Key',
  tokenworksKey: '词元工坊登录',
  beginTokenworks: '登录词元工坊',
  awaitingLogin: '等待浏览器登录...',
  cancelLogin: '取消登录',
  signedIn: '已登录',
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
  removeModel: '删除模型',
  modelsEmpty: '暂无模型',
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

interface SettingsSnapshot {
  writable: boolean
  revision: number
  selectedServerId?: string
  keySource: 'manual' | 'tokenworks'
  apiKey: { configured: boolean; source?: string; writable: boolean }
  tokenworks: { configured: boolean; writable: boolean; pending: boolean; name?: string; error?: string }
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

interface OidcBegin {
  authUrl: string
  expiresInSeconds: number
}

interface ApiSuccess<T> { ok: true; value: T }
interface ApiFailure { ok: false; error: { code: string; message: string } }

type Action = 'load' | 'saveApiKey' | 'unsetApiKey' | 'selectKeySource' | 'beginTokenworks' | 'cancelTokenworks' | 'logoutTokenworks' | 'beginOidc' | 'completeOidc' | 'logoutIwan' | 'refreshRoute' | 'selectServer' | 'syncModels' | 'removeModel'

interface ViewState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  snapshot?: SettingsSnapshot | undefined
  oidc?: OidcBegin | undefined
  tokenworksUrl?: string | undefined
  action?: Action | undefined
  error?: string | undefined
  errorAction?: Action | undefined
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
  private polling = false

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
    this.set({ ...this.current, status: 'loading', action: 'load', error: undefined, errorAction: undefined })
    try {
      const snapshot = await apiRequest<SettingsSnapshot>()
      if (generation !== this.generation) return
      this.set({ status: 'ready', snapshot, oidc: this.current.oidc, tokenworksUrl: snapshot.tokenworks.pending ? this.current.tokenworksUrl : undefined })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...this.current, status: 'error', action: undefined, error: messageOf(error), errorAction: 'load' })
    }
  }

  refreshIfLoaded(): void {
    if (this.current.status !== 'idle' && this.current.action === undefined) void this.load()
  }

  async run<T>(action: Action, request: Record<string, unknown>, apply: (value: T, state: ViewState) => ViewState): Promise<void> {
    ++this.generation
    this.set({ ...this.current, action, error: undefined, errorAction: undefined })
    try {
      const value = await apiRequest<T>({ action, ...request })
      this.set(apply(value, this.current))
    } catch (error) {
      this.set({ ...this.current, action: undefined, error: messageOf(error), errorAction: action })
    }
  }

  mutateSnapshot(action: Action, request: Record<string, unknown> = {}): Promise<void> {
    return this.run<SettingsSnapshot>(action, request, (snapshot, state) => ({
      status: 'ready', snapshot, oidc: state.oidc,
      tokenworksUrl: snapshot.tokenworks.pending ? state.tokenworksUrl : undefined,
    }))
  }

  beginOidc(): Promise<void> {
    return this.run<OidcBegin>('beginOidc', {}, (oidc, state) => ({ ...state, action: undefined, oidc }))
  }

  beginTokenworks(): Promise<void> {
    return this.run<{ authUrl: string; snapshot: SettingsSnapshot }>('beginTokenworks', {}, (value, state) => ({
      ...state, status: 'ready', action: undefined, snapshot: value.snapshot, tokenworksUrl: value.authUrl,
    }))
  }

  async pollLogin(): Promise<void> {
    if (this.current.action !== undefined || this.polling) return
    this.polling = true
    const generation = this.generation
    try {
      const snapshot = await apiRequest<SettingsSnapshot>()
      if (generation !== this.generation) return
      this.set({ ...this.current, snapshot, tokenworksUrl: snapshot.tokenworks.pending ? this.current.tokenworksUrl : undefined })
    } catch (error) {
      if (generation === this.generation) this.set({ ...this.current, error: messageOf(error), errorAction: 'beginTokenworks' })
    } finally { this.polling = false }
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

type BundleConfigProps = PropsRuntime<'plugins.bundle.config'> & Injected

function UstcBundleConfig({ controller, t }: BundleConfigProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const snapshot = state.snapshot
  const [apiKey, setApiKey] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [selectedServerId, setSelectedServerId] = useState('')

  useEffect(() => { void controller.load() }, [controller])
  useEffect(() => { setSelectedServerId(snapshot?.selectedServerId ?? '') }, [snapshot?.selectedServerId])
  useEffect(() => { setApiKey('') }, [snapshot?.keySource])
  useEffect(() => {
    if (!snapshot?.tokenworks.pending) return
    const timer = setInterval(() => { void controller.pollLogin() }, 1_500)
    return () => clearInterval(timer)
  }, [controller, snapshot?.tokenworks.pending])

  if ((state.status === 'idle' || state.status === 'loading') && snapshot === undefined) {
    return <div className="ulu-loading">{t('loading')}</div>
  }
  if (snapshot === undefined) {
    return <div className="ulu-load-error"><p className="ulu-alert error">{state.error ?? t('helperStopped')}</p><Button size="sm" variant="outline" onClick={() => { void controller.load() }}>{t('retry')}</Button></div>
  }

  const busy = state.action !== undefined && state.action !== 'load'
  const selectedExists = snapshot.iwan.servers.some(server => server.id === selectedServerId)

  return <div className="ulu-settings">
    {!snapshot.writable || !(snapshot.keySource === 'manual' ? snapshot.apiKey.writable : snapshot.tokenworks.writable) || !snapshot.iwan.writable ? <p className="ulu-alert warning">{t('readOnly')}</p> : null}

    <section className="ulu-section">
      <div className="ulu-section-title"><h3>{t('apiKeyLabel')}</h3></div>
      <select className="ulu-line-select" aria-label={t('keySource')} value={snapshot.keySource} disabled={busy || !snapshot.writable} onChange={event => {
        void controller.mutateSnapshot('selectKeySource', { keySource: event.target.value, expectedRevision: snapshot.revision })
      }}><option value="manual">{t('manualKey')}</option><option value="tokenworks">{t('tokenworksKey')}</option></select>
      {snapshot.keySource === 'manual' ? <>
        <input className="ulu-input" type="password" autoComplete="new-password" aria-label={t('apiKeyLabel')} placeholder={snapshot.apiKey.configured ? t('configured') : t('apiKeyPlaceholder')} value={apiKey} onChange={event => { setApiKey(event.target.value) }} />
        <div className="ulu-actions">
        <Button size="sm" variant="primary" disabled={busy || !snapshot.apiKey.writable || apiKey.trim().length === 0} onClick={() => {
          void controller.mutateSnapshot('saveApiKey', { value: apiKey }).then(() => { setApiKey('') })
        }}>{state.action === 'saveApiKey' ? t('saving') : t('save')}</Button>
        <Button size="sm" variant="outline" disabled={busy || !snapshot.apiKey.writable || !snapshot.apiKey.configured} onClick={() => { void controller.mutateSnapshot('unsetApiKey') }}>{t('remove')}</Button>
        </div>
      </> : <div className="ulu-login-row">
        {snapshot.tokenworks.pending ? <>
          {state.tokenworksUrl === undefined ? <span className="ulu-login-state">{t('awaitingLogin')}</span> : <a className="ulu-link" href={state.tokenworksUrl} target="_blank" rel="noopener noreferrer">{t('openLogin')}</a>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void controller.mutateSnapshot('cancelTokenworks') }}>{t('cancelLogin')}</Button>
        </> : snapshot.tokenworks.configured ? <>
          <span className="ulu-login-state">{snapshot.tokenworks.name ?? t('signedIn')}</span>
          <Button size="sm" variant="outline" disabled={busy || !snapshot.tokenworks.writable} onClick={() => { void controller.mutateSnapshot('logoutTokenworks') }}>{state.action === 'logoutTokenworks' ? t('loggingOut') : t('logoutIwan')}</Button>
        </> : <Button size="sm" variant="primary" disabled={busy || !snapshot.tokenworks.writable} onClick={() => { void controller.beginTokenworks() }}>{state.action === 'beginTokenworks' ? t('startingOidc') : t('beginTokenworks')}</Button>}
      </div>}
      {state.errorAction === 'saveApiKey' || state.errorAction === 'unsetApiKey' || state.errorAction === 'selectKeySource' || state.errorAction === 'beginTokenworks' || state.errorAction === 'cancelTokenworks' || state.errorAction === 'logoutTokenworks' ? <p className="ulu-alert error">{state.error}</p> : null}
      {snapshot.keySource === 'tokenworks' && snapshot.tokenworks.error ? <p className="ulu-alert error">{snapshot.tokenworks.error}</p> : null}
    </section>

    <div className="ulu-status-row">
      <span>{t('route')}</span>
      <span className="ulu-route-value">
        <strong>{snapshot.usingIwan ? t('iwanRoute') : t('directRoute')}</strong>
        <Tooltip label={t('refreshRoute')} side="top">
          <span className="ulu-route-refresh">
            <Button type="button" variant="ghost" size="sm" icon={<IconRefreshOutlineMedium className={state.action === 'refreshRoute' ? 'ulu-spin' : undefined} />} aria-label={t('refreshRoute')} disabled={busy} onClick={() => { void controller.mutateSnapshot('refreshRoute') }} />
          </span>
        </Tooltip>
      </span>
    </div>

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
          <input className="ulu-input" id="ulu-callback-url" value={callbackUrl} placeholder={t('callbackPlaceholder')} onChange={event => { setCallbackUrl(event.target.value) }} />
        </div>
        <Button variant="outline" disabled={busy || callbackUrl.trim().length === 0} onClick={() => { void controller.completeOidc(callbackUrl) }}>{state.action === 'completeOidc' ? t('completingOidc') : t('completeOidc')}</Button>
      </div>}
      {snapshot.iwan.configured ? <div className="ulu-row">
        <select className="ulu-line-select" aria-label={t('noLine')} value={selectedServerId} onChange={event => { setSelectedServerId(event.target.value) }}><option value="">{t('noLine')}</option>{snapshot.iwan.servers.map(server => <option value={server.id} key={server.id}>{server.name} ({server.endpoint})</option>)}</select>
        <Button variant="outline" disabled={busy || !snapshot.writable || !selectedExists || selectedServerId === snapshot.selectedServerId} onClick={() => { void controller.mutateSnapshot('selectServer', { serverId: selectedServerId, expectedRevision: snapshot.revision }) }}>{state.action === 'selectServer' ? t('applyingLine') : t('selectLine')}</Button>
      </div> : null}
      {state.errorAction === 'beginOidc' || state.errorAction === 'completeOidc' || state.errorAction === 'logoutIwan' || state.errorAction === 'selectServer' ? <p className="ulu-alert error">{state.error}</p> : null}
    </section>

    <section className="ulu-section">
      <div className="ulu-section-title">
        <div><h3>{t('models')}</h3><p>{t('refreshedAt')}: {snapshot.modelsUpdatedAt === undefined ? t('never') : new Date(snapshot.modelsUpdatedAt).toLocaleString()}</p></div>
        <Button size="sm" variant="outline" disabled={busy || !(snapshot.keySource === 'manual' ? snapshot.apiKey.configured : snapshot.tokenworks.configured)} onClick={() => { void controller.mutateSnapshot('syncModels') }}>{state.action === 'syncModels' ? t('syncingModels') : t('syncModels')}</Button>
      </div>
      <div className="ulu-model-list">
        {snapshot.models.map(model => <div className="ulu-model-entry" key={model.id}>
          <code>{model.id}</code>
          <span>{model.name === model.id ? '' : model.name}</span>
          <button className="ulu-model-remove" type="button" title={t('removeModel')} aria-label={`${t('removeModel')}: ${model.id}`} disabled={busy} onClick={() => { void controller.mutateSnapshot('removeModel', { modelId: model.id }) }}><IconCloseOutlineRegular /></button>
        </div>)}
        {snapshot.models.length === 0 ? <div className="ulu-model-empty">{t('modelsEmpty')}</div> : null}
      </div>
      {state.errorAction === 'syncModels' || state.errorAction === 'removeModel' ? <p className="ulu-alert error">{state.error}</p> : null}
    </section>
    {state.errorAction === 'refreshRoute' ? <p className="ulu-alert error">{state.error}</p> : null}
  </div>
}

const CSS = `
.ulu-settings{display:flex;min-width:0;flex-direction:column;color:var(--dsw-alias-label-primary)}
.ulu-status-row{display:flex;min-height:34px;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2);font-size:13px;line-height:1.5}
.ulu-status-row strong{font-weight:500}.ulu-route-value{display:flex;align-items:center;gap:5px}.ulu-route-refresh{display:inline-flex}.ulu-route-refresh>button,.ulu-route-refresh>button:hover:not(:disabled),.ulu-route-refresh>button:active:not(:disabled){width:28px;padding:0;background:transparent}
.ulu-section{display:grid;min-width:0;gap:6px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}.ulu-section>*{min-width:0}
.ulu-section-title{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:8px}.ulu-section-title>div{min-width:0}
.ulu-section-title h3,.ulu-field>label{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.ulu-section-title p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.ulu-input,.ulu-line-select{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.ulu-input::placeholder{color:var(--dsw-alias-label-dimmed)}.ulu-input:focus-visible,.ulu-line-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.ulu-row{display:grid;min-width:0;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px}.ulu-field{display:grid;min-width:0;gap:6px}.ulu-field>*{min-width:0}
.ulu-actions,.ulu-login-row{display:flex;min-width:0;align-items:center;gap:8px}.ulu-actions{padding-top:16px}.ulu-actions button:first-child,.ulu-login-row button,.ulu-row>button{min-height:31px;padding:5px 14px;border-radius:var(--dsw-radius-md);font-size:13px;line-height:1.5}
.ulu-link{display:inline-flex;min-height:31px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;text-decoration:none}.ulu-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.ulu-login-state{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}
.ulu-spin{animation:ulu-spin .7s linear infinite}@keyframes ulu-spin{to{transform:rotate(360deg)}}
.ulu-alert{margin:0;padding:10px 0;border-top:0.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:1.5}.ulu-alert.warning{color:var(--dsw-alias-label-tertiary)}.ulu-alert.error{color:var(--dsw-alias-label-error)}
.ulu-loading{padding:12px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}.ulu-load-error{display:flex;align-items:center;justify-content:space-between;gap:12px}.ulu-load-error .ulu-alert{flex:1;border-top:0}
.ulu-model-list{display:flex;max-height:300px;min-width:0;flex-direction:column;overflow:auto;border-top:0.5px solid var(--dsw-alias-border-l2)}
.ulu-model-entry{display:grid;min-width:0;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) auto;align-items:center;gap:8px;padding:9px 2px;border-bottom:0.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px}
.ulu-model-entry code,.ulu-model-entry span{min-width:0;overflow-wrap:anywhere}.ulu-model-entry span{color:var(--dsw-alias-label-tertiary)}
.ulu-model-remove{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}.ulu-model-remove:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.ulu-model-remove:disabled{opacity:.5;cursor:default}
.ulu-model-empty{padding:9px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
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
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-llm-ustc',
    inject: () => ({ controller, t }),
  }, UstcBundleConfig))
}
