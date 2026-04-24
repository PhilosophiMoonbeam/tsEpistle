jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    post: jest.fn(),
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

    global.WIKI = {
      version: '2.0.0',
      auth: {
        checkAccess: jest.fn()
      },
      config: {
        db: {
          type: 'postgres',
          host: 'postgres.example.com'
        },
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
          }))
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
        }
      },
      telemetry: {
        enabled: true
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
      extensions: express.__router.get.mock.calls.find(([path]) => path === '/extensions')[1],
      saveFlags: express.__router.post.mock.calls.find(([path]) => path === '/flags')[1],
      checkForUpdate: express.__router.post.mock.calls.find(([path]) => path === '/check-for-update')[1]
    }
  }

  it('registers system routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.info).toBe('function')
    expect(typeof handlers.summary).toBe('function')
    expect(typeof handlers.flags).toBe('function')
    expect(typeof handlers.extensions).toBe('function')
    expect(typeof handlers.saveFlags).toBe('function')
    expect(typeof handlers.checkForUpdate).toBe('function')
  })

  it('returns 403 for unauthorized system requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { info, summary, flags, extensions, saveFlags, checkForUpdate } = loadHandlers()
    const req = { user: { permissions: [] }, get: jest.fn() }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await info(req, res)
    await summary(req, res)
    await flags(req, res)
    await extensions(req, res)
    await saveFlags(req, res)
    await checkForUpdate(req, res)

    expect(res.sendStatus).toHaveBeenCalledTimes(6)
    expect(res.sendStatus).toHaveBeenNthCalledWith(1, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(2, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(3, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(4, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(5, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(6, 403)
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
