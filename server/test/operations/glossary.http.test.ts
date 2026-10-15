import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import errors from '../../operations/errors.ts'

const routes = new Map<string, (request: unknown, response: unknown) => Promise<void>>()
const read = vi.fn()
vi.mockModule('express', import.meta.url, () => ({
  default: {
    Router: () => ({
      use: () => undefined,
      get: (path: string, handler: (request: unknown, response: unknown) => Promise<void>) => {
        routes.set(`GET ${path}`, handler)
      },
      post: () => undefined,
      put: () => undefined,
      delete: () => undefined
    })
  }
}))
vi.mockModule('../../operations/glossary.ts', import.meta.url, () => ({ glossaryOperations: () => ({ get: read }) }))
// Exercise controller registration only after installing the isolated transport/module mocks.
await import('../../controllers/api/glossary.ts')
const request = { user: { id: 7 }, sessionID: 'current-session', params: { id: '12' } }
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('glossary public error boundary', () => {
  beforeEach(() => {
    read.mockReset()
  })
  it('publishes deliberate authorization failures but never driver messages or arbitrary status-shaped exceptions', async () => {
    const get = routes.get('GET /terms/:id')!
    read.mockRejectedValue(new errors.ApplicationError('Glossary access denied.', { status: 403, code: 'GLOSSARY_FORBIDDEN' }))
    let res = response()
    await get(request, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Glossary access denied.', code: 'GLOSSARY_FORBIDDEN' })
    for (const failure of [new Error('password=private-database-secret'), Object.assign(new Error('private row and query values'), { status: 400 })]) {
      read.mockRejectedValue(failure)
      res = response()
      await get(request, res)
      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'Glossary request failed.', code: 'GLOSSARY_REQUEST_FAILED' })
    }
  })
})
