describe('storage model actions', () => {
  let Storage
  let logger

  beforeEach(async () => {
    vi.resetModules()
    logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    }
    global.WIKI = {
      SERVERPATH: '/tmp/wiki-server',
      data: {
        storage: [{ key: 'git', props: {}, isAvailable: true, actions: [{ handler: 'sync' }] }]
      },
      logger,
      models: {
        storage: class {},
        knex: vi.fn(),
        Objection: {
          transaction: {
            start: vi.fn()
          }
        }
      }
    }
    Storage = (await import('../../models/storage.ts')).default
    global.WIKI.models.storage = Storage
  })

  it('runs declared actions and records an operational attempt', async () => {
    const sync = vi.fn().mockResolvedValue(undefined)
    const patch = vi.fn().mockResolvedValue(1)
    const target = {
      key: 'git',
      fn: { sync },
      $query: vi.fn(() => ({ patch }))
    }
    Storage.targets = [target]

    await expect(Storage.executeAction('git', 'sync')).resolves.toBeUndefined()

    expect(sync).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith({
      state: {
        status: 'operational',
        message: '',
        lastAttempt: expect.any(String)
      }
    })
  })

  it('rejects undeclared handlers before invoking the runtime plugin', async () => {
    const init = vi.fn().mockResolvedValue(undefined)
    const target = {
      key: 'git',
      fn: { init },
      $query: vi.fn()
    }
    Storage.targets = [target]

    await expect(Storage.executeAction('git', 'init')).rejects.toThrow('Invalid Handler for Storage Target')

    expect(init).not.toHaveBeenCalled()
    expect(target.$query).not.toHaveBeenCalled()
  })

  it('records action failures without hiding the action error', async () => {
    const actionError = new Error('sync failed')
    const sync = vi.fn().mockRejectedValue(actionError)
    const patch = vi.fn().mockResolvedValue(1)
    const target = {
      key: 'git',
      fn: { sync },
      $query: vi.fn(() => ({ patch }))
    }
    Storage.targets = [target]

    await expect(Storage.executeAction('git', 'sync')).rejects.toBe(actionError)

    expect(patch).toHaveBeenCalledWith({
      state: {
        status: 'error',
        message: 'sync failed',
        lastAttempt: expect.any(String)
      }
    })
    expect(logger.warn).toHaveBeenCalledWith(actionError)
  })

  it('continues mirroring pages after a target fails and records a warning', async () => {
    const mirrorError = new Error('disk full')
    const failedPatch = vi.fn().mockResolvedValue(1)
    const successfulPatch = vi.fn().mockResolvedValue(1)
    const failedTarget = {
      key: 'disk',
      state: { status: 'operational', message: '', lastAttempt: null },
      fn: { created: vi.fn().mockRejectedValue(mirrorError) },
      $query: vi.fn(() => ({ patch: failedPatch }))
    }
    const successfulTarget = {
      key: 'git',
      state: { status: 'warning', message: 'stale', lastAttempt: null },
      fn: { created: vi.fn().mockResolvedValue(undefined) },
      $query: vi.fn(() => ({ patch: successfulPatch }))
    }
    Storage.targets = [failedTarget, successfulTarget]
    const page = { path: 'guide', localeCode: 'en', contentType: 'markdown' }

    await expect(Storage.pageEvent({ event: 'created', page })).resolves.toBeUndefined()

    expect(successfulTarget.fn.created).toHaveBeenCalledWith(page)
    expect(failedPatch).toHaveBeenCalledWith({
      state: {
        status: 'warning',
        message: 'disk full',
        lastAttempt: expect.any(String)
      }
    })
    expect(successfulPatch).toHaveBeenCalledWith({
      state: {
        status: 'operational',
        message: '',
        lastAttempt: expect.any(String)
      }
    })
    expect(logger.warn).toHaveBeenCalledWith(mirrorError)
  })

  it('continues mirroring assets after a target fails', async () => {
    const mirrorError = new Error('remote unavailable')
    const failedPatch = vi.fn().mockResolvedValue(1)
    const successfulUpload = vi.fn().mockResolvedValue(undefined)
    const failedTarget = {
      key: 's3',
      state: { status: 'operational', message: '', lastAttempt: null },
      fn: { assetUploaded: vi.fn().mockRejectedValue(mirrorError) },
      $query: vi.fn(() => ({ patch: failedPatch }))
    }
    const successfulTarget = {
      key: 'disk',
      state: { status: 'operational', message: '', lastAttempt: null },
      fn: { assetUploaded: successfulUpload },
      $query: vi.fn()
    }
    Storage.targets = [failedTarget, successfulTarget]
    const asset = { path: 'images/logo.png', data: Buffer.from('image') }

    await expect(Storage.assetEvent({ event: 'uploaded', asset })).resolves.toBeUndefined()

    expect(successfulUpload).toHaveBeenCalledWith(asset)
    expect(failedPatch).toHaveBeenCalledWith({
      state: {
        status: 'warning',
        message: 'remote unavailable',
        lastAttempt: expect.any(String)
      }
    })
  })
})
