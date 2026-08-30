vi.mockModule('express', import.meta.url, () => {
  const router = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    use: vi.fn()
  }

  const expressMock = {
    Router: () => router,
    __router: router
  }

  return { default: expressMock, ...expressMock }
})

import { createProductMetadata } from '../../core/product.ts'

vi.mockModule('../../operations/import-v1.ts', import.meta.url, () => ({
  default: {
  importUsers: vi.fn().mockResolvedValue({
    usersCount: 4,
    groupsCount: 2,
    failed: [{ provider: 'local', email: 'failed@example.com', error: 'duplicate' }]
  })
  }
}))
vi.mockModule('getos', import.meta.url, () => ({ default: vi.fn((cb) => cb(null, {
  dist: 'Ubuntu',
  codename: 'noble',
  release: '24.04.1'
})) }))
vi.mockModule('node:os', import.meta.url, () => {
  const osMock = {
    cpus: vi.fn(() => Array.from({ length: 8 }, () => ({ model: 'Mock CPU' }))),
    hostname: vi.fn(() => 'wiki-host'),
    type: vi.fn(() => 'Linux'),
    platform: vi.fn(() => 'linux'),
    release: vi.fn(() => '6.8.0'),
    arch: vi.fn(() => 'x64'),
    totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024)
  }
  return { default: osMock, ...osMock }
})
vi.mockModule('filesize', import.meta.url, () => ({ filesize: vi.fn(() => '16 GB') }))
vi.mockModule('fs-extra', import.meta.url, () => {
  const fsMock = {
    pathExists: vi.fn().mockResolvedValue(false),
    ensureDir: vi.fn().mockResolvedValue(true),
    readdir: vi.fn().mockResolvedValue([])
  }
  return { default: fsMock, ...fsMock }
})
const { default: express } = await import('express')
const { default: importV1Operations } = await vi.importFresh('../../operations/import-v1.ts', import.meta.url)
const { default: fs } = await import('fs-extra')
const { default: getos } = await import('getos')
const os = await import('node:os')
const { filesize } = await import('filesize')

const product = createProductMetadata({
  revision: '0123456789abcdef0123456789abcdef01234567',
  date: '2026-08-13T00:00:00.000Z'
})

const originalFetch = global.fetch

describe('controllers/api system endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    importV1Operations.importUsers.mockResolvedValue({
      usersCount: 4,
      groupsCount: 2,
      failed: [{ provider: 'local', email: 'failed@example.com', error: 'duplicate' }]
    })
    getos.mockImplementation(cb => cb(null, {
      dist: 'Ubuntu',
      codename: 'noble',
      release: '24.04.1'
    }))
    os.cpus.mockReturnValue(Array.from({ length: 8 }, () => ({ model: 'Mock CPU' })))
    os.hostname.mockReturnValue('wiki-host')
    os.type.mockReturnValue('Linux')
    os.platform.mockReturnValue('linux')
    os.release.mockReturnValue('6.8.0')
    os.arch.mockReturnValue('x64')
    os.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024)
    filesize.mockReturnValue('16 GB')
    fs.pathExists.mockResolvedValue(false)
    fs.ensureDir.mockResolvedValue(true)
    fs.readdir.mockResolvedValue([])
    express.__router.get.mockClear()
    express.__router.post.mockClear()
    express.__router.patch.mockClear()
    global.fetch = vi.fn()
    delete process.env.UPGRADE_COMPANION
    delete process.env.UPGRADE_COMPANION_REF
    global.WIKI = {
      ROOTPATH: '/srv/wiki',
      version: product.version,
      product,
      auth: {
        checkAccess: vi.fn()
      },
      Error: {
        SystemSSLDisabled: class SystemSSLDisabled extends Error {
          constructor () {
            super('SSL is disabled')
          }
        },
        SystemSSLRenewInvalidProvider: class SystemSSLRenewInvalidProvider extends Error {
          constructor () {
            super('SSL certificate renewal requires the letsencrypt provider')
          }
        },
        SystemSSLLEUnavailable: class SystemSSLLEUnavailable extends Error {
          constructor () {
            super("Let's Encrypt server is unavailable")
          }
        }
      },
      config: {
        host: 'https://wiki.example.test',
        server: {
          sslRedir: false
        },
        db: {
          type: 'postgres',
          host: 'postgres.example.com'
        },
        ssl: {
          enabled: false,
          provider: null
        },
        letsencrypt: {},
        flags: {
          alpha: true,
          beta: false
        },
        telemetry: {
          clientId: 'client-123'
        }
      },
      extensions: {
        ext: {
          alpha: {
            key: 'alpha',
            title: 'Alpha Extension',
            description: 'First extension',
            isInstalled: true,
            internalField: 'not-public',
            isCompatible: vi.fn().mockResolvedValue(true)
          },
          beta: {
            key: 'beta',
            title: 'Beta Extension',
            description: 'Second extension',
            isInstalled: false,
            isCompatible: vi.fn().mockResolvedValue(false)
          }
        }
      },
      models: {
        knex: {
          client: {
            version: '15.4'
          },
          raw: vi.fn()
        },
        groups: {
          query: vi.fn(() => ({
            count: vi.fn(() => ({
              first: vi.fn().mockResolvedValue({ total: '3' })
            }))
          }))
        },
        pages: {
          query: vi.fn(() => ({
            count: vi.fn(() => ({
              first: vi.fn().mockResolvedValue({ total: '42' })
            })),
            findById: vi.fn().mockResolvedValue({ id: 12, path: 'docs', localeCode: 'en' })
          })),
          flushCache: vi.fn().mockResolvedValue(true),
          rebuildTree: vi.fn().mockResolvedValue(true),
          migrateToLocale: vi.fn().mockResolvedValue(2),
          renderPage: vi.fn().mockResolvedValue(true)
        },
        pageHistory: {
          purge: vi.fn().mockResolvedValue(true)
        },
        assets: {
          flushTempUploads: vi.fn().mockResolvedValue(true)
        },
        users: {
          query: vi.fn(() => ({
            count: vi.fn(() => ({
              first: vi.fn().mockResolvedValue({ total: '11' })
            }))
          }))
        },
        tags: {
          query: vi.fn(() => ({
            count: vi.fn(() => ({
              first: vi.fn().mockResolvedValue({ total: '7' })
            }))
          }))
        }
      },
      configSvc: {
        applyFlags: vi.fn().mockResolvedValue(true),
        saveToDb: vi.fn().mockResolvedValue(true)
      },
      system: {
        updates: {
          status: 'unavailable',
          version: null,
          releaseDate: null
        },
        exportStatus: {
          status: 'idle',
          progress: 0,
          message: null,
          startedAt: null
        },
        export: vi.fn()
      },
      telemetry: {
        enabled: true,
        generateClientId: vi.fn()
      },
      events: {
        outbound: {
          emit: vi.fn()
        }
      },
      servers: {
        restartServer: vi.fn().mockResolvedValue(true),
        servers: {
          http: {
            address: () => ({ port: 3000 })
          },
          https: {
            address: () => ({ port: 3443 })
          }
        }
      }
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  const loadHandlers = async () => {
    await vi.importFresh('../../controllers/api/system.ts', import.meta.url)
    return {
      info: express.__router.get.mock.calls.find(([path]) => path === '/info')[1],
      summary: express.__router.get.mock.calls.find(([path]) => path === '/summary')[1],
      flags: express.__router.get.mock.calls.find(([path]) => path === '/flags')[1],
      host: express.__router.get.mock.calls.find(([path]) => path === '/host')[1],
      extensions: express.__router.get.mock.calls.find(([path]) => path === '/extensions')[1],
      telemetry: express.__router.get.mock.calls.find(([path]) => path === '/telemetry')[1],
      updateTelemetry: express.__router.patch.mock.calls.find(([path]) => path === '/telemetry')[1],
      resetTelemetryClientId: express.__router.post.mock.calls.find(([path]) => path === '/telemetry/reset-client-id')[1],
      performUpgrade: express.__router.post.mock.calls.find(([path]) => path === '/upgrade')[1],
      startExport: express.__router.post.mock.calls.find(([path]) => path === '/export')[1],
      flushSystemCache: express.__router.post.mock.calls.find(([path]) => path === '/cache/flush')[1],
      flushSystemTemporaryUploads: express.__router.post.mock.calls.find(([path]) => path === '/cache/temp-uploads/flush')[1],
      rebuildPageTree: express.__router.post.mock.calls.find(([path]) => path === '/content/rebuild-tree')[1],
      renderPage: express.__router.post.mock.calls.find(([path]) => path === '/content/render-page')[1],
      migratePagesToLocale: express.__router.post.mock.calls.find(([path]) => path === '/content/migrate-locale')[1],
      purgePageHistory: express.__router.post.mock.calls.find(([path]) => path === '/content/purge-history')[1],
      exportStatus: express.__router.get.mock.calls.find(([path]) => path === '/export-status')[1],
      ssl: express.__router.get.mock.calls.find(([path]) => path === '/ssl')[1],
      updateSslRedirection: express.__router.patch.mock.calls.find(([path]) => path === '/ssl/redirection')[1],
      renewSslCertificate: express.__router.post.mock.calls.find(([path]) => path === '/ssl/renew')[1],
      saveFlags: express.__router.post.mock.calls.find(([path]) => path === '/flags')[1],
      importV1Users: express.__router.post.mock.calls.find(([path]) => path === '/import-v1/users')[1],
      checkForUpdate: express.__router.post.mock.calls.find(([path]) => path === '/check-for-update')[1]
    }
  }

  it('registers system routes', async () => {
    const handlers = await loadHandlers()

    expect(typeof handlers.info).toBe('function')
    expect(typeof handlers.summary).toBe('function')
    expect(typeof handlers.flags).toBe('function')
    expect(typeof handlers.host).toBe('function')
    expect(typeof handlers.extensions).toBe('function')
    expect(typeof handlers.telemetry).toBe('function')
    expect(typeof handlers.updateTelemetry).toBe('function')
    expect(typeof handlers.resetTelemetryClientId).toBe('function')
    expect(typeof handlers.performUpgrade).toBe('function')
    expect(typeof handlers.startExport).toBe('function')
    expect(typeof handlers.flushSystemCache).toBe('function')
    expect(typeof handlers.flushSystemTemporaryUploads).toBe('function')
    expect(typeof handlers.rebuildPageTree).toBe('function')
    expect(typeof handlers.renderPage).toBe('function')
    expect(typeof handlers.migratePagesToLocale).toBe('function')
    expect(typeof handlers.purgePageHistory).toBe('function')
    expect(typeof handlers.exportStatus).toBe('function')
    expect(typeof handlers.ssl).toBe('function')
    expect(typeof handlers.updateSslRedirection).toBe('function')
    expect(typeof handlers.renewSslCertificate).toBe('function')
    expect(typeof handlers.saveFlags).toBe('function')
    expect(typeof handlers.importV1Users).toBe('function')
    expect(typeof handlers.checkForUpdate).toBe('function')
  })

  it('returns 403 for unauthorized system requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { info, summary, flags, host, extensions, telemetry, updateTelemetry, resetTelemetryClientId, performUpgrade, startExport, flushSystemCache, flushSystemTemporaryUploads, rebuildPageTree, renderPage, migratePagesToLocale, purgePageHistory, exportStatus, ssl, updateSslRedirection, renewSslCertificate, saveFlags, importV1Users, checkForUpdate } = await loadHandlers()
    const req = { user: { permissions: [] }, get: vi.fn() }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await info(req, res)
    await summary(req, res)
    await flags(req, res)
    await host(req, res)
    await extensions(req, res)
    await telemetry(req, res)
    await updateTelemetry(req, res)
    await resetTelemetryClientId(req, res)
    await performUpgrade(req, res)
    await startExport(req, res)
    await flushSystemCache(req, res)
    await flushSystemTemporaryUploads(req, res)
    await rebuildPageTree(req, res)
    await renderPage(req, res)
    await migratePagesToLocale(req, res)
    await purgePageHistory(req, res)
    await exportStatus(req, res)
    await ssl(req, res)
    await updateSslRedirection(req, res)
    await renewSslCertificate(req, res)
    await saveFlags(req, res)
    await importV1Users(req, res)
    await checkForUpdate(req, res)

    expect(res.sendStatus).toHaveBeenCalledTimes(23)
    for (let idx = 1; idx <= 23; idx++) {
      expect(res.sendStatus).toHaveBeenNthCalledWith(idx, 403)
    }
    expect(res.json).not.toHaveBeenCalled()
  })

  it('returns system summary JSON for authorized dashboard-style requests', async () => {
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions) => permissions.includes('manage:navigation'))
    const { summary } = await loadHandlers()
    const req = { user: { permissions: ['manage:navigation'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await summary(req, res)

    expect(res.json).toHaveBeenCalledWith({
      product,
      currentVersion: product.version,
      latestVersion: null,
      latestVersionReleaseDate: null,
      updateStatus: 'unavailable',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })
  })

  it('returns system summary JSON for theme/api admins allowed into the admin shell', async () => {
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions) => permissions.includes('manage:theme') || permissions.includes('manage:api'))
    const { summary } = await loadHandlers()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await summary(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      product,
      currentVersion: product.version,
      latestVersion: null,
      latestVersionReleaseDate: null,
      updateStatus: 'unavailable',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })
  })

  it('returns flag list JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { flags } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await flags(req, res)

    expect(res.json).toHaveBeenCalledWith([
      { key: 'alpha', value: true },
      { key: 'beta', value: false }
    ])
  })

  it('returns only system host JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.host = 'https://docs.example.test'
    const { host } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    host(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      host: 'https://docs.example.test'
    })
    expect(Object.keys(res.json.mock.calls[0][0])).toEqual(['host'])
  })

  it('returns system extensions JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { extensions } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await extensions(req, res, vi.fn())

    expect(global.WIKI.extensions.ext.alpha.isCompatible).toHaveBeenCalledTimes(1)
    expect(global.WIKI.extensions.ext.beta.isCompatible).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith([
      {
        key: 'alpha',
        title: 'Alpha Extension',
        description: 'First extension',
        isInstalled: true,
        isCompatible: true
      },
      {
        key: 'beta',
        title: 'Beta Extension',
        description: 'Second extension',
        isInstalled: false,
        isCompatible: false
      }
    ])
  })

  it('forwards system extension compatibility errors to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.extensions.ext.beta.isCompatible.mockRejectedValueOnce(new Error('compatibility failed'))
    const { extensions } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    await extensions(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('compatibility failed')
  })

  it('returns system telemetry JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { telemetry } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    telemetry(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      telemetry: true,
      telemetryClientId: 'client-123'
    })
  })

  it('returns a null telemetry client ID when none is configured', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.telemetry.clientId = null
    const { telemetry } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    telemetry(req, res)

    expect(res.json).toHaveBeenCalledWith({
      telemetry: true,
      telemetryClientId: null
    })
  })

  it('updates telemetry state and persists it for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { updateTelemetry } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: false } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTelemetry(req, res, vi.fn())

    expect(global.WIKI.config.telemetry.isEnabled).toBe(false)
    expect(global.WIKI.telemetry.enabled).toBe(false)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['telemetry'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Telemetry updated successfully.' })
  })

  it('returns 400 for malformed telemetry state updates', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { updateTelemetry } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: 'false' } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTelemetry(req, res, vi.fn())

    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' })
  })

  it('forwards telemetry state persistence failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('telemetry save failed'))
    const { updateTelemetry } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: true } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await updateTelemetry(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('telemetry save failed')
  })

  it('resets telemetry client ID and persists telemetry config for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { resetTelemetryClientId } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await resetTelemetryClientId(req, res, vi.fn())

    expect(global.WIKI.telemetry.generateClientId).toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['telemetry'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Telemetry Client ID reset successfully.' })
  })

  it('forwards telemetry client ID reset persistence failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('telemetry reset failed'))
    const { resetTelemetryClientId } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    await resetTelemetryClientId(req, res, next)

    expect(global.WIKI.telemetry.generateClientId).toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('telemetry reset failed')
  })

  it('rejects the retained upgrade route while no fork-owned update provider exists', async () => {
    process.env.UPGRADE_COMPANION = '1'
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { performUpgrade } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await performUpgrade(req, res)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Preview updates are unavailable because no fork-owned update provider is configured.'
    })
  })

  it('flushes pages cache and emits outbound cache invalidation for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { flushSystemCache } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await flushSystemCache(req, res, vi.fn())

    expect(global.WIKI.models.pages.flushCache).toHaveBeenCalledTimes(1)
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('flushCache')
    expect(res.json).toHaveBeenCalledWith({ message: 'Cache flushed successfully.' })
  })

  it('returns JSON error messages for pages cache flush failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.pages.flushCache.mockRejectedValueOnce(new Error('cache flush failed'))
    const { flushSystemCache } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await flushSystemCache(req, res)

    expect(global.WIKI.events.outbound.emit).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'cache flush failed' })
  })

  it('flushes temporary uploads for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { flushSystemTemporaryUploads } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await flushSystemTemporaryUploads(req, res, vi.fn())

    expect(global.WIKI.models.assets.flushTempUploads).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ message: 'Temporary Uploads flushed successfully.' })
  })

  it('returns JSON error messages for temporary uploads flush failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.assets.flushTempUploads.mockRejectedValueOnce(new Error('uploads flush failed'))
    const { flushSystemTemporaryUploads } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await flushSystemTemporaryUploads(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'uploads flush failed' })
  })

  it('rebuilds the page tree for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { rebuildPageTree } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await rebuildPageTree(req, res)

    expect(global.WIKI.models.pages.rebuildTree).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ message: 'Page tree rebuilt successfully.' })
  })

  it('returns JSON error messages for page tree rebuild failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.pages.rebuildTree.mockRejectedValueOnce(new Error('tree failed'))
    const { rebuildPageTree } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await rebuildPageTree(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'tree failed' })
  })

  it('migrates pages to a locale for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { migratePagesToLocale } = await loadHandlers()
    const req = { user: { id: 7, name: 'Administrator', email: 'admin@example.com', permissions: ['manage:system'] }, body: { sourceLocale: 'en', targetLocale: 'fr' } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await migratePagesToLocale(req, res)

    expect(global.WIKI.models.pages.migrateToLocale).toHaveBeenCalledWith({ sourceLocale: 'en', targetLocale: 'fr', user: req.user })
    expect(res.json).toHaveBeenCalledWith({
      message: 'Migrated content to target locale successfully.',
      count: 2
    })
  })

  it.each([
    ['missing source locale', {}, 'sourceLocale must be a non-empty string'],
    ['empty source locale', { sourceLocale: '', targetLocale: 'fr' }, 'sourceLocale must be a non-empty string'],
    ['missing target locale', { sourceLocale: 'en' }, 'targetLocale must be a non-empty string'],
    ['empty target locale', { sourceLocale: 'en', targetLocale: '' }, 'targetLocale must be a non-empty string']
  ])('rejects malformed locale migration payloads: %s', async (label, body, error) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { migratePagesToLocale } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await migratePagesToLocale(req, res)

    expect(global.WIKI.models.pages.migrateToLocale).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error })
  })

  it('returns JSON error messages for locale migration failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.pages.migrateToLocale.mockRejectedValueOnce(new Error('migration failed'))
    const { migratePagesToLocale } = await loadHandlers()
    const req = { user: { id: 7, name: 'Administrator', email: 'admin@example.com', permissions: ['manage:system'] }, body: { sourceLocale: 'en', targetLocale: 'fr' } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await migratePagesToLocale(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'migration failed' })
  })

  it('returns the safe export status JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.system.exportStatus = {
      status: 'running',
      progress: 42.1,
      message: 'Export is running',
      startedAt: '2026-04-25T12:00:00.000Z',
      archivePath: '/private/export.tar.gz',
      entities: ['pages'],
      internalField: 'must-not-return'
    }
    const { exportStatus } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), set: vi.fn() }

    exportStatus(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({
      status: 'running',
      progress: 43,
      message: 'Export is running',
      startedAt: '2026-04-25T12:00:00.000Z'
    })
    expect(Object.keys(res.json.mock.calls[0][0]).sort()).toEqual([
      'message',
      'progress',
      'startedAt',
      'status'
    ].sort())
  })

  it('returns the default not-running export status when optional fields are absent', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.system.exportStatus = {
      status: 'notrunning',
      progress: 0,
      message: '',
      updatedAt: null
    }
    const { exportStatus } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), set: vi.fn() }

    exportStatus(req, res)

    expect(res.json).toHaveBeenCalledWith({
      status: 'notrunning',
      progress: 0,
      message: '',
      startedAt: null
    })
  })

  it('returns SSL status JSON for authorized letsencrypt requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.server.sslRedir = true
    global.WIKI.config.ssl = {
      enabled: true,
      provider: 'letsencrypt',
      domain: 'docs.example.test',
      subscriberEmail: 'ops@example.test',
      internalField: 'must-not-return'
    }
    global.WIKI.config.letsencrypt = {
      payload: {
        expires: '2026-06-01T00:00:00.000Z',
        internalField: 'must-not-return'
      }
    }
    const { ssl } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    ssl(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      httpPort: 3000,
      httpRedirection: true,
      httpsPort: 3443,
      sslDomain: 'docs.example.test',
      sslExpirationDate: '2026-06-01T00:00:00.000Z',
      sslProvider: 'letsencrypt',
      sslStatus: 'OK',
      sslSubscriberEmail: 'ops@example.test'
    })
    expect(Object.keys(res.json.mock.calls[0][0]).sort()).toEqual([
      'httpPort',
      'httpRedirection',
      'httpsPort',
      'sslDomain',
      'sslExpirationDate',
      'sslProvider',
      'sslStatus',
      'sslSubscriberEmail'
    ].sort())
  })

  it('returns null SSL fields and zero ports when SSL and servers are disabled', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.ssl = {
      enabled: false,
      provider: 'custom',
      domain: 'docs.example.test',
      subscriberEmail: 'ops@example.test'
    }
    global.WIKI.config.letsencrypt = {
      payload: {
        expires: '2026-06-01T00:00:00.000Z'
      }
    }
    global.WIKI.servers.servers = {}
    const { ssl } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    ssl(req, res)

    expect(res.json).toHaveBeenCalledWith({
      httpPort: 0,
      httpRedirection: false,
      httpsPort: 0,
      sslDomain: null,
      sslExpirationDate: null,
      sslProvider: null,
      sslStatus: 'OK',
      sslSubscriberEmail: null
    })
  })

  it('returns custom SSL provider without letsencrypt-only fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.ssl = {
      enabled: true,
      provider: 'custom',
      domain: 'docs.example.test',
      subscriberEmail: 'ops@example.test'
    }
    global.WIKI.config.letsencrypt = {
      payload: {
        expires: '2026-06-01T00:00:00.000Z'
      }
    }
    const { ssl } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    ssl(req, res)

    expect(res.json).toHaveBeenCalledWith({
      httpPort: 3000,
      httpRedirection: false,
      httpsPort: 3443,
      sslDomain: null,
      sslExpirationDate: null,
      sslProvider: 'custom',
      sslStatus: 'OK',
      sslSubscriberEmail: null
    })
  })

  it('updates HTTPS redirection through REST', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { updateSslRedirection } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: true } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateSslRedirection(req, res)

    expect(global.WIKI.config.server.sslRedir).toBe(true)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['server'])
    expect(res.json).toHaveBeenCalledWith({ message: 'HTTP Redirection state set successfully.' })
  })

  it('rejects malformed HTTPS redirection payloads with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { updateSslRedirection } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: 'yes' } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateSslRedirection(req, res)

    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' })
  })

  it('returns JSON errors when HTTPS redirection persistence fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('server save failed'))
    const { updateSslRedirection } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: true } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateSslRedirection(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'server save failed' })
  })

  it('renews letsencrypt SSL certificates through REST', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.ssl = { enabled: true, provider: 'letsencrypt' }
    global.WIKI.servers.le = { requestCertificate: vi.fn().mockResolvedValue(true) }
    const { renewSslCertificate } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await renewSslCertificate(req, res)

    expect(global.WIKI.servers.le.requestCertificate).toHaveBeenCalled()
    expect(global.WIKI.servers.restartServer).toHaveBeenCalledWith('https')
    expect(res.json).toHaveBeenCalledWith({ message: 'SSL Certificate renewed successfully.' })
  })

  it('rejects SSL certificate renewal when SSL is disabled', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.ssl = { enabled: false, provider: 'letsencrypt' }
    global.WIKI.servers.le = { requestCertificate: vi.fn().mockResolvedValue(true) }
    const { renewSslCertificate } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await renewSslCertificate(req, res)

    expect(global.WIKI.servers.le.requestCertificate).not.toHaveBeenCalled()
    expect(global.WIKI.servers.restartServer).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'SSL is disabled' })
  })

  it('rejects SSL certificate renewal for non-letsencrypt providers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.ssl = { enabled: true, provider: 'custom' }
    global.WIKI.servers.le = { requestCertificate: vi.fn().mockResolvedValue(true) }
    const { renewSslCertificate } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await renewSslCertificate(req, res)

    expect(global.WIKI.servers.le.requestCertificate).not.toHaveBeenCalled()
    expect(global.WIKI.servers.restartServer).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'SSL certificate renewal requires the letsencrypt provider' })
  })

  it('rejects SSL certificate renewal when letsencrypt server is unavailable', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.ssl = { enabled: true, provider: 'letsencrypt' }
    delete global.WIKI.servers.le
    const { renewSslCertificate } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await renewSslCertificate(req, res)

    expect(global.WIKI.servers.restartServer).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: "Let's Encrypt server is unavailable" })
  })

  it('returns 400 when the system flags update receives a non-array payload', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: 'bad-payload' },
      get: vi.fn().mockReturnValue(undefined)
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveFlags(req, res, vi.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags must be an array' })
  })

  it('rejects malformed flags payloads with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: 'yes' }] },
      get: vi.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveFlags(req, res, vi.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags entries must contain string keys and boolean values' })
  })

  it('rejects unknown or path-like flag keys with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha.nested', value: true }] },
      get: vi.fn()
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveFlags(req, res, vi.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags entries must use known flag keys' })
  })

  it('rejects duplicate flag keys with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: true }, { key: 'alpha', value: false }] },
      get: vi.fn()
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveFlags(req, res, vi.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags entries must not contain duplicate keys' })
  })

  it('rejects partial flag payloads with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: true }] },
      get: vi.fn()
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveFlags(req, res, vi.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags payload must include the full known flag set' })
  })

  it('applies and persists system flags for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: false }, { key: 'beta', value: true }] },
      get: vi.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await saveFlags(req, res, vi.fn())

    expect(global.WIKI.config.flags).toEqual({ alpha: false, beta: true })
    expect(global.WIKI.configSvc.applyFlags).toHaveBeenCalledTimes(1)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['flags'])
    expect(res.json).toHaveBeenCalledWith({ message: 'System flags applied successfully.' })
  })

  it('forwards unexpected system flag persistence failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.applyFlags.mockRejectedValueOnce(new Error('flags save failed'))
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: false }, { key: 'beta', value: true }] },
      get: vi.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await saveFlags(req, res, next)

    expect(global.WIKI.config.flags).toEqual({ alpha: true, beta: false })
    expect(global.WIKI.configSvc.applyFlags).toHaveBeenCalledTimes(2)
    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('flags save failed')
  })

  it('forwards a persistence error when saveToDb returns false', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockResolvedValueOnce(false)
    const { saveFlags } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: false }, { key: 'beta', value: true }] },
      get: vi.fn()
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await saveFlags(req, res, next)

    expect(global.WIKI.config.flags).toEqual({ alpha: true, beta: false })
    expect(global.WIKI.configSvc.applyFlags).toHaveBeenCalledTimes(2)
    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('System flags could not be persisted.')
  })

  it('returns a safe system info payload for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { info } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    await info(req, res, next)
    expect(next).not.toHaveBeenCalled()

    expect(res.json).toHaveBeenCalledWith({
      product,
      configFile: `${process.cwd()}/config.yml`,
      cpuCores: 8,
      currentVersion: product.version,
      dbHost: 'postgres.example.com',
      dbType: 'PostgreSQL',
      dbVersion: '15.4',
      hostname: 'wiki-host',
      latestVersion: null,
      latestVersionReleaseDate: null,
      updateStatus: 'unavailable',
      bunVersion: process.versions.bun,
      operatingSystem: 'Linux - Ubuntu (noble) 24.04.1 x64',
      platform: 'linux',
      ramTotal: '16 GB',
      telemetry: true,
      telemetryClientId: 'client-123',
      httpPort: 3000,
      httpsPort: 3443,
      upgradeCapable: false,
      workingDirectory: process.cwd(),
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })
  })

  it('imports Wiki.js 1.x users through the shared import operation', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { importV1Users } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: {
        mongoDbConnString: 'mongodb://legacy.example.test/wiki',
        groupMode: 'MULTI'
      }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await importV1Users(req, res)

    expect(importV1Operations.importUsers).toHaveBeenCalledWith(req.body)
    expect(res.json).toHaveBeenCalledWith({
      usersCount: 4,
      groupsCount: 2,
      failed: [{ provider: 'local', email: 'failed@example.com', error: 'duplicate' }]
    })
  })

  it('returns 400 when the update sync request omits the required API header', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { checkForUpdate } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      get: vi.fn().mockReturnValue(undefined)
    }
    const res = { json: vi.fn(), sendStatus: vi.fn(), status: vi.fn().mockReturnThis() }

    await checkForUpdate(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'X-Requested-With header is required' })
  })

  it('reports preview updates as unavailable without contacting an upstream release provider', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { checkForUpdate } = await loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      get: vi.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: vi.fn(), sendStatus: vi.fn() }

    await checkForUpdate(req, res)

    expect(global.fetch).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      product,
      currentVersion: product.version,
      latestVersion: null,
      latestVersionReleaseDate: null,
      updateStatus: 'unavailable'
    })
  })

  it('starts system exports through REST with resolved target path', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { startExport } = await loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { entities: ['pages', 'assets'], path: './data/export' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await startExport(req, res)

    expect(fs.ensureDir).toHaveBeenCalledWith(expect.stringMatching(/data[/\\]export$/))
    expect(fs.readdir).toHaveBeenCalledWith(expect.stringMatching(/data[/\\]export$/))
    expect(global.WIKI.system.export).toHaveBeenCalledWith({
      entities: ['pages', 'assets'],
      path: expect.stringMatching(/data[/\\]export$/)
    })
    expect(res.json).toHaveBeenCalledWith({ message: 'Export started successfully.' })
  })

  it.each([
    ['missing entities', { path: './data/export' }],
    ['empty entities', { entities: [], path: './data/export' }],
    ['non-array entities', { entities: 'pages', path: './data/export' }],
    ['empty entity', { entities: ['pages', ''], path: './data/export' }],
    ['non-string entity', { entities: ['pages', 7], path: './data/export' }]
  ])('rejects malformed export entities: %s', async (label, body) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { startExport } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await startExport({ user: { permissions: ['manage:system'] }, body }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'entities must be a non-empty string array' })
    expect(fs.ensureDir).not.toHaveBeenCalled()
    expect(global.WIKI.system.export).not.toHaveBeenCalled()
  })

  it.each([
    ['missing path', { entities: ['pages'] }],
    ['empty path', { entities: ['pages'], path: '' }],
    ['non-string path', { entities: ['pages'], path: 7 }]
  ])('rejects malformed export paths: %s', async (label, body) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { startExport } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await startExport({ user: { permissions: ['manage:system'] }, body }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'path must be a non-empty string' })
    expect(fs.ensureDir).not.toHaveBeenCalled()
    expect(global.WIKI.system.export).not.toHaveBeenCalled()
  })

  it('returns JSON error when an export is already running', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.system.exportStatus.status = 'running'
    const { startExport } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await startExport({ user: { permissions: ['manage:system'] }, body: { entities: ['pages'], path: './data/export' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Another export is already running.' })
    expect(fs.ensureDir).not.toHaveBeenCalled()
    expect(global.WIKI.system.export).not.toHaveBeenCalled()
  })

  it('returns JSON error when export target directory is not empty', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    fs.readdir.mockResolvedValueOnce(['existing.json'])
    const { startExport } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await startExport({ user: { permissions: ['manage:system'] }, body: { entities: ['pages'], path: './data/export' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Target directory must be empty!' })
    expect(global.WIKI.system.export).not.toHaveBeenCalled()
  })

  it('returns JSON errors for export filesystem failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    fs.ensureDir.mockRejectedValueOnce(new Error('ensure failed'))
    const { startExport } = await loadHandlers()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), sendStatus: vi.fn() }

    await startExport({ user: { permissions: ['manage:system'] }, body: { entities: ['pages'], path: './data/export' } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'ensure failed' })
    expect(global.WIKI.system.export).not.toHaveBeenCalled()
  })
})
