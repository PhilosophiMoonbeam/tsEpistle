vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

const { default: express } = await import('express')

class BruteTooManyAttempts extends Error {
  constructor () {
    super('Too many attempts! Try again later.')
  }
}
class CommentNotFound extends Error {}
class CommentViewForbidden extends Error {}

const rateLimitKnex = () => {
  const rows = new Map()
  return {
    raw: vi.fn(async (_query, [key, expire, now]) => {
      const current = rows.get(key)
      const startsNewWindow = current === undefined || current.expire === null || current.expire <= now
      const row = startsNewWindow
        ? { points: 1, expire }
        : { points: current.points + 1, expire: current.expire }
      rows.set(key, row)
      return { rows: [row] }
    })
  }
}

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
    vi.mockModule(`../../controllers/api/${name}.ts`, import.meta.url, () => ({
      default: subrouters[name]
    }))
  }

  try {
    expect(await vi.importFresh('../../controllers/api/index.ts', import.meta.url)).toBeDefined()
  } finally {
    for (const name of API_CONTROLLER_NAMES) {
      vi.unmockModule(`../../controllers/api/${name}.ts`, import.meta.url)
    }
  }

  return { apiRouter: express.__routers.at(-1), subrouters }
}

describe('controllers/api comments endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn((requester, permissions) =>
          permissions.some(permission => requester?.permissions?.includes(permission))
        )
      },
      Error: { BruteTooManyAttempts, CommentNotFound, CommentViewForbidden },
      data: {
        commentProvider: {
          getCommentById: vi.fn().mockResolvedValue({
            id: 31,
            pageId: 17,
            content: 'Useful guide',
            render: '<p>Useful guide</p>',
            authorId: 12,
            name: 'Commenter',
            email: 'commenter@example.test',
            ip: '192.0.2.31',
            createdAt: '2026-08-30T00:00:00.000Z',
            updatedAt: '2026-08-30T00:00:00.000Z'
          })
        },
        commentProviders: [
          {
            key: 'default',
            title: 'Default Comments',
            description: 'Built-in comments provider.',
            logo: '/_assets/comments/default.svg',
            website: 'https://example.invalid/comments/default',
            isAvailable: true,
            props: {
              displayMode: {
                type: 'string',
                title: 'Display Mode',
                order: 2
              },
              requireApproval: {
                type: 'boolean',
                title: 'Require Approval',
                order: 1,
                hint: 'Require approval before publishing.'
              }
            },
            unrelatedMetadata: 'do-not-return'
          },
          {
            key: 'external',
            title: 'External Comments',
            description: 'External comments provider.',
            logo: '/_assets/comments/external.svg',
            website: 'https://example.invalid/comments/external',
            isAvailable: false,
            props: {}
          }
        ]
      },
      models: {
        knex: rateLimitKnex(),
        pages: {
          query: vi.fn(() => {
            const query = {
              select: vi.fn().mockReturnThis(),
              findById: vi.fn().mockReturnThis(),
              withGraphJoined: vi.fn().mockReturnThis(),
              modifyGraph: vi.fn().mockResolvedValue({
                id: 17,
                localeCode: 'en',
                path: 'guide',
                tags: [],
                visibility: 'public',
                ownerId: null
              })
            }
            return query
          })
        },
        commentProviders: {
          query: vi.fn(),
          initProvider: vi.fn().mockResolvedValue(true),
          getProviders: vi.fn().mockResolvedValue([
            {
              key: 'default',
              isEnabled: 1,
              config: {
                displayMode: 'compact',
                requireApproval: true,
                undeclaredSetting: 'do-not-return'
              },
              privateField: 'do-not-return',
              props: {
                raw: true
              }
            },
            {
              key: 'external',
              isEnabled: 0,
              config: {},
              privateField: 'do-not-return'
            }
          ])
        },
        comments: {
          query: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([{
                id: 31,
                pageId: 17,
                content: 'Useful guide',
                render: '<p>Useful guide</p>',
                authorId: 12,
                name: 'Commenter',
                email: 'commenter@example.test',
                ip: '192.0.2.31',
                createdAt: '2026-08-30T00:00:00.000Z',
                updatedAt: '2026-08-30T00:00:00.000Z'
              }])
            }))
          })),
          postNewComment: vi.fn().mockResolvedValue(73),
          updateComment: vi.fn().mockResolvedValue('<p>Updated</p>'),
          deleteComment: vi.fn().mockResolvedValue(true)
        }
      },
      logger: { warn: vi.fn() }
    }

    global.WIKI.models.commentProviders.query.mockImplementation(() => {
      const query = {
        patch: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(1)
      }
      global.WIKI.models.commentProviders.__queries = global.WIKI.models.commentProviders.__queries || []
      global.WIKI.models.commentProviders.__queries.push(query)
      return query
    })
  })

  const loadHandlers = async () => {
    await vi.importFresh('../../controllers/api/comments.ts', import.meta.url)
    const router = express.__routers[0]
    return {
      list: router.get.mock.calls.find(([path]) => path === '/')[1],
      create: router.post.mock.calls.find(([path]) => path === '/')[1],
      get: router.get.mock.calls.find(([path]) => path === '/:id')[1],
      update: router.patch.mock.calls.find(([path]) => path === '/:id')[1],
      remove: router.delete.mock.calls.find(([path]) => path === '/:id')[1],
      providers: router.get.mock.calls.find(([path]) => path === '/providers')[1],
      saveProviders: router.post.mock.calls.find(([path]) => path === '/providers')[1]
    }
  }

  const loadProvidersHandler = async () => (await loadHandlers()).providers

  it('registers comment CRUD and provider routes', async () => { const handlers = await loadHandlers()

  expect(typeof handlers.list).toBe('function')
  expect(typeof handlers.create).toBe('function')
  expect(typeof handlers.get).toBe('function')
  expect(typeof handlers.update).toBe('function')
  expect(typeof handlers.remove).toBe('function')
  expect(typeof handlers.providers).toBe('function')
  expect(typeof handlers.saveProviders).toBe('function') })


  it('returns 403 for unauthorized provider requests without querying providers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadProvidersHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.getProviders).not.toHaveBeenCalled()
  })

  it('returns allowlisted provider fields without raw props or internal fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    expect(global.WIKI.models.commentProviders.getProviders).toHaveBeenCalledWith()
    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: true,
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: expect.any(Array)
      },
      {
        isEnabled: false,
        key: 'external',
        title: 'External Comments',
        description: 'External comments provider.',
        logo: '/_assets/comments/external.svg',
        website: 'https://example.invalid/comments/external',
        isAvailable: false,
        config: []
      }
    ])
    const row = res.json.mock.calls[0][0][0]
    expect(row).not.toHaveProperty('props')
    expect(row).not.toHaveProperty('privateField')
    expect(row).not.toHaveProperty('unrelatedMetadata')
    expect(row).not.toHaveProperty('undeclaredSetting')
  })

  it('merges config with provider metadata as JSON strings sorted by config key and omits unknown config keys', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    const config = res.json.mock.calls[0][0][0].config
    expect(config.map(row => row.key)).toEqual(['displayMode', 'requireApproval'])
    expect(config).toEqual([
      {
        key: 'displayMode',
        value: JSON.stringify({
          type: 'string',
          title: 'Display Mode',
          order: 2,
          value: 'compact'
        })
      },
      {
        key: 'requireApproval',
        value: JSON.stringify({
          type: 'boolean',
          title: 'Require Approval',
          order: 1,
          hint: 'Require approval before publishing.',
          value: true
        })
      }
    ])
  })

  const createSavePayload = () => ({
    body: {
      providers: [
        {
          key: 'default',
          isEnabled: true,
          config: [
            { key: 'displayMode', value: JSON.stringify({ v: 'expanded' }) },
            { key: 'missingValue', value: JSON.stringify({ label: 'No value key' }) }
          ]
        },
        {
          key: 'external',
          isEnabled: false,
          config: [
            { key: 'endpoint', value: JSON.stringify({ v: 'https://example.invalid/comments' }) }
          ]
        }
      ]
    },
    user: { permissions: ['manage:system'] }
  })

  it('returns JSON 403 for unauthorized provider saves without mutating models', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { saveProviders } = await loadHandlers()
    const req = createSavePayload()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.models.commentProviders.query).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('saves providers with GraphQL parity and initializes the active comment provider', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(createSavePayload(), res)

    const queries = global.WIKI.models.commentProviders.__queries
    expect(queries).toHaveLength(2)
    expect(queries[0].patch).toHaveBeenCalledWith({
      isEnabled: true,
      config: {
        displayMode: 'expanded',
        missingValue: null
      }
    })
    expect(queries[0].where).toHaveBeenCalledWith('key', 'default')
    expect(queries[1].patch).toHaveBeenCalledWith({
      isEnabled: false,
      config: {
        endpoint: 'https://example.invalid/comments'
      }
    })
    expect(queries[1].where).toHaveBeenCalledWith('key', 'external')
    expect(global.WIKI.models.commentProviders.initProvider).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Comment Providers updated successfully' })
  })

  it('returns JSON 400 for malformed provider save payloads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders({ body: { providers: [{ key: 'default', isEnabled: 'yes', config: [] }] }, user: {} }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid comment providers payload' })
    expect(global.WIKI.models.commentProviders.query).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed provider save config JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = await loadHandlers()
    const req = createSavePayload()
    req.body.providers[0].config[0].value = '{not-json'
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid comment providers payload' })
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('forwards unexpected provider save failures to the shared error policy', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('comment save failed')
    const query = {
      patch: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(err)
    }
    global.WIKI.models.commentProviders.query.mockReturnValue(query)
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const next = vi.fn()

    await saveProviders(createSavePayload(), res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('forwards unexpected comment provider initialization failures to the shared error policy', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('init failed')
    global.WIKI.models.commentProviders.initProvider.mockRejectedValueOnce(err)
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const next = vi.fn()

    await saveProviders(createSavePayload(), res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('comments failed')
    global.WIKI.models.commentProviders.getProviders.mockRejectedValue(err)
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    await handler({ user: {} }, res, next)
    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })


  it('omits email and IP audit fields from REST and GraphQL reads for ordinary readers', async () => {
    const handlers = await loadHandlers()
    const { default: resolver } = await vi.importFresh('../../graph/resolvers/comment.ts', import.meta.url)
    const requester = { id: 12, permissions: ['read:pages', 'read:comments'] }
    const listRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const getRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const next = vi.fn()

    await handlers.list({ user: requester, query: { pageId: '17' } }, listRes, next)
    await handlers.get({ user: requester, params: { id: '31' } }, getRes, next)
    const graphList = await resolver.CommentQuery.list(null, { pageId: 17 }, { req: { user: requester } })
    const graphSingle = await resolver.CommentQuery.single(null, { id: 31 }, { req: { user: requester } })

    const readDtos = [
      listRes.json.mock.calls[0][0][0],
      getRes.json.mock.calls[0][0],
      graphList[0],
      graphSingle
    ]
    for (const dto of readDtos) {
      expect(dto).toMatchObject({ id: 31, authorName: 'Commenter' })
      expect(dto).not.toHaveProperty('email')
      expect(dto).not.toHaveProperty('ip')
      expect(dto).not.toHaveProperty('authorEmail')
      expect(dto).not.toHaveProperty('authorIP')
    }
    expect(next).not.toHaveBeenCalled()
  })

  it('returns email and IP audit fields through REST and GraphQL only to system managers', async () => {
    const handlers = await loadHandlers()
    const { default: resolver } = await vi.importFresh('../../graph/resolvers/comment.ts', import.meta.url)
    const requester = { id: 1, permissions: ['read:pages', 'read:comments', 'manage:system'] }
    const listRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const getRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const next = vi.fn()

    await handlers.list({ user: requester, query: { pageId: '17' } }, listRes, next)
    await handlers.get({ user: requester, params: { id: '31' } }, getRes, next)
    const graphList = await resolver.CommentQuery.list(null, { pageId: 17 }, { req: { user: requester } })
    const graphSingle = await resolver.CommentQuery.single(null, { id: 31 }, { req: { user: requester } })

    const readDtos = [
      listRes.json.mock.calls[0][0][0],
      getRes.json.mock.calls[0][0],
      graphList[0],
      graphSingle
    ]
    for (const dto of readDtos) {
      expect(dto).toMatchObject({
        id: 31,
        authorName: 'Commenter',
        authorEmail: 'commenter@example.test',
        authorIP: '192.0.2.31'
      })
      expect(dto).not.toHaveProperty('email')
      expect(dto).not.toHaveProperty('ip')
    }
    expect(next).not.toHaveBeenCalled()
  })


  it('creates, updates, and deletes comments through shared operations', async () => {
    const handlers = await loadHandlers()
    const user = { id: 12 }
    const createReq = {
      user,
      ip: '127.0.0.1',
      body: {
        pageId: 9,
        replyTo: 0,
        content: 'New comment',
        guestName: '',
        guestEmail: ''
      }
    }
    const createRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handlers.create(createReq, createRes)

    expect(global.WIKI.models.comments.postNewComment).toHaveBeenCalledWith({
      ...createReq.body,
      user,
      ip: createReq.ip
    })
    expect(createRes.status).toHaveBeenCalledWith(201)
    expect(createRes.json).toHaveBeenCalledWith({ id: 73 })

    const updateReq = { user, ip: '127.0.0.2', params: { id: '73' }, body: { content: 'Updated' } }
    const updateRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    await handlers.update(updateReq, updateRes)
    expect(global.WIKI.models.comments.updateComment).toHaveBeenCalledWith({
      id: 73,
      content: 'Updated',
      user,
      ip: updateReq.ip
    })
    expect(updateRes.json).toHaveBeenCalledWith({ render: '<p>Updated</p>' })

    const deleteReq = { user, ip: '127.0.0.3', params: { id: '73' } }
    const deleteRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    await handlers.remove(deleteReq, deleteRes)
    expect(global.WIKI.models.comments.deleteComment).toHaveBeenCalledWith({ id: 73, user, ip: deleteReq.ip })
    expect(deleteRes.json).toHaveBeenCalledWith({ message: 'Comment deleted successfully' })
  })

  it('delegates unexpected comment mutation failures without serializing internal messages', async () => {
    const err = new Error('comment database credentials rejected')
    global.WIKI.models.comments.postNewComment.mockRejectedValueOnce(err)
    const { create } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const next = vi.fn()

    await create({
      user: { id: 12 },
      ip: '127.0.0.1',
      body: { pageId: 9, content: 'New comment' }
    }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('throttles repeated creates through the shared durable operation contract', async () => {
    const { create } = await loadHandlers()
    const req = {
      user: { id: 12 },
      ip: '127.0.0.1',
      body: { pageId: 9, content: 'New comment' }
    }
    const firstRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    const repeatedRes = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await create(req, firstRes)
    await create(req, repeatedRes)

    expect(firstRes.status).toHaveBeenCalledWith(201)
    expect(global.WIKI.models.comments.postNewComment).toHaveBeenCalledTimes(1)
    expect(global.WIKI.models.knex.raw).toHaveBeenCalledTimes(2)
    expect(global.WIKI.models.knex.raw).toHaveBeenLastCalledWith(
      expect.any(String),
      ['comment-create:12:127.0.0.1', expect.any(Number), expect.any(Number), expect.any(Number)]
    )
    expect(repeatedRes.status).toHaveBeenCalledWith(429)
    expect(repeatedRes.json).toHaveBeenCalledWith({ error: 'Too many attempts! Try again later.' })
  })

  it('rejects malformed comment ids before calling shared operations', async () => {
    const handlers = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handlers.update({ params: { id: '0' }, body: { content: 'Updated' } }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'comment id must be a positive integer' })
    expect(global.WIKI.models.comments.updateComment).not.toHaveBeenCalled()
  })
  it('is mounted by the API index router', async () => {
    const { apiRouter, subrouters } = await loadApiIndexRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/comments', subrouters.comments)
  })
})
