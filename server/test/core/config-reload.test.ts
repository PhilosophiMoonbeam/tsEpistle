import type * as ConfigModule from '../../core/config.ts'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

const signingConfiguration = {
  certs: { private: 'fixture-private-key', public: 'fixture-public-key' },
  sessionSecret: 'fixture-session-secret',
  offlineDraftSecret: 'fixture-offline-draft-secret'
}

const configured = (value: Record<string, unknown>): Record<string, unknown> => ({ ...signingConfiguration, ...value })

describe('distributed config reload', () => {
  const previousWiki = globalThis.WIKI

  afterEach(() => {
    globalThis.WIKI = previousWiki
    vi.restoreAllMocks()
  })

  it('keeps a migration-seeded empty database in first-run setup mode', async () => {
    vi.resetModules()
    const canonicalConfig = { db: { pass: 'fixture' }, flags: { ldapdebug: false, sqllog: false }, port: 3000 }
    globalThis.WIKI = {
      config: canonicalConfig,
      logger: { error: vi.fn(), warn: vi.fn() },
      models: {
        settings: {
          getConfig: vi.fn().mockResolvedValue({
            analyticsAdministration: {},
            mailAdministration: {},
            sslAdministration: {},
            storageAdministration: {}
          })
        }
      }
    } as typeof globalThis.WIKI

    const { default: configService } = await vi.importFresh<typeof ConfigModule>('../../core/config.ts', import.meta.url)
    await configService.loadFromDb()

    expect(canonicalConfig.setup).toBe(true)
    expect(canonicalConfig).not.toHaveProperty('sslAdministration')
  })

  it.each([
    ['enabled', true, 1],
    ['disabled', false, false]
  ] as const)('applies %s one-hop proxy trust while preserving canonical config identity', async (_label, securityTrustProxy, expectedTrustProxy) => {
    vi.resetModules()
    let reloadListener: (() => Promise<void>) | undefined
    const canonicalConfig = {
      db: { pass: 'initial-secret' },
      flags: { ldapdebug: false, sqllog: false },
      security: { securityTrustProxy: !securityTrustProxy },
      port: 3000,
      title: 'Before reload',
      host: 'https://before.example.com',
      banner: { isEnabled: true, title: 'Previous notice', content: '', tone: 'info', startsAt: '2026-09-08T10:00:00Z', endsAt: '2026-09-08T12:00:00Z' },
      auth: { audience: 'old-audience' },
      pageExtensions: ['md', 'html', 'txt'],
      seo: { robots: ['index', 'follow'], description: 'Keep missing defaults' }
    }
    const appLocals = { config: canonicalConfig }
    const setAppSetting = vi.fn()
    const knexConfig = { debug: false }
    const getConfig = vi.fn().mockResolvedValue(
      configured({
        db: { pass: 'reloaded-secret' },
        flags: { ldapdebug: true, sqllog: true },
        security: { securityTrustProxy },
        port: 4000,
        title: 'After reload',
        host: 'https://after.example.com',
        banner: { isEnabled: false, title: '', content: '' },
        auth: { audience: 'new-audience' },
        pageExtensions: ['md'],
        seo: { robots: [] }
      })
    )

    const auth = {
      jwtAudience: 'old-audience',
      strategyHost: 'https://before.example.com',
      activateStrategies: vi.fn(async () => {
        auth.jwtAudience = 'new-audience'
        auth.strategyHost = canonicalConfig.host
      })
    }
    globalThis.WIKI = {
      auth,
      app: { locals: appLocals, set: setAppSetting },
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
      flags: { ldapdebug: true, sqllog: true },
      security: { securityTrustProxy },
      port: 4000,
      title: 'After reload',
      host: 'https://after.example.com',
      banner: { isEnabled: false, title: '', content: '' },
      pageExtensions: ['md'],
      seo: { robots: [], description: 'Keep missing defaults' }
    })
    expect(canonicalConfig.banner).toEqual({ isEnabled: false, title: '', content: '' })
    expect(knexConfig.debug).toBe(true)
    expect(setAppSetting.mock.calls).toEqual([['trust proxy', expectedTrustProxy]])
    expect(auth.activateStrategies).toHaveBeenCalledOnce()
    await reloadListener()
    expect(auth.activateStrategies).toHaveBeenCalledOnce()
    getConfig.mockResolvedValue({ ...globalThis.WIKI.config, host: 'https://third.example.com' })
    await reloadListener()
    expect(auth.activateStrategies).toHaveBeenCalledTimes(2)
  })

  it('does not activate developer diagnostics staged outside the active flags setting', async () => {
    vi.resetModules()
    let reloadListener: (() => Promise<void>) | undefined
    const canonicalConfig = { db: { pass: 'initial-secret' }, flags: { ldapdebug: false, sqllog: false }, port: 3000 }
    const knexConfig = { debug: false }
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
        settings: {
          getConfig: vi.fn().mockResolvedValue(
            configured({
              db: { pass: 'reloaded-secret' },
              flags: { ldapdebug: false, sqllog: false },
              developerFlagsAdministration: { policy: { ldapdebug: true, sqllog: true } },
              port: 3000
            })
          ),
          query: vi.fn()
        }
      },
      product: { name: 'tsEpistle' }
    } as typeof globalThis.WIKI

    const { default: configService } = await vi.importFresh<typeof ConfigModule>('../../core/config.ts', import.meta.url)
    globalThis.WIKI.configSvc = configService
    configService.subscribeToEvents()
    if (!reloadListener) throw new Error('reloadConfig listener was not registered')
    await reloadListener()

    expect(canonicalConfig.flags).toEqual({ ldapdebug: false, sqllog: false })
    expect(knexConfig.debug).toBe(false)
  })

  it('serializes overlapping peer reloads so an older read cannot overwrite the newer applied flags', async () => {
    vi.resetModules()
    let reloadListener: (() => Promise<void>) | undefined
    let resolveFirstRead: ((value: unknown) => void) | undefined
    const firstRead = new Promise<unknown>(resolve => {
      resolveFirstRead = resolve
    })
    const canonicalConfig = { db: { pass: 'initial-secret' }, flags: { ldapdebug: false, sqllog: false }, port: 3000 }
    const knexConfig = { debug: false }
    const getConfig = vi
      .fn()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValueOnce(configured({ db: { pass: 'next-secret' }, flags: { ldapdebug: false, sqllog: true }, port: 3000 }))
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
    if (!reloadListener || !resolveFirstRead) throw new Error('reloadConfig listener was not registered')

    const first = reloadListener()
    await Promise.resolve()
    const second = reloadListener()
    expect(getConfig).toHaveBeenCalledTimes(1)
    resolveFirstRead(configured({ db: { pass: 'stale-secret' }, flags: { ldapdebug: true, sqllog: false }, port: 3000 }))
    await Promise.all([first, second])

    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(canonicalConfig.flags).toEqual({ ldapdebug: false, sqllog: true })
    expect(knexConfig.debug).toBe(true)
  })

  it.each([1, '1', 65535, '65535'])('normalizes a complete saved HTTP port override %j on the canonical configuration', async port => {
    const canonicalConfig = { port: 3000, retained: true }
    const savedConfig = configured({ port })
    const persistedChanges = new Map<string, unknown>()
    const logger = { error: vi.fn(), warn: vi.fn() }
    const emit = vi.fn()
    globalThis.WIKI = {
      config: canonicalConfig,
      models: {
        settings: {
          getConfig: async () => savedConfig,
          query: () => ({
            patch: ({ value }: { value: unknown }) => ({
              where: async (column: string, key: string) => {
                expect(column).toBe('key')
                if (!Object.hasOwn(savedConfig, key) && !persistedChanges.has(key)) return 0
                persistedChanges.set(key, value)
                return 1
              }
            }),
            insert: async ({ key, value }: { key: string; value: unknown }) => {
              persistedChanges.set(key, value)
            }
          })
        }
      },
      logger,
      events: { outbound: { emit } },
      product: { name: 'tsEpistle' }
    } as typeof globalThis.WIKI
    const { default: configService } = await vi.importFresh<typeof ConfigModule>('../../core/config.ts', import.meta.url)
    await configService.loadFromDb()
    expect(globalThis.WIKI.config).toBe(canonicalConfig)
    expect(canonicalConfig.port).toBe(Number(port))
    expect(canonicalConfig.retained).toBe(true)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    // An installation-level environment override legitimately persists its missing DB row during reload.
    const siteId = process.env.OFFLINE_DRAFT_SITE_ID?.trim()
    expect(Object.fromEntries(persistedChanges)).toEqual(siteId ? { offlineDraftSiteId: { v: siteId } } : {})
  })

  it.each([0, -1, 65536, 1.5, NaN, Infinity, 'private-invalid-value', null, true, {}])(
    'rejects invalid saved HTTP port %j before publishing any overlay',
    async port => {
      const canonicalConfig = { port: 3000, title: 'Unchanged' }
      globalThis.WIKI = {
        config: canonicalConfig,
        models: { settings: { getConfig: async () => configured({ port, title: 'Must not publish', sessionSecret: 'private-session-secret' }) } },
        product: { name: 'tsEpistle' }
      } as typeof globalThis.WIKI
      const { default: configService } = await vi.importFresh<typeof ConfigModule>('../../core/config.ts', import.meta.url)
      await expect(configService.loadFromDb()).rejects.toThrow('Invalid HTTP listener port from saved setting "port": expected an integer from 1 to 65535.')
      expect(canonicalConfig).toEqual({ port: 3000, title: 'Unchanged' })
    }
  )
})
