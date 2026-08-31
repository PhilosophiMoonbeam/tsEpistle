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
    Storage = (await vi.importFresh('../../models/storage.ts', import.meta.url)).default
    global.WIKI.models.storage = Storage
  })

  it('runs declared actions, returns a summary, and records the completion', async () => {
    const sync = vi.fn().mockResolvedValue([
      { kind: 'page', path: 'docs/storage', outcome: 'succeeded', format: 'okf' }
    ])
    const patch = vi.fn().mockResolvedValue(1)
    const target = {
      key: 'git',
      fn: { sync },
      $query: vi.fn(() => ({ patch }))
    }
    Storage.targets = [target]

    const summary = await Storage.executeAction('git', 'sync')

    expect(summary).toEqual({
      targetKey: 'git',
      handler: 'sync',
      outcome: 'succeeded',
      total: 1,
      succeeded: 1,
      failed: 0,
      formats: {
        okf: 1,
        legacyV1: 0,
        legacyWiki: 0,
        plain: 0,
        invalid: 0
      },
      items: [{
        kind: 'page',
        path: 'docs/storage',
        outcome: 'succeeded',
        format: 'okf',
        message: null,
        diagnostics: []
      }],
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      message: 'Action completed.'
    })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith({
      state: {
        status: 'operational',
        message: '',
        lastAttempt: expect.any(String),
        lastOperation: summary
      }
    })
  })

  it('persists each repeated action completion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T03:00:00.000Z'))
    try {
      const sync = vi.fn().mockResolvedValue(undefined)
      const patch = vi.fn().mockResolvedValue(1)
      const target = {
        key: 'git',
        state: {
          status: 'operational',
          message: '',
          lastAttempt: '2026-08-29T02:58:00.000Z'
        },
        fn: { sync },
        $query: vi.fn(() => ({ patch }))
      }
      Storage.targets = [target]

      const firstSummary = await Storage.executeAction('git', 'sync')
      vi.setSystemTime(new Date('2026-08-29T03:00:01.000Z'))
      const secondSummary = await Storage.executeAction('git', 'sync')

      expect(firstSummary).toEqual({
        targetKey: 'git',
        handler: 'sync',
        outcome: 'succeeded',
        total: 0,
        succeeded: 0,
        failed: 0,
        formats: {
          okf: 0,
          legacyV1: 0,
          legacyWiki: 0,
          plain: 0,
          invalid: 0
        },
        items: [],
        startedAt: '2026-08-29T03:00:00.000Z',
        completedAt: '2026-08-29T03:00:00.000Z',
        message: 'Action completed.'
      })
      expect(secondSummary).toEqual({
        targetKey: 'git',
        handler: 'sync',
        outcome: 'succeeded',
        total: 0,
        succeeded: 0,
        failed: 0,
        formats: {
          okf: 0,
          legacyV1: 0,
          legacyWiki: 0,
          plain: 0,
          invalid: 0
        },
        items: [],
        startedAt: '2026-08-29T03:00:01.000Z',
        completedAt: '2026-08-29T03:00:01.000Z',
        message: 'Action completed.'
      })
      expect(sync).toHaveBeenCalledTimes(2)
      expect(patch).toHaveBeenCalledTimes(2)
      expect(patch).toHaveBeenNthCalledWith(1, {
        state: {
          status: 'operational',
          message: '',
          lastAttempt: '2026-08-29T03:00:00.000Z',
          lastOperation: firstSummary
        }
      })
      expect(patch).toHaveBeenNthCalledWith(2, {
        state: {
          status: 'operational',
          message: '',
          lastAttempt: '2026-08-29T03:00:01.000Z',
          lastOperation: secondSummary
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects undeclared handlers before invoking the runtime plugin', async () => {
    const init = vi.fn().mockResolvedValue(undefined)
    const target = {
      key: 'git',
      fn: { init },
      $query: vi.fn()
    }
    Storage.targets = [target]

    await expect(Promise.resolve(Storage.executeAction('git', 'init'))).rejects.toThrow('Invalid Handler for Storage Target')

    expect(init).not.toHaveBeenCalled()
    expect(target.$query).not.toHaveBeenCalled()
  })

  it('resolves action failures as failed summaries and records the message', async () => {
    const actionError = new Error('sync failed')
    const sync = vi.fn().mockRejectedValue(actionError)
    const patch = vi.fn().mockResolvedValue(1)
    const target = {
      key: 'git',
      fn: { sync },
      $query: vi.fn(() => ({ patch }))
    }
    Storage.targets = [target]

    const summary = await Storage.executeAction('git', 'sync')

    expect(summary).toEqual({
      targetKey: 'git',
      handler: 'sync',
      outcome: 'failed',
      total: 0,
      succeeded: 0,
      failed: 0,
      formats: {
        okf: 0,
        legacyV1: 0,
        legacyWiki: 0,
        plain: 0,
        invalid: 0
      },
      items: [],
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      message: 'sync failed'
    })
    expect(patch).toHaveBeenCalledWith({
      state: {
        status: 'error',
        message: 'sync failed',
        lastAttempt: expect.any(String),
        lastOperation: summary
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
    Storage.activeTargets = [failedTarget, successfulTarget]
    const page = { path: 'guide', localeCode: 'en', contentType: 'markdown' }

    expect(await Storage.pageEvent({ event: 'created', page })).toBeUndefined()

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
    Storage.activeTargets = [failedTarget, successfulTarget]
    const asset = { path: 'images/logo.png', data: Buffer.from('image') }

    expect(await Storage.assetEvent({ event: 'uploaded', asset })).toBeUndefined()

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
