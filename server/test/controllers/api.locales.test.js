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

describe('controllers/api locales endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()

    global.WIKI = {
      cache: {
        get: jest.fn().mockResolvedValue(null)
      },
      models: {
        locales: {
          query: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue([
              {
                code: 'en',
                isRTL: false,
                name: 'English',
                nativeName: 'English',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                availability: 100
              }
            ])
          })
        }
      },
      lang: {
        getByNamespace: jest.fn().mockResolvedValue([
          { key: 'welcome', value: 'Hello' }
        ])
      }
    }
  })

  const loadHandlers = () => {
    const express = require('express')
    require('../../controllers/api/locales')
    return {
      list: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      strings: express.__router.get.mock.calls.find(([path]) => path === '/:code/strings')[1]
    }
  }

  it('registers locale routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.list).toBe('function')
    expect(typeof handlers.strings).toBe('function')
  })

  it('returns locale list payload', async () => {
    const { list } = loadHandlers()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await list({}, res)

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        code: 'en',
        name: 'English',
        nativeName: 'English'
      })
    ])
  })

  it('returns namespace strings payload when namespace is provided', async () => {
    const { strings } = loadHandlers()
    const req = {
      params: { code: 'en' },
      query: { namespace: 'common' }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await strings(req, res)

    expect(global.WIKI.lang.getByNamespace).toHaveBeenCalledWith('en', 'common')
    expect(res.json).toHaveBeenCalledWith([
      { key: 'welcome', value: 'Hello' }
    ])
  })

  it('returns 400 when namespace is missing', async () => {
    const { strings } = loadHandlers()
    const req = {
      params: { code: 'en' },
      query: {}
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await strings(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'namespace query parameter is required' })
  })

  it('returns 404 when locale strings cannot be found', async () => {
    global.WIKI.lang.getByNamespace.mockRejectedValueOnce(new Error('Invalid locale or namespace'))
    const { strings } = loadHandlers()
    const req = {
      params: { code: 'zz' },
      query: { namespace: 'common' }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await strings(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid locale or namespace' })
  })
})
