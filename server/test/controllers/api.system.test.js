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
        flags: {
          alpha: true,
          beta: false
        },
        telemetry: {
          clientId: 'client-123'
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
      flags: express.__router.get.mock.calls.find(([path]) => path === '/flags')[1],
      saveFlags: express.__router.post.mock.calls.find(([path]) => path === '/flags')[1],
      checkForUpdate: express.__router.post.mock.calls.find(([path]) => path === '/check-for-update')[1]
    }
  }

  it('registers system routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.info).toBe('function')
    expect(typeof handlers.flags).toBe('function')
    expect(typeof handlers.saveFlags).toBe('function')
    expect(typeof handlers.checkForUpdate).toBe('function')
  })

  it('returns 403 for unauthorized system requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { info, flags, saveFlags, checkForUpdate } = loadHandlers()
    const req = { user: { permissions: [] }, get: jest.fn() }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await info(req, res)
    await flags(req, res)
    await saveFlags(req, res)
    await checkForUpdate(req, res)

    expect(res.sendStatus).toHaveBeenCalledTimes(4)
    expect(res.sendStatus).toHaveBeenNthCalledWith(1, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(2, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(3, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(4, 403)
    expect(res.json).not.toHaveBeenCalled()
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
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      latestVersionReleaseDate: '2026-01-01T00:00:00.000Z',
      telemetry: true,
      telemetryClientId: 'client-123',
      httpPort: 3000,
      httpsPort: 3443,
      upgradeCapable: false
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
