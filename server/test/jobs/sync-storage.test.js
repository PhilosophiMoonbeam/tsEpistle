const template = Object.fromEntries(
  ['init', 'deactivated', 'created', 'updated', 'deleted', 'renamed', 'assetUploaded', 'assetDeleted', 'assetRenamed', 'getLocalLocation', 'sync'].map(
    key => [key, vi.fn()]
  )
)
vi.mockModule('../../modules/storage/disk/storage.ts', import.meta.url, () => ({ default: template }))
const originalWiki = global.WIKI
afterEach(() => {
  global.WIKI = originalWiki
})
describe('scheduled storage dispatch', () => {
  let run, syncTarget, info
  beforeEach(async () => {
    syncTarget = vi.fn().mockResolvedValue(true)
    info = vi.fn()
    global.WIKI = { models: { storage: { syncTarget } }, logger: { info } }
    run = (await vi.importFresh('../../jobs/sync-storage.ts', import.meta.url)).default
  })
  it('requires generation-bound payloads and never invokes legacy bare target names', async () => {
    for (const input of ['disk', null, { targetKey: 'disk' }, { targetKey: 1, generation: 'old' }]) {
      await expect(run(input)).rejects.toThrow(TypeError)
    }
    expect(syncTarget).not.toHaveBeenCalled()
  })
  it('ignores an old scheduled generation after replacement and synchronizes the current runtime', async () => {
    for (const method of Object.values(template)) method.mockReset().mockResolvedValue(undefined)
    const synchronizedPaths = []
    template.sync.mockImplementation(async function () {
      synchronizedPaths.push(this.config.path)
    })
    const row = path => ({
      key: 'disk',
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: { path },
      state: { status: 'warning', message: 'previous', lastAttempt: null, lastOperation: { message: 'Keep the manual receipt' } },
      $query: vi.fn(() => ({ patch: vi.fn().mockResolvedValue(1) }))
    })
    let rows = [row('first')]
    global.WIKI = {
      SERVERPATH: '/wiki/server',
      data: { storage: [{ key: 'disk', isAvailable: true, props: {}, schedule: false, internalSchedule: 'P1D', actions: [] }] },
      scheduler: { jobs: [], registerJob: vi.fn() },
      logger: { warn: vi.fn(), info, error: vi.fn() },
      models: { storage: class {}, knex: vi.fn(), Objection: { transaction: { start: vi.fn() } } }
    }
    const Storage = (await vi.importFresh('../../models/storage.ts', import.meta.url)).default
    global.WIKI.models.storage = Storage
    vi.spyOn(Storage, 'query').mockImplementation(() => ({ where: () => ({ orderBy: async () => rows }) }))
    run = (await vi.importFresh('../../jobs/sync-storage.ts', import.meta.url)).default
    await Storage.initTargets()
    const first = Storage.activeTargets[0]
    expect(first).toBeDefined()
    rows = [row('replacement')]
    await Storage.initTargets()
    const current = Storage.activeTargets[0]
    expect(current).toBeDefined()
    expect(current.runtimeGeneration).not.toBe(first.runtimeGeneration)
    const stateBeforeStaleJob = structuredClone(current.state)
    current.$query.mockClear()

    await run({ targetKey: 'disk', generation: first.runtimeGeneration })
    expect(template.sync).not.toHaveBeenCalled()
    expect(synchronizedPaths).toEqual([])
    expect(current.state).toEqual(stateBeforeStaleJob)
    expect(current.$query).not.toHaveBeenCalled()

    await run({ targetKey: 'disk', generation: current.runtimeGeneration })
    expect(synchronizedPaths).toEqual(['replacement'])
    expect(current.state).toMatchObject({
      status: 'operational',
      message: '',
      lastOperation: stateBeforeStaleJob.lastOperation
    })
  })
  it('propagates failed synchronization so scheduler observations do not report success', async () => {
    syncTarget.mockRejectedValueOnce(new Error('sync failed'))
    await expect(run({ targetKey: 'disk', generation: 'current' })).rejects.toThrow('sync failed')
  })
})
