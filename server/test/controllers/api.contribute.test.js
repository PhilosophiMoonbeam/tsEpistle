jest.mock('express', () => {
  const routers = []

  return {
    Router: () => {
      const router = {
        get: jest.fn(),
        post: jest.fn(),
        use: jest.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }
})

jest.mock('express-brute', () => {
  return jest.fn().mockImplementation(() => ({
    prevent: jest.fn((req, res, next) => next())
  }))
})

jest.mock('../../helpers/brute-knex', () => {
  return jest.fn().mockImplementation(() => ({}))
})

jest.mock('request-promise', () => jest.fn())

let request

describe('controllers/api contribute endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0
    request = require('request-promise')
    request.mockReset()

    global.WIKI = {
      models: {
        knex: {}
      },
      logger: {
        warn: jest.fn()
      }
    }
  })

  const loadContributorsHandler = () => {
    const express = require('express')
    require('../../controllers/api/contribute')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/contributors')[1]
  }

  it('registers contributors route', () => {
    const handler = loadContributorsHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/contribute', expect.any(Object))
  })

  it('requests upstream sponsors backers using the expected GraphQL request shape', async () => {
    request.mockResolvedValue({ data: { sponsors: { list: [] } } })
    const handler = loadContributorsHandler()
    const res = { json: jest.fn() }

    await handler({}, res)

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      uri: 'https://graph.requarks.io',
      json: true,
      body: {
        query: expect.stringContaining('list(kind: BACKER)'),
        variables: {}
      }
    })
    const query = request.mock.calls[0][0].body.query
    expect(query).toContain('id')
    expect(query).toContain('source')
    expect(query).toContain('name')
    expect(query).toContain('joined')
    expect(query).toContain('website')
    expect(query).toContain('twitter')
    expect(query).toContain('avatar')
  })

  it('returns strict allowlisted contributor fields without upstream extras', async () => {
    request.mockResolvedValue({
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
    })
    const handler = loadContributorsHandler()
    const res = { json: jest.fn() }

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
    request.mockResolvedValue({
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
    })
    const handler = loadContributorsHandler()
    const res = { json: jest.fn() }

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
    request.mockResolvedValue({ data: { sponsors: {} } })
    const handler = loadContributorsHandler()
    const res = { json: jest.fn() }

    await handler({}, res)

    expect(res.json).toHaveBeenCalledWith([])
  })

  it('logs upstream failures and returns an empty array', async () => {
    const err = new Error('upstream failed')
    request.mockRejectedValue(err)
    const handler = loadContributorsHandler()
    const res = { json: jest.fn() }

    await handler({}, res)

    expect(global.WIKI.logger.warn).toHaveBeenCalledWith(err)
    expect(res.json).toHaveBeenCalledWith([])
  })
})
