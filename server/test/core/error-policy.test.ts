import graphHelper from '../../helpers/graph.ts'

const API_MODULES = [
  'analytics',
  'assets',
  'auth',
  'comments',
  'contribute',
  'content-extensions',
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
  'users',
  'webhooks'
]

const loadApiErrorHandler = async () => {
  const routers: Array<{ use: { mock: { calls: unknown[][] } } }> = []
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
    }
  }
  vi.mockModule('express', import.meta.url, () => ({ default: express, ...express }))
  for (const moduleName of API_MODULES) {
    vi.mockModule(`../../controllers/api/${moduleName}.ts`, import.meta.url, () => ({ default: {} }))
  }
  await vi.importFresh('../../controllers/api/index.ts', import.meta.url)
  const router = routers.at(-1)
  if (!router) throw new Error('API router was not created')
  const handler = router.use.mock.calls.find(([candidate]) => typeof candidate === 'function' && candidate.length === 4)?.[0]
  if (typeof handler !== 'function') throw new Error('API error handler was not mounted')
  return handler
}

const response = () => {
  const res = { json: vi.fn(), status: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe('server unexpected-error policy', () => {
  let previousWiki: unknown
  let logger: { error: { (value: unknown): void; mockClear(): void } }

  beforeEach(() => {
    previousWiki = global.WIKI
    logger = { error: vi.fn() }
    global.WIKI = { logger }
  })

  afterEach(() => {
    global.WIKI = previousWiki as Record<string, unknown>
    vi.unmockModule('express', import.meta.url)
    for (const moduleName of API_MODULES) {
      vi.unmockModule(`../../controllers/api/${moduleName}.ts`, import.meta.url)
    }
    vi.restoreAllMocks()
  })

  it('masks and logs unexpected GraphQL mutation errors', () => {
    const cause = new Error('database password is secret')

    expect(graphHelper.generateError(cause)).toEqual({
      responseResult: {
        succeeded: false,
        errorCode: 1,
        slug: 'unexpected',
        message: 'An unexpected error occurred.'
      }
    })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(cause)
  })

  it('still masks unexpected GraphQL errors when error logging is unavailable', () => {
    global.WIKI = { logger: {} }
    const cause = new Error('database password is secret')

    expect(graphHelper.generateError(cause, false)).toEqual({
      succeeded: false,
      errorCode: 1,
      slug: 'unexpected',
      message: 'An unexpected error occurred.'
    })
  })

  it('keeps classified GraphQL validation and conflict contracts public without logging', () => {
    const validation = Object.assign(new Error('The input is invalid.'), {
      code: 1012,
      name: 'InputInvalid',
      status: 422
    })
    const conflict = Object.assign(new Error('The page changed.'), {
      code: 6006,
      name: 'PagePathCollision',
      status: 409
    })
    const legacyDomainError = Object.assign(new Error('This page does not exist.'), {
      code: 6003,
      name: 'PageNotFound'
    })

    expect(graphHelper.generateError(validation, false)).toEqual({
      succeeded: false,
      errorCode: 1012,
      slug: 'InputInvalid',
      message: 'The input is invalid.'
    })
    expect(graphHelper.generateError(conflict, false)).toEqual({
      succeeded: false,
      errorCode: 6006,
      slug: 'PagePathCollision',
      message: 'The page changed.'
    })
    expect(graphHelper.generateError(legacyDomainError, false)).toEqual({
      succeeded: false,
      errorCode: 6003,
      slug: 'PageNotFound',
      message: 'This page does not exist.'
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('masks and logs unexpected REST errors while preserving classified 4xx messages', async () => {
    const errorHandler = await loadApiErrorHandler()
    const cause = new Error('database password is secret')
    const internalResponse = response()

    errorHandler(cause, {}, internalResponse, vi.fn())

    expect(internalResponse.status).toHaveBeenCalledWith(500)
    expect(internalResponse.json).toHaveBeenCalledWith({ error: 'Internal Server Error' })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(cause)

    logger.error.mockClear()
    const conflict = Object.assign(new Error('The page changed.'), { status: 409 })
    const conflictResponse = response()
    errorHandler(conflict, {}, conflictResponse, vi.fn())

    expect(conflictResponse.status).toHaveBeenCalledWith(409)
    expect(conflictResponse.json).toHaveBeenCalledWith({ error: 'The page changed.' })
    expect(logger.error).not.toHaveBeenCalled()
  })
})
