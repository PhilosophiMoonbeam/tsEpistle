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
      checkForUpdate: express.__router.post.mock.calls.find(([path]) => path === '/check-for-update')[1]
    }
  }

  it('registers system routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.info).toBe('function')
    expect(typeof handlers.flags).toBe('function')
    expect(typeof handlers.checkForUpdate).toBe('function')
  })

  it('returns 403 for unauthorized system requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { info, flags, checkForUpdate } = loadHandlers()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await info(req, res)
    await flags(req, res)
    await checkForUpdate(req, res)

    expect(res.sendStatus).toHaveBeenCalledTimes(3)
    expect(res.sendStatus).toHaveBeenNthCalledWith(1, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(2, 403)
    expect(res.sendStatus).toHaveBeenNthCalledWith(3, 403)
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
