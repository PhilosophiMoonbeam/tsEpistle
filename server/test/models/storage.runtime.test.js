const template = Object.fromEntries(
  ['init', 'deactivated', 'created', 'updated', 'deleted', 'renamed', 'assetUploaded', 'assetDeleted', 'assetRenamed', 'getLocalLocation', 'sync', 'dump'].map(
    key => [key, vi.fn()]
  )
)
vi.mockModule('../../modules/storage/disk/storage.ts', import.meta.url, () => ({ default: template }))
vi.mockModule('../../modules/storage/sftp/storage.ts', import.meta.url, () => ({ default: template }))
describe('Storage runtime replacement and synchronization', () => {
  let Storage, rows, scheduler
  const row = (value = 'first') => ({
    key: 'disk',
    isEnabled: true,
    mode: 'push',
    syncInterval: 'P0D',
    config: { path: value, nested: { value } },
    state: { status: 'warning', message: 'previous', lastAttempt: null, lastOperation: { message: 'Keep the manual receipt' } },
    $query: vi.fn(() => ({ patch: vi.fn().mockResolvedValue(1) }))
  })
  beforeEach(async () => {
    for (const method of Object.values(template)) method.mockReset().mockResolvedValue(undefined)
    template.init.mockImplementation(async function () {
      this.initializedPath = this.config.path
      this.config.path += '-runtime'
    })
    rows = [row()]
    scheduler = { jobs: [], registerJob: vi.fn() }
    global.WIKI = {
      SERVERPATH: '/wiki/server',
      data: { storage: [{ key: 'disk', isAvailable: true, props: {}, schedule: false, internalSchedule: 'P1D', actions: [{ handler: 'dump' }] }] },
      scheduler,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      models: { storage: class {}, knex: vi.fn(), Objection: { transaction: { start: vi.fn() } } }
    }
    Storage = (await vi.importFresh('../../models/storage.ts', import.meta.url)).default
    global.WIKI.models.storage = Storage
    vi.spyOn(Storage, 'query').mockImplementation(() => ({ where: () => ({ orderBy: async () => rows }) }))
  })
  it('isolates template, row and runtime configuration and binds the declared internal interval to a generation', async () => {
    await Storage.initTargets()
    const first = Storage.targets[0],
      firstImplementation = first.fn
    expect(first.config.path).toBe('first')
    expect(firstImplementation.config.path).toBe('first-runtime')
    expect(template.config).toBeUndefined()
    expect(scheduler.registerJob).toHaveBeenCalledWith(
      { name: 'sync-storage', immediate: false, schedule: 'P1D', repeat: true },
      { targetKey: 'disk', generation: first.runtimeGeneration }
    )
    rows = [row('second')]
    await Storage.initTargets()
    const second = Storage.targets[0]
    expect(second.fn).not.toBe(firstImplementation)
    expect(second.fn.config.path).toBe('second-runtime')
    expect(firstImplementation.config.path).toBe('first-runtime')
    firstImplementation.config.nested.value = 'changed'
    expect(first.config.nested.value).toBe('first')
    expect(second.config.nested.value).toBe('second')
    expect(second.runtimeGeneration).not.toBe(first.runtimeGeneration)
    expect(template.deactivated).toHaveBeenCalledTimes(1)
  })

  it('forwards the persisted asset identity to active local providers', async () => {
    await Storage.initTargets()
    const identity = {
      id: 19,
      hash: 'asset-hash',
      path: 'docs/guide.txt',
      filename: 'guide.txt',
      folderId: 3
    }
    const location = { open: vi.fn() }
    template.getLocalLocation.mockResolvedValue(location)

    const locations = await Storage.getLocalLocations({ asset: identity })

    expect(template.getLocalLocation).toHaveBeenCalledWith(identity)
    expect(locations).toEqual([{ location, key: 'disk' }])
  })
  it('preserves the latest manual receipt during scheduled success and failure and ignores stale generations', async () => {
    await Storage.initTargets()
    const target = Storage.targets[0],
      receipt = target.state.lastOperation
    expect(await Storage.syncTarget('disk', 'stale')).toBe(false)
    expect(template.sync).not.toHaveBeenCalled()
    expect(await Storage.syncTarget('disk', target.runtimeGeneration)).toBe(true)
    expect(target.state.lastOperation).toEqual(receipt)
    template.sync.mockRejectedValueOnce(new Error('sync failure'))
    await expect(Storage.syncTarget('disk', target.runtimeGeneration)).rejects.toThrow('sync failure')
    expect(target.state).toMatchObject({ status: 'error', message: 'sync failure', lastOperation: receipt })
  })
  it('finishes an active action, replaces the runtime, and drains a cancelled stale timer without deadlock', async () => {
    await Storage.initTargets()
    const target = Storage.targets[0],
      gate = Promise.withResolvers()
    target.fn.dump = vi.fn(async () => {
      await gate.promise
    })
    const action = Storage.executeAction('disk', 'dump')
    await vi.waitFor(() => expect(target.fn.dump).toHaveBeenCalledTimes(1))
    let stale
    const stop = vi.fn(() => stale)
    scheduler.jobs = [{ name: 'sync-storage', stop }]
    rows = [row('replacement')]
    const replacement = Storage.initTargets()
    stale = Storage.syncTarget('disk', target.runtimeGeneration)
    gate.resolve()
    await action
    await replacement
    expect(await stale).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(Storage.activeTargets[0].config.path).toBe('replacement')
    expect(template.sync).not.toHaveBeenCalled()
  })
  it('closes partially initialized targets and keeps failed targets out of active event dispatch', async () => {
    template.init.mockRejectedValueOnce(new Error('connection failed'))
    await Storage.initTargets()
    expect(Storage.activeTargets).toHaveLength(0)
    expect(template.deactivated).toHaveBeenCalledTimes(1)
    await Storage.pageEvent({ event: 'created', page: { path: 'guide' } })
    expect(template.created).not.toHaveBeenCalled()
  })
  it('retains the active runtime when the replacement configuration cannot be read', async () => {
    await Storage.initTargets()
    const active = Storage.activeTargets[0]
    Storage.query.mockImplementationOnce(() => ({
      where: () => ({
        orderBy: async () => {
          throw Error('database unavailable')
        }
      })
    }))
    await expect(Storage.initTargets()).rejects.toThrow('database unavailable')
    expect(Storage.activeTargets).toEqual([active])
    expect(template.deactivated).not.toHaveBeenCalled()
  })
  it('quarantines and unschedules a target when its second timer registration fails', async () => {
    global.WIKI.data.storage[0].schedule = 'PT1M'
    rows[0].syncInterval = 'PT1M'
    const job = { name: 'sync-storage', stop: vi.fn().mockResolvedValue(undefined) }
    scheduler.registerJob
      .mockImplementationOnce(() => {
        scheduler.jobs.push(job)
        return job
      })
      .mockImplementationOnce(() => {
        throw Error('timer registration failed')
      })
    await Storage.initTargets()
    expect(Storage.activeTargets).toHaveLength(0)
    expect(scheduler.jobs).toHaveLength(0)
    expect(job.stop).toHaveBeenCalledTimes(1)
    expect(template.deactivated).toHaveBeenCalledTimes(1)
    expect(rows[0].state.status).toBe('error')
  })
  it('owns the runtime through the reviewed effect and durable receipt', async () => {
    await Storage.initTargets()
    const events = [],
      gate = Promise.withResolvers()
    template.dump.mockImplementation(async () => {
      events.push('effect')
    })
    template.created.mockImplementation(async () => {
      events.push('page')
    })
    const operation = Storage.performAdministrativeOperation(
      async () => {
        events.push('review')
        return { targetKey: 'disk', handler: 'dump' }
      },
      async result => {
        events.push('receipt')
        await gate.promise
        return result
      }
    )
    await vi.waitFor(() => expect(events).toEqual(['review', 'effect', 'receipt']))
    const page = Storage.pageEvent({ event: 'created', page: { path: 'guide' } })
    await Promise.resolve()
    expect(events).toEqual(['review', 'effect', 'receipt'])
    gate.resolve()
    await operation
    await page
    expect(events).toEqual(['review', 'effect', 'receipt', 'page'])
    await expect(
      Storage.performAdministrativeOperation(
        async () => {
          throw Error('review changed')
        },
        async () => undefined
      )
    ).rejects.toThrow('review changed')
    expect(template.dump).toHaveBeenCalledTimes(1)
  })
  it('drains stale timers outside reviewed activation and returns the actual active runtime', async () => {
    await Storage.initTargets()
    const generation = Storage.targets[0].runtimeGeneration
    const gate = Promise.withResolvers()
    let stale
    scheduler.jobs = [{ name: 'sync-storage', stop: vi.fn(() => stale) }]
    const operation = Storage.performAdministrativeOperation(
      async () => {
        await gate.promise
        return { targetKey: null, handler: 'activate' }
      },
      async result => result
    )
    stale = Storage.syncTarget('disk', generation)
    gate.resolve()
    const result = await operation
    expect(await stale).toBe(false)
    expect(result[0]).toMatchObject({ key: 'disk', active: true, paused: false })
    expect(result[0].generation).not.toBe(generation)
  })
  it('pauses remote initialization in offline mode while retaining local disk service', async () => {
    global.WIKI.config = { offline: true }
    global.WIKI.data.storage.push({ key: 'sftp', isAvailable: true, props: {}, schedule: false, actions: [{ handler: 'dump' }] })
    rows.push({ ...row('remote'), key: 'sftp' })
    await Storage.initTargets()
    expect(template.init).toHaveBeenCalledTimes(1)
    expect(Storage.activeTargets.map(target => target.key)).toEqual(['disk'])
    expect(Storage.runtimeTargets().find(target => target.key === 'sftp')).toMatchObject({ active: false, paused: true })
    expect(rows[1].state.status).toBe('paused')
  })
  it('stops new remote effects immediately when offline policy changes', async () => {
    global.WIKI.config = { offline: false }
    global.WIKI.data.storage = [{ key: 'sftp', isAvailable: true, props: {}, schedule: false, actions: [{ handler: 'dump' }] }]
    rows = [{ ...row('remote'), key: 'sftp' }]
    await Storage.initTargets()
    const generation = rows[0].runtimeGeneration
    global.WIKI.config.offline = true
    await Storage.pageEvent({ event: 'created', page: { path: 'guide' } })
    await Storage.assetEvent({ event: 'uploaded', asset: { path: 'asset' } })
    expect(await Storage.syncTarget('sftp', generation)).toBe(false)
    await expect(Storage.executeAction('sftp', 'dump')).rejects.toThrow('paused in offline mode')
    for (const method of ['created', 'assetUploaded', 'sync', 'dump']) expect(template[method]).not.toHaveBeenCalled()
  })

  it('does not initialize enabled targets unavailable in this build', async () => {
    global.WIKI.data.storage[0].isAvailable = false
    await Storage.initTargets()
    expect(template.init).not.toHaveBeenCalled()
    expect(Storage.activeTargets).toHaveLength(0)
    expect(rows[0].state.status).toBe('error')
  })
})
