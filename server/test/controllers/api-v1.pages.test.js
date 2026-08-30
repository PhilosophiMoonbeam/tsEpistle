vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const expressMock = {
    Router: () => {
      const router = { get: vi.fn(), use: vi.fn() }
      routers.push(router)
      return router
    },
    __routers: routers
  }
  return { default: expressMock, ...expressMock }
})

vi.mockModule('../../operations/pages.ts', import.meta.url, () => ({
  default: {
    get: vi.fn(),
    list: vi.fn()
  }
}))

const express = await import('express')
const { configureTransportRuntime } = await import('../../controllers/_types.ts')
const { default: pageOperations } = await import('../../operations/pages.ts')
import { openApiDocument } from '../../controllers/api-v1/openapi.ts'

const logger = { error: vi.fn() }
global.WIKI = {
  auth: { checkAccess: vi.fn().mockReturnValue(true) }
}
configureTransportRuntime({ auth: global.WIKI.auth, logger })

await import('../../controllers/api-v1/pages.ts')
const pagesRouter = express.__routers[0]
const listHandler = pagesRouter.get.mock.calls.find(([path]) => path === '/')[1]
await import('../../controllers/api-v1/index.ts')
const apiRouter = express.__routers[1]
const openApiHandler = apiRouter.get.mock.calls.find(([path]) => path === '/openapi.json')[1]
const requireApiKey = apiRouter.use.mock.calls.find(([handler]) => typeof handler === 'function' && handler.length === 3)[0]
const notFoundHandler = apiRouter.use.mock.calls.find(([handler]) => typeof handler === 'function' && handler.length === 2)[0]
const errorHandler = apiRouter.use.mock.calls.find(([handler]) => typeof handler === 'function' && handler.length === 4)[0]
const response = () => {
  const res = { json: vi.fn(), status: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

const expectErrorBody = (res, status, error) => {
  expect(res.status).toHaveBeenCalledWith(status)
  expect(res.json).toHaveBeenCalledWith({ error })
  expect(Object.keys(res.json.mock.calls[0][0])).toEqual(['error'])
}

const page = id => ({
  contentType: 'markdown',
  createdAt: '2026-08-01T00:00:00.000Z',
  description: `Page ${id}`,
  id,
  isPublished: true,
  locale: 'en',
  localeCode: 'en',
  ownerId: null,
  path: `docs/${id}`,
  tags: ['docs'],
  title: `Page ${id}`,
  updatedAt: '2026-08-02T00:00:00.000Z',
  visibility: 'public'
})

describe('versioned REST pages API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.WIKI.auth.checkAccess.mockReturnValue(true)
  })

  it('publishes every supported external route in OpenAPI 3.1', () => {
    expect(openApiDocument.openapi).toBe('3.1.0')
    expect(Object.keys(openApiDocument.paths)).toEqual([
      '/openapi.json',
      '/pages',
      '/pages/{id}'
    ])
    expect(openApiDocument.paths['/openapi.json'].get.security).toEqual([])
    expect(openApiDocument.paths['/pages'].get.responses['500']).toEqual(
      openApiDocument.paths['/pages'].get.responses['401']
    )
    expect(openApiDocument.paths['/pages/{id}'].get.responses['500']).toEqual(
      openApiDocument.paths['/pages/{id}'].get.responses['401']
    )
    expect(openApiDocument.components.securitySchemes.bearerAuth).toMatchObject({
      scheme: 'bearer',
      type: 'http'
    })
    expect(openApiDocument.components.schemas.Error).toMatchObject({
      additionalProperties: false,
      required: ['error'],
      type: 'object'
    })
  })

  it('serves OpenAPI publicly before requiring an API key', () => {
    const res = response()

    openApiHandler({}, res)

    expect(res.json).toHaveBeenCalledWith(openApiDocument)
  })

  it.each([
    ['guest', { kind: 'guest', ownershipUserId: null, principal: {} }],
    ['ordinary user', { kind: 'user', userId: 7, ownershipUserId: 7, principal: { id: 7 } }]
  ])('rejects a %s principal before versioned operations', (_label, authContext) => {
    const res = response()
    const next = vi.fn()

    requireApiKey({ authContext }, res, next)

    expectErrorBody(res, 401, 'API key authentication required')
    expect(next).not.toHaveBeenCalled()
  })

  it('allows a valid API-key principal to proceed', () => {
    const principal = { id: 1, permissions: ['read:pages'] }
    const res = response()
    const next = vi.fn()

    requireApiKey({
      authContext: {
        kind: 'apiKey',
        apiKeyId: 9,
        groupId: 3,
        ownershipUserId: null,
        principal
      },
      user: principal
    }, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('maps unknown versioned routes to the closed error schema', () => {
    const res = response()

    notFoundHandler({}, res)

    expectErrorBody(res, 404, 'Not Found')
  })

  it('preserves safe 4xx messages and sanitizes logged internal failures', () => {
    const missing = Object.assign(new Error('Page does not exist'), { status: 404 })
    const missingResponse = response()

    errorHandler(missing, {}, missingResponse, vi.fn())

    expectErrorBody(missingResponse, 404, 'Page does not exist')
    expect(logger.error).not.toHaveBeenCalled()

    const internal = Object.assign(new Error('database password leaked'), { status: 503 })
    const internalResponse = response()

    errorHandler(internal, {}, internalResponse, vi.fn())

    expectErrorBody(internalResponse, 503, 'Internal Server Error')
    expect(logger.error).toHaveBeenCalledWith(internal)
  })

  it('returns bounded permission-filtered pagination', async () => {
    pageOperations.list.mockResolvedValue([page(1), page(2), page(3)])
    const handler = listHandler
    const req = {
      query: { limit: '2', offset: '0', tags: 'Docs' },
      user: { id: 7, permissions: ['read:pages'] }
    }
    const res = response()
    const next = vi.fn()

    await handler(req, res, next)

    expect(pageOperations.list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      offset: 0,
      requester: req.user,
      tags: ['docs']
    }))
    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 })],
      pagination: { limit: 2, nextOffset: 2, offset: 0 }
    }))
  })

  it('rejects unbounded page list requests', async () => {
    const handler = listHandler
    const res = response()

    await handler({ query: { limit: '101' }, user: { id: 7 } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(pageOperations.list).not.toHaveBeenCalled()
  })
})
