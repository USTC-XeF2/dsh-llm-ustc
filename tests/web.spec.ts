import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { IWAN_CONFIG_REF, SETTINGS_NS } from '../src/constants.ts'
import type { HelperManager } from '../src/helper.ts'
import type { ModelCatalog } from '../src/model-catalog.ts'
import type { StateStore } from '../src/state.ts'
import { publicIwanServers, publicMessage, UstcWebBackend, type SettingsSnapshot } from '../src/web.ts'

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
  it('clears the selected line and private iWAN credential when signing out', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const unset = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn().mockResolvedValue(undefined)
    const status = vi.fn().mockResolvedValue({ route: 'direct' })
    const ctx = { settings: { mutate }, credentials: { unset } } as unknown as Context
    const helper = { stop, status } as unknown as HelperManager
    const backend = new UstcWebBackend(ctx, helper, {} as ModelCatalog, {} as StateStore)
    const snapshot = {} as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)

    await expect(backend.handle({ action: 'logoutIwan', expectedRevision: 7 })).resolves.toBe(snapshot)

    expect(mutate).toHaveBeenCalledWith(SETTINGS_NS, [{ op: 'unset', path: ['selectedServerId'] }], 7)
    expect(unset).toHaveBeenCalledWith(IWAN_CONFIG_REF)
    expect(stop).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(status.mock.invocationCallOrder[0]!)
  })

  it('rechecks the active direct or iWAN route with the configured API key', async () => {
    const resolve = vi.fn().mockResolvedValue({ value: ' ustc-key ' })
    const refreshRoute = vi.fn().mockResolvedValue({ route: 'iwan' })
    const ctx = { credentials: { resolve } } as unknown as Context
    const helper = { refreshRoute } as unknown as HelperManager
    const backend = new UstcWebBackend(ctx, helper, {} as ModelCatalog, {} as StateStore)
    const snapshot = {} as SettingsSnapshot
    vi.spyOn(backend, 'snapshot').mockResolvedValue(snapshot)

    await expect(backend.handle({ action: 'refreshRoute' })).resolves.toBe(snapshot)

    expect(refreshRoute).toHaveBeenCalledWith('ustc-key')
  })
})
