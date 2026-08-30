import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
const migrateToLocale = vi.fn(async (_input: unknown) => 2)
interface SystemOperations {
  migratePagesToLocale(input: unknown): Promise<number>
}
let systemOperations: SystemOperations

beforeEach(async () => {
  vi.resetModules()
  migrateToLocale.mockReset()
  migrateToLocale.mockResolvedValue(2)
  wikiGlobal.WIKI = {
    ROOTPATH: '/tmp/wiki',
    version: 'test',
    product: { version: 'test' },
    models: {
      groups: {},
      pages: { migrateToLocale },
      users: {},
      tags: {},
      assets: {},
      pageHistory: {},
      knex: { client: {} }
    },
    system: { exportStatus: {} },
    config: { flags: {}, db: {}, telemetry: {}, server: {}, ssl: {} },
    configSvc: {},
    telemetry: {},
    servers: { servers: {} },
    extensions: { ext: {} },
    events: { outbound: { emit: vi.fn() } },
    Error: {}
  }
  // system.ts captures WIKI during evaluation, so the test intentionally imports a fresh module after installing its isolated global.
  systemOperations = (await vi.importFresh('../../operations/system.ts', import.meta.url)).default
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

describe('operations/system locale migration', () => {
  it('passes the authenticated administrator through the aggregate boundary', async () => {
    const requester = { id: 19, name: 'Administrator', email: 'admin@example.com', permissions: ['manage:system'] } as Express.User

    await expect(systemOperations.migratePagesToLocale({ sourceLocale: 'en', targetLocale: 'fr', requester })).resolves.toBe(2)

    expect(migrateToLocale).toHaveBeenCalledWith({ sourceLocale: 'en', targetLocale: 'fr', user: requester })
  })
  it('rejects a locale migration without an authenticated actor', () => {
    expect(() => systemOperations.migratePagesToLocale({ sourceLocale: 'en', targetLocale: 'fr' })).toThrow('Authentication is required')
    expect(migrateToLocale).not.toHaveBeenCalled()
  })
})
