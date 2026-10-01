import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { IWAN_CONFIG_REF, SETTINGS_NS } from '../src/constants.ts'
import type { HelperManager } from '../src/helper.ts'
import { publicIwanServers } from '../src/iwan.ts'
import type { ModelCatalog } from '../src/model-catalog.ts'
import type { IwanAuthenticator } from '../src/oidc.ts'
import type { StateStore } from '../src/state.ts'
import type { TokenworksAuth } from '../src/tokenworks.ts'
import { publicMessage, UstcWebBackend, type SettingsSnapshot } from '../src/web.ts'

describe('browser-safe settings values', () => {
  it('projects only public line fields from the private credential', () => {
    const raw = JSON.stringify({
      domain: 'iwan.ustc',
      servers: [{
        id: 'line-one', name: 'Line One', host: '1.2.3.4', port: 6001,
        username: 'user', passWord: 'encrypted-secret',
      }],
    })
    const projected = publicIwanServers(raw)

    expect(projected).toEqual([{ id: 'line-one', name: 'Line One', endpoint: '1.2.3.4:6001' }])
    expect(JSON.stringify(projected)).not.toContain('encrypted-secret')
    expect(JSON.stringify(projected)).not.toContain('user')
  })

  it('redacts bearer and callback secrets in public errors', () => {
    const message = publicMessage(new Error('Bearer abc.secret com.panabit.mobile://oauth2redirect?code=secret sk-abcdefghijklmnopqrstuvwxyz0123456789'))
    expect(message).toBe('Bearer [redacted] com.panabit.mobile://[redacted] [redacted]')
  })
})

describe('USTC web settings backend', () => {
  it('switches the key source without clearing either credential or changing the network route', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const unset = vi.fn()
    const cancel = vi.fn()
    const stop = vi.fn()
    const backend = new UstcWebBackend(
      { settings: { update }, credentials: { unset } } as unknown as Context,
      { stop } as unknown as HelperManager, {} as ModelCatalog, {} as StateStore,
      undefined, SETTINGS_NS, undefined, { cancel } as unknown as TokenworksAuth,
    )
    const snapshot = { keySource: 'tokenworks' } as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)
    await expect(backend.handle({ action: 'selectKeySource', keySource: 'tokenworks', expectedRevision: 3 })).resolves.toBe(snapshot)
    expect(update).toHaveBeenCalledWith(SETTINGS_NS, { keySource: 'tokenworks' }, 3)
    expect(cancel).toHaveBeenCalledOnce()
    expect(unset).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('stores Host-authenticated iWAN lines and restarts the helper boundary', async () => {
    const config = {
      domain: 'iwan.ustc',
      servers: [{
        id: 'line-one', name: 'Line One', host: '1.2.3.4', port: 6001,
        username: 'user', passWord: 'encrypted-secret',
      }],
    }
    const set = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn().mockResolvedValue(undefined)
    const complete = vi.fn().mockResolvedValue(config)
    const ctx = { credentials: { set } } as unknown as Context
    const helper = { stop } as unknown as HelperManager
    const backend = new UstcWebBackend(
      ctx, helper, {} as ModelCatalog, {} as StateStore,
      { complete } as unknown as IwanAuthenticator,
    )
    const snapshot = {} as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)

    await expect(backend.handle({ action: 'completeOidc', callbackUrl: 'callback' })).resolves.toEqual({
      servers: [{ id: 'line-one', name: 'Line One', endpoint: '1.2.3.4:6001' }],
      snapshot,
    })
    expect(set).toHaveBeenCalledWith(IWAN_CONFIG_REF, JSON.stringify(config))
    expect(stop).toHaveBeenCalledOnce()
  })

  it('clears the selected line and private iWAN credential when signing out', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const unset = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn().mockResolvedValue(undefined)
    const ctx = { settings: { mutate }, credentials: { unset } } as unknown as Context
    const helper = { stop } as unknown as HelperManager
    const backend = new UstcWebBackend(ctx, helper, {} as ModelCatalog, {} as StateStore)
    const snapshot = {} as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)

    await expect(backend.handle({ action: 'logoutIwan', expectedRevision: 7 })).resolves.toBe(snapshot)

    expect(mutate).toHaveBeenCalledWith(SETTINGS_NS, [{ op: 'unset', path: ['selectedServerId'] }], 7)
    expect(unset).toHaveBeenCalledWith(IWAN_CONFIG_REF)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('refreshes the active direct or iWAN route without passing the API key', async () => {
    const refreshRoute = vi.fn().mockResolvedValue(undefined)
    const ctx = {} as Context
    const helper = { refreshRoute } as unknown as HelperManager
    const backend = new UstcWebBackend(ctx, helper, {} as ModelCatalog, {} as StateStore)
    const snapshot = {} as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)

    await expect(backend.handle({ action: 'refreshRoute' })).resolves.toBe(snapshot)

    expect(refreshRoute).toHaveBeenCalledWith()
  })

  it('validates and applies a selected line through a helper restart', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        value: JSON.stringify({
          domain: 'iwan.ustc',
          servers: [{
            id: 'line-one', name: 'Line One', host: '1.2.3.4', port: 6001,
            username: 'user', passWord: 'encrypted-secret',
          }],
        }),
      })
    const update = vi.fn().mockResolvedValue(undefined)
    const rollback = vi.fn()
    const stageSelectedServer = vi.fn().mockReturnValue(rollback)
    const refreshRoute = vi.fn().mockResolvedValue(undefined)
    const ctx = { settings: { update }, credentials: { resolve } } as unknown as Context
    const helper = { stageSelectedServer, refreshRoute } as unknown as HelperManager
    const backend = new UstcWebBackend(ctx, helper, {} as ModelCatalog, {} as StateStore)
    const snapshot = {} as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)

    await expect(backend.handle({ action: 'selectServer', serverId: 'line-one', expectedRevision: 4 })).resolves.toBe(snapshot)
    expect(stageSelectedServer).toHaveBeenCalledWith('line-one')
    expect(update).toHaveBeenCalledWith(SETTINGS_NS, { selectedServerId: 'line-one' }, 4)
    expect(refreshRoute).toHaveBeenCalledWith()
    expect(rollback).not.toHaveBeenCalled()
  })
})
