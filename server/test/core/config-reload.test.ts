import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as ConfigModule from '../../core/config.ts'

describe('distributed config reload', () => {
  const previousWiki = globalThis.WIKI

  afterEach(() => {
    globalThis.WIKI = previousWiki
    vi.restoreAllMocks()
  })

  it('updates the canonical config object retained by app locals', async () => {
    vi.resetModules()
    let reloadListener: (() => Promise<void>) | undefined
    const canonicalConfig = {
      db: { pass: 'initial-secret' },
      flags: { sqllog: false },
      port: 3000,
      title: 'Before reload'
    }
    const appLocals = { config: canonicalConfig }
    const knexConfig = { debug: false }
    const getConfig = vi.fn().mockResolvedValue({
      db: { pass: 'reloaded-secret' },
      flags: { sqllog: true },
      port: 4000,
      title: 'After reload'
    })

    globalThis.WIKI = {
      config: canonicalConfig,
      events: {
        inbound: {
          on: vi.fn((_event: string, listener: () => Promise<void>) => {
            reloadListener = listener
          })
        },
        outbound: { emit: vi.fn() }
      },
      logger: { error: vi.fn(), warn: vi.fn() },
      models: {
        knex: { client: { config: knexConfig } },
        settings: { getConfig, query: vi.fn() }
      },
      product: { name: 'tsEpistle' }
    } as typeof globalThis.WIKI

    const { default: configService } = await vi.importFresh<typeof ConfigModule>('../../core/config.ts', import.meta.url)
    globalThis.WIKI.configSvc = configService
    configService.subscribeToEvents()
    if (!reloadListener) throw new Error('reloadConfig listener was not registered')

    await reloadListener()

    expect(globalThis.WIKI.config).toBe(canonicalConfig)
    expect(appLocals.config).toBe(canonicalConfig)
    expect(appLocals.config).toMatchObject({
      db: { pass: 'reloaded-secret' },
      flags: { sqllog: true },
      port: 4000,
      title: 'After reload'
    })
    expect(knexConfig.debug).toBe(true)
  })
})
