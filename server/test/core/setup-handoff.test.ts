import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as KernelModule from '../../core/kernel.ts'

describe('setup handoff', () => {
  const previousWiki = globalThis.WIKI

  afterEach(() => {
    globalThis.WIKI = previousWiki
    vi.restoreAllMocks()
  })

  it('continues directly into master once and drains workers before database teardown', async () => {
    vi.resetModules()
    const order: string[] = []
    const setupFinished = Promise.withResolvers<void>()
    const workerDrain = Promise.withResolvers<void>()
    const workers = {
      start: vi.fn(() => order.push('workers-start')),
      shutdown: vi.fn(async () => {
        order.push('workers-stop')
        await workerDrain.promise
        order.push('workers-drained')
      })
    }
    const method = (name: string) =>
      vi.fn(async () => {
        order.push(name)
      })
    const models = {
      onReady: Promise.resolve(),
      analytics: { refreshProvidersFromDisk: method('analytics-ready') },
      authentication: { refreshStrategiesFromDisk: method('authentication-ready') },
      commentProviders: {
        refreshProvidersFromDisk: method('comments-ready'),
        initProvider: method('comments-start')
      },
      editors: { refreshEditorsFromDisk: method('editors-ready') },
      loggers: { refreshLoggersFromDisk: method('loggers-ready') },
      renderers: { refreshRenderersFromDisk: method('renderers-ready') },
      searchEngines: {
        refreshSearchEnginesFromDisk: method('search-ready'),
        initEngine: method('search-start')
      },
      storage: {
        refreshTargetsFromDisk: method('storage-ready'),
        initTargets: method('storage-start')
      },
      subscribeToNotifications: method('notifications-start'),
      unsubscribeToNotifications: method('notifications-stop'),
      knex: { destroy: method('database-stop') }
    }
    const setup = vi.fn(async () => {
      order.push('setup-start')
      await setupFinished.promise
      order.push('setup-finished')
    })
    const master = vi.fn(async (wiki: Record<string, unknown>) => {
      order.push('master-compose')
      wiki.backgroundWorkers = workers
      return true as const
    })
    const schedulerService = { start: vi.fn(() => order.push('scheduler-start')), stop: method('scheduler-stop') }
    const servers = { stopServers: method('servers-stop') }
    const telemetry = { init: vi.fn(() => order.push('telemetry-init')) }

    vi.mockModule('../../core/db.ts', import.meta.url, () => ({
      default: { init: vi.fn().mockResolvedValue(models), knex: models.knex }
    }))
    vi.mockModule('../../core/asar.ts', import.meta.url, () => ({ default: { unload: method('asar-stop') } }))
    vi.mockModule('../../core/cache.ts', import.meta.url, () => ({ default: { init: vi.fn(() => ({})) } }))
    vi.mockModule('../../core/collaboration.ts', import.meta.url, () => ({
      default: { init: vi.fn(() => ({ dispose: method('collaboration-stop') })) }
    }))
    vi.mockModule('../../core/extensions.ts', import.meta.url, () => ({ default: { init: method('extensions-ready') } }))
    vi.mockModule('../../core/metrics.ts', import.meta.url, () => ({ default: { init: vi.fn().mockResolvedValue({}) } }))
    vi.mockModule('../../core/scheduler.ts', import.meta.url, () => ({ default: { init: vi.fn(() => schedulerService) } }))
    vi.mockModule('../../core/sideloader.ts', import.meta.url, () => ({ default: { init: vi.fn().mockResolvedValue({}) } }))
    vi.mockModule('../../core/telemetry.ts', import.meta.url, () => ({ default: telemetry }))
    vi.mockModule('../../core/servers.ts', import.meta.url, () => ({ default: vi.fn(() => servers) }))
    vi.mockModule('../../setup.ts', import.meta.url, () => ({ default: setup }))
    vi.mockModule('../../master.ts', import.meta.url, () => ({ default: master }))

    globalThis.WIKI = {
      IS_DEBUG: false,
      auth: { activateStrategies: method('auth-start') },
      config: { setup: true },
      configSvc: { loadFromDb: method('config-load'), applyFlags: method('config-flags') },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      product: {
        name: 'tsEpistle',
        version: '1.0.0',
        upstreamBase: 'upstream',
        revision: 'revision',
        sourceUrl: 'source'
      },
      telemetry,
      version: '1.0.0'
    } as typeof globalThis.WIKI

    const { default: kernel } = await vi.importFresh<typeof KernelModule>('../../core/kernel.ts', import.meta.url)
    const initializing = kernel.init()
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1))
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    expect(telemetry.init).toHaveBeenCalledTimes(1)
    expect(master).not.toHaveBeenCalled()
    expect(workers.start).not.toHaveBeenCalled()

    setupFinished.resolve()
    await initializing
    expect(setTimeoutSpy).not.toHaveBeenCalled()

    expect(setup).toHaveBeenCalledTimes(1)
    expect(master).toHaveBeenCalledTimes(1)
    expect(workers.start).toHaveBeenCalledTimes(1)
    expect(order.indexOf('workers-start')).toBeGreaterThan(order.indexOf('notifications-start'))

    const shutdown = kernel.shutdown()
    await vi.waitFor(() => expect(workers.shutdown).toHaveBeenCalledTimes(1))
    expect(models.knex.destroy).not.toHaveBeenCalled()

    workerDrain.resolve()
    await shutdown

    expect(order.indexOf('database-stop')).toBeGreaterThan(order.indexOf('workers-drained'))
  })
})
