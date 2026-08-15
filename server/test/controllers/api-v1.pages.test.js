vi.mock('express', () => {
  const router = { get: vi.fn(), use: vi.fn() }
  const expressMock = { Router: () => router, __router: router }
  return { default: expressMock, ...expressMock }
})

vi.mock('../../operations/pages.ts', () => ({
  default: {
    get: vi.fn(),
    list: vi.fn()
  }
}))

import * as express from 'express'
import pageOperations from '../../operations/pages.ts'
import { openApiDocument } from '../../controllers/api-v1/openapi.ts'


global.WIKI = {
  auth: { checkAccess: vi.fn().mockReturnValue(true) }
}
await import('../../controllers/api-v1/pages.ts')
const listHandler = express.__router.get.mock.calls.find(([path]) => path === '/')[1]
const response = () => {
  const res = { json: vi.fn(), status: vi.fn() }
  res.status.mockReturnValue(res)
  return res
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
    expect(openApiDocument.components.securitySchemes.bearerAuth).toMatchObject({
      scheme: 'bearer',
      type: 'http'
    })
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
