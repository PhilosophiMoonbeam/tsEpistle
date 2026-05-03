jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    use: jest.fn()
  }

  return {
    Router: () => router,
    __router: router
  }
})

jest.mock('../../jobs/sync-graph-updates', () => jest.fn().mockResolvedValue(true))
jest.mock('getos', () => jest.fn((cb) => cb(null, {
  dist: 'Ubuntu',
  codename: 'noble',
  release: '24.04.1'
})))
jest.mock('os', () => ({
  cpus: jest.fn(() => Array.from({ length: 8 }, () => ({ model: 'Mock CPU' }))),
  hostname: jest.fn(() => 'wiki-host'),
  type: jest.fn(() => 'Linux'),
  platform: jest.fn(() => 'linux'),
  release: jest.fn(() => '6.8.0'),
  arch: jest.fn(() => 'x64'),
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024)
}))
jest.mock('filesize', () => jest.fn(() => '16 GB'))
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(false)
}))

describe('controllers/api system endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()
    express.__router.post.mockClear()
    express.__router.patch.mockClear()

    global.WIKI = {
      version: '2.0.0',
      auth: {
        checkAccess: jest.fn()
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
            isCompatible: jest.fn().mockResolvedValue(true)
          },
          beta: {
            key: 'beta',
            title: 'Beta Extension',
            description: 'Second extension',
            isInstalled: false,
            isCompatible: jest.fn().mockResolvedValue(false)
          }
        }
      },
      models: {
        knex: {
          client: {
            version: '15.4'
          },
          raw: jest.fn()
        },
        groups: {
          query: jest.fn(() => ({
            count: jest.fn(() => ({
              first: jest.fn().mockResolvedValue({ total: '3' })
            }))
          }))
        },
        pages: {
          query: jest.fn(() => ({
            count: jest.fn(() => ({
              first: jest.fn().mockResolvedValue({ total: '42' })
            }))
          })),
          flushCache: jest.fn().mockResolvedValue(true)
        },
        assets: {
          flushTempUploads: jest.fn().mockResolvedValue(true)
        },
        users: {
          query: jest.fn(() => ({
            count: jest.fn(() => ({
              first: jest.fn().mockResolvedValue({ total: '11' })
            }))
          }))
        },
        tags: {
          query: jest.fn(() => ({
            count: jest.fn(() => ({
              first: jest.fn().mockResolvedValue({ total: '7' })
            }))
          }))
        }
      },
      configSvc: {
        applyFlags: jest.fn().mockResolvedValue(true),
        saveToDb: jest.fn().mockResolvedValue(true)
      },
      system: {
        updates: {
          version: '2.1.0',
          releaseDate: '2026-01-01T00:00:00.000Z'
        },
        exportStatus: {
          status: 'idle',
          progress: 0,
          message: null,
          startedAt: null
        }
      },
      telemetry: {
        enabled: true,
        generateClientId: jest.fn()
      },
      events: {
        outbound: {
          emit: jest.fn()
        }
      },
      servers: {
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

  const loadHandlers = () => {
    const express = require('express')
    require('../../controllers/api/system')
    return {
      info: express.__router.get.mock.calls.find(([path]) => path === '/info')[1],
      summary: express.__router.get.mock.calls.find(([path]) => path === '/summary')[1],
      flags: express.__router.get.mock.calls.find(([path]) => path === '/flags')[1],
      host: express.__router.get.mock.calls.find(([path]) => path === '/host')[1],
      extensions: express.__router.get.mock.calls.find(([path]) => path === '/extensions')[1],
      telemetry: express.__router.get.mock.calls.find(([path]) => path === '/telemetry')[1],
      updateTelemetry: express.__router.patch.mock.calls.find(([path]) => path === '/telemetry')[1],
      resetTelemetryClientId: express.__router.post.mock.calls.find(([path]) => path === '/telemetry/reset-client-id')[1],
      flushSystemCache: express.__router.post.mock.calls.find(([path]) => path === '/cache/flush')[1],
      flushSystemTemporaryUploads: express.__router.post.mock.calls.find(([path]) => path === '/cache/temp-uploads/flush')[1],
      exportStatus: express.__router.get.mock.calls.find(([path]) => path === '/export-status')[1],
      ssl: express.__router.get.mock.calls.find(([path]) => path === '/ssl')[1],
      saveFlags: express.__router.post.mock.calls.find(([path]) => path === '/flags')[1],
      checkForUpdate: express.__router.post.mock.calls.find(([path]) => path === '/check-for-update')[1]
    }
  }

  it('registers system routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.info).toBe('function')
    expect(typeof handlers.summary).toBe('function')
    expect(typeof handlers.flags).toBe('function')
    expect(typeof handlers.host).toBe('function')
    expect(typeof handlers.extensions).toBe('function')
    expect(typeof handlers.telemetry).toBe('function')
    expect(typeof handlers.updateTelemetry).toBe('function')
    expect(typeof handlers.resetTelemetryClientId).toBe('function')
    expect(typeof handlers.flushSystemCache).toBe('function')
    expect(typeof handlers.flushSystemTemporaryUploads).toBe('function')
    expect(typeof handlers.exportStatus).toBe('function')
    expect(typeof handlers.ssl).toBe('function')
    expect(typeof handlers.saveFlags).toBe('function')
    expect(typeof handlers.checkForUpdate).toBe('function')
  })

  it('returns 403 for unauthorized system requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { info, summary, flags, host, extensions, telemetry, updateTelemetry, resetTelemetryClientId, flushSystemCache, flushSystemTemporaryUploads, exportStatus, ssl, saveFlags, checkForUpdate } = loadHandlers()
    const req = { user: { permissions: [] }, get: jest.fn() }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await info(req, res)
    await summary(req, res)
    await flags(req, res)
    await host(req, res)
    await extensions(req, res)
    await telemetry(req, res)
    await updateTelemetry(req, res)
    await resetTelemetryClientId(req, res)
    await flushSystemCache(req, res)
    await flushSystemTemporaryUploads(req, res)
    await exportStatus(req, res)
    await ssl(req, res)
    await saveFlags(req, res)
    await checkForUpdate(req, res)

    expect(res.sendStatus).toHaveBeenCalledTimes(14)
    for (let idx = 1; idx <= 14; idx++) {
      expect(res.sendStatus).toHaveBeenNthCalledWith(idx, 403)
    }
    expect(res.json).not.toHaveBeenCalled()
  })

  it('returns system summary JSON for authorized dashboard-style requests', async () => {
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions) => permissions.includes('manage:navigation'))
    const { summary } = loadHandlers()
    const req = { user: { permissions: ['manage:navigation'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await summary(req, res)

    expect(res.json).toHaveBeenCalledWith({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })
  })

  it('returns system summary JSON for theme/api admins allowed into the admin shell', async () => {
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions) => permissions.includes('manage:theme') || permissions.includes('manage:api'))
    const { summary } = loadHandlers()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await summary(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      groupsTotal: 3,
      pagesTotal: 42,
      usersTotal: 11,
      tagsTotal: 7
    })
  })

  it('returns flag list JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { flags } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await flags(req, res)

    expect(res.json).toHaveBeenCalledWith([
      { key: 'alpha', value: true },
      { key: 'beta', value: false }
    ])
  })

  it('returns only system host JSON for authorized requests', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.host = 'https://docs.example.test'
    const { host } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    host(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      host: 'https://docs.example.test'
    })
    expect(Object.keys(res.json.mock.calls[0][0])).toEqual(['host'])
  })

  it('returns system extensions JSON for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { extensions } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await extensions(req, res, jest.fn())

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
    const { extensions } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }
    const next = jest.fn()

    await extensions(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('compatibility failed')
  })

  it('returns system telemetry JSON for authorized requests', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { telemetry } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    telemetry(req, res)

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      telemetry: true,
      telemetryClientId: 'client-123'
    })
  })

  it('returns a null telemetry client ID when none is configured', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.telemetry.clientId = null
    const { telemetry } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    telemetry(req, res)

    expect(res.json).toHaveBeenCalledWith({
      telemetry: true,
      telemetryClientId: null
    })
  })

  it('updates telemetry state and persists it for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { updateTelemetry } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: false } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTelemetry(req, res, jest.fn())

    expect(global.WIKI.config.telemetry.isEnabled).toBe(false)
    expect(global.WIKI.telemetry.enabled).toBe(false)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['telemetry'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Telemetry updated successfully.' })
  })

  it('returns 400 for malformed telemetry state updates', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { updateTelemetry } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: 'false' } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTelemetry(req, res, jest.fn())

    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' })
  })

  it('forwards telemetry state persistence failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('telemetry save failed'))
    const { updateTelemetry } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, body: { enabled: true } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await updateTelemetry(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('telemetry save failed')
  })

  it('resets telemetry client ID and persists telemetry config for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { resetTelemetryClientId } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await resetTelemetryClientId(req, res, jest.fn())

    expect(global.WIKI.telemetry.generateClientId).toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['telemetry'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Telemetry Client ID reset successfully.' })
  })

  it('forwards telemetry client ID reset persistence failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('telemetry reset failed'))
    const { resetTelemetryClientId } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }
    const next = jest.fn()

    await resetTelemetryClientId(req, res, next)

    expect(global.WIKI.telemetry.generateClientId).toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('telemetry reset failed')
  })

  it('flushes pages cache and emits outbound cache invalidation for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { flushSystemCache } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await flushSystemCache(req, res, jest.fn())

    expect(global.WIKI.models.pages.flushCache).toHaveBeenCalledTimes(1)
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('flushCache')
    expect(res.json).toHaveBeenCalledWith({ message: 'Cache flushed successfully.' })
  })

  it('returns JSON error messages for pages cache flush failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.pages.flushCache.mockRejectedValueOnce(new Error('cache flush failed'))
    const { flushSystemCache } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await flushSystemCache(req, res)

    expect(global.WIKI.events.outbound.emit).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'cache flush failed' })
  })

  it('flushes temporary uploads for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { flushSystemTemporaryUploads } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await flushSystemTemporaryUploads(req, res, jest.fn())

    expect(global.WIKI.models.assets.flushTempUploads).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ message: 'Temporary Uploads flushed successfully.' })
  })

  it('returns JSON error messages for temporary uploads flush failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.assets.flushTempUploads.mockRejectedValueOnce(new Error('uploads flush failed'))
    const { flushSystemTemporaryUploads } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await flushSystemTemporaryUploads(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'uploads flush failed' })
  })

  it('returns the safe export status JSON for authorized requests', () => {
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
    const { exportStatus } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), set: jest.fn() }

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

  it('returns the default not-running export status when optional fields are absent', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.system.exportStatus = {
      status: 'notrunning',
      progress: 0,
      message: '',
      updatedAt: null
    }
    const { exportStatus } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn(), set: jest.fn() }

    exportStatus(req, res)

    expect(res.json).toHaveBeenCalledWith({
      status: 'notrunning',
      progress: 0,
      message: '',
      startedAt: null
    })
  })

  it('returns SSL status JSON for authorized letsencrypt requests', () => {
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
    const { ssl } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

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

  it('returns null SSL fields and zero ports when SSL and servers are disabled', () => {
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
    const { ssl } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

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

  it('returns custom SSL provider without letsencrypt-only fields', () => {
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
    const { ssl } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

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

  it('returns 400 when the system flags update receives a non-array payload', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: 'bad-payload' },
      get: jest.fn().mockReturnValue(undefined)
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await saveFlags(req, res, jest.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags must be an array' })
  })

  it('rejects malformed flags payloads with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: 'yes' }] },
      get: jest.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await saveFlags(req, res, jest.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags entries must contain string keys and boolean values' })
  })

  it('rejects unknown or path-like flag keys with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha.nested', value: true }] },
      get: jest.fn()
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await saveFlags(req, res, jest.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags entries must use known flag keys' })
  })

  it('rejects duplicate flag keys with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: true }, { key: 'alpha', value: false }] },
      get: jest.fn()
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await saveFlags(req, res, jest.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags entries must not contain duplicate keys' })
  })

  it('rejects partial flag payloads with 400', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: true }] },
      get: jest.fn()
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await saveFlags(req, res, jest.fn())

    expect(global.WIKI.configSvc.applyFlags).not.toHaveBeenCalled()
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'flags payload must include the full known flag set' })
  })

  it('applies and persists system flags for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: false }, { key: 'beta', value: true }] },
      get: jest.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await saveFlags(req, res, jest.fn())

    expect(global.WIKI.config.flags).toEqual({ alpha: false, beta: true })
    expect(global.WIKI.configSvc.applyFlags).toHaveBeenCalledTimes(1)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['flags'])
    expect(res.json).toHaveBeenCalledWith({ message: 'System flags applied successfully.' })
  })

  it('forwards unexpected system flag persistence failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.applyFlags.mockRejectedValueOnce(new Error('flags save failed'))
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: false }, { key: 'beta', value: true }] },
      get: jest.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

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
    const { saveFlags } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: { flags: [{ key: 'alpha', value: false }, { key: 'beta', value: true }] },
      get: jest.fn()
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await saveFlags(req, res, next)

    expect(global.WIKI.config.flags).toEqual({ alpha: true, beta: false })
    expect(global.WIKI.configSvc.applyFlags).toHaveBeenCalledTimes(2)
    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('System flags could not be persisted.')
  })

  it('returns a safe system info payload for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { info } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await info(req, res)

    expect(res.json).toHaveBeenCalledWith({
      configFile: `${process.cwd()}/config.yml`,
      cpuCores: 8,
      currentVersion: '2.0.0',
      dbHost: 'postgres.example.com',
      dbType: 'PostgreSQL',
      dbVersion: '15.4',
      hostname: 'wiki-host',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      nodeVersion: process.version.substr(1),
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

  it('returns 400 when the update sync request omits the required API header', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const syncGraphUpdates = require('../../jobs/sync-graph-updates')
    const { checkForUpdate } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      get: jest.fn().mockReturnValue(undefined)
    }
    const res = { json: jest.fn(), sendStatus: jest.fn(), status: jest.fn().mockReturnThis() }

    await checkForUpdate(req, res)

    expect(syncGraphUpdates).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'X-Requested-With header is required' })
  })

  it('runs the update sync job and returns the latest update state', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const syncGraphUpdates = require('../../jobs/sync-graph-updates')
    const { checkForUpdate } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      get: jest.fn().mockImplementation((header) => header === 'X-Requested-With' ? 'XMLHttpRequest' : undefined)
    }
    const res = { json: jest.fn(), sendStatus: jest.fn() }

    await checkForUpdate(req, res)

    expect(syncGraphUpdates).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z'
    })
  })
})
