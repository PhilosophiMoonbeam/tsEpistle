vi.mock('express', () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        delete: vi.fn(),
        get: vi.fn(),
        patch: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

import express from 'express'

const API_CONTROLLER_NAMES = [
  'analytics',
  'assets',
  'auth',
  'comments',
  'contribute',
  'groups',
  'locales',
  'logging',
  'mail',
  'navigation',
  'pages',
  'rendering',
  'search',
  'site',
  'storage',
  'system',
  'theming',
  'users'
]

const loadApiIndexRouter = async () => {
  const subrouters = Object.fromEntries(API_CONTROLLER_NAMES.map(name => [name, {}]))

  for (const name of API_CONTROLLER_NAMES) {
    vi.doMock(`../../controllers/api/${name}.ts`, () => ({
      default: subrouters[name]
    }))
  }

  try {
    await expect(import('../../controllers/api/index.ts')).resolves.toBeDefined()
  } finally {
    for (const name of API_CONTROLLER_NAMES) {
      vi.doUnmock(`../../controllers/api/${name}.ts`)
    }
  }

  return { apiRouter: express.__routers.at(-1), subrouters }
}


const originalFetch = global.fetch
const successfulResponse = body => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: vi.fn().mockResolvedValue(body)
})

describe('controllers/api contribute endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0
    global.fetch = vi.fn()

    global.WIKI = {
      models: {
        knex: {}
      },
      logger: {
        warn: vi.fn()
      }
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  const loadContributorsHandler = async () => {
    await import('../../controllers/api/contribute.ts')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/contributors')[1]
  }

  it('registers contributors route', async () => { const handler = await loadContributorsHandler()

  expect(typeof handler).toBe('function') })

  it('is mounted by the API index router', async () => {
    const { apiRouter, subrouters } = await loadApiIndexRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/contribute', subrouters.contribute)
  })

  it('requests upstream sponsors backers using the expected GraphQL request shape', async () => {
    global.fetch.mockResolvedValue(successfulResponse({ data: { sponsors: { list: [] } } }))
    const handler = await loadContributorsHandler()
    const res = { json: vi.fn() }

    await handler({}, res)

    expect(global.fetch).toHaveBeenCalledWith('https://graph.requarks.io', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: expect.any(String)
    })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.variables).toEqual({})
    expect(body.query).toContain('list(kind: BACKER)')
    const query = body.query
    expect(query).toContain('id')
    expect(query).toContain('source')
    expect(query).toContain('name')
    expect(query).toContain('joined')
    expect(query).toContain('website')
    expect(query).toContain('twitter')
    expect(query).toContain('avatar')
  })

  it('returns strict allowlisted contributor fields without upstream extras', async () => {
    global.fetch.mockResolvedValue(successfulResponse({
      data: {
        sponsors: {
          list: [
            {
              id: 'one',
              source: 'github',
              name: 'Ada',
              joined: '2024-01-02',
              website: 'https://example.invalid',
              twitter: 'https://twitter.com/ada',
              avatar: 'https://example.invalid/avatar.png',
              privateField: 'must-not-return'
            }
          ]
        }
      }
    }))
    const handler = await loadContributorsHandler()
    const res = { json: vi.fn() }

    await handler({}, res)

    expect(res.json).toHaveBeenCalledWith([
      {
        id: 'one',
        source: 'github',
        name: 'Ada',
        joined: '2024-01-02',
        website: 'https://example.invalid',
        twitter: 'https://twitter.com/ada',
        avatar: 'https://example.invalid/avatar.png'
      }
    ])
    expect(res.json.mock.calls[0][0][0]).not.toHaveProperty('privateField')
  })

  it('normalizes missing optional contributor fields to null without rewriting empty strings', async () => {
    global.fetch.mockResolvedValue(successfulResponse({
      data: {
        sponsors: {
          list: [
            {
              id: 'two',
              source: 'patreon',
              name: 'Grace',
              joined: '2024-03-04',
              website: '',
              avatar: ''
            }
          ]
        }
      }
    }))
    const handler = await loadContributorsHandler()
    const res = { json: vi.fn() }

    await handler({}, res)

    expect(res.json).toHaveBeenCalledWith([
      {
        id: 'two',
        source: 'patreon',
        name: 'Grace',
        joined: '2024-03-04',
        website: '',
        twitter: null,
        avatar: ''
      }
    ])
  })

  it('returns an empty array when upstream list data is missing', async () => {
    global.fetch.mockResolvedValue(successfulResponse({ data: { sponsors: {} } }))
    const handler = await loadContributorsHandler()
    const res = { json: vi.fn() }

    await handler({}, res)

    expect(res.json).toHaveBeenCalledWith([])
  })

  it('logs upstream failures and returns an empty array', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: vi.fn()
    })
    const handler = await loadContributorsHandler()
    const res = { json: vi.fn() }

    await handler({}, res)

    expect(global.WIKI.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Contributor service returned 503 Service Unavailable' })
    )
    expect(res.json).toHaveBeenCalledWith([])
  })
})
