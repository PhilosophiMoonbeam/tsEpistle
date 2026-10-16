import express from 'express'
import createKnex from 'knex'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { Mock } from '../bun-test.mts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import errors from '../../operations/errors.ts'
import { waitForPageRender } from '../../../client/helpers/pages-api.ts'
import type { WikiSource } from '../../../shared/wiki-source.ts'
import type pageOperations from '../../operations/pages.ts'

type Preview = typeof pageOperations.preview

const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
const originalRuntime = getTransportRuntime<object>()
const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
const wiki = {
  ROOTPATH: fileURLToPath(new URL('../../../', import.meta.url)),
  SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
  config: {
    lang: { code: 'en', namespacing: false, namespaces: [] },
    db: { type: 'sqlite' },
    sessionSecret: 'preview-http-regression-key'
  },
  models: { knex: db },
  data: {},
  cache: { get: async () => [] },
  auth: { checkAccess: () => false },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}
const sessionId = 'authorized-preview-session'
const sessionCookie = `preview-session=${sessionId}`
const pendingCode = 'PAGE_RENDER_PENDING'
const readySource: WikiSource = {
  id: 7,
  locale: 'en',
  path: 'docs/saved-page',
  title: 'Saved page',
  description: '',
  visibility: 'private',
  updatedAt: '2026-10-16T00:00:00.000Z',
  sourceRevision: '42',
  excerpt: 'Saved content',
  excerptTruncated: false
}
const target = { id: 7, sourceRevision: '42', locale: 'en', path: 'docs/saved-page', visibility: 'private' as const }
const requests: Array<{ method: string; url: string; cookie: string }> = []
let preview: Mock<Preview> | undefined
let server: Server | undefined
let baseUrl: string

const loopbackFetch: Parameters<typeof waitForPageRender>[0] = (path, init) =>
  fetch(new URL(path, baseUrl), { ...init, headers: { ...init.headers, Cookie: sessionCookie } })
const requestPreview = () => fetch(`${baseUrl}/_api/pages/preview?id=7`, { headers: { Cookie: sessionCookie } })

beforeAll(async () => {
  // Static imports would capture WIKI before this complete fixture is installed.
  Reflect.set(globalThis, 'WIKI', wiki)
  configureTransportRuntime(wiki)
  const { default: operations } = await import('../../operations/pages.ts')
  preview = vi.spyOn(operations, 'preview')
  const { default: router } = await import('../../controllers/api/index.ts')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const cookie = req.get('Cookie') ?? ''
    requests.push({ method: req.method, url: req.originalUrl, cookie })
    const context = req as typeof req & { user?: { id: number }; sessionID: string }
    // Supply only the authenticated transport context; the preview operation remains the authority seam.
    if (cookie === sessionCookie) {
      context.user = { id: 7 }
      context.sessionID = sessionId
    } else context.sessionID = ''
    next()
  })
  app.use('/_api', router)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server!.once('listening', resolve)
    server!.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Preview test server did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  try {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => (error ? reject(error) : resolve())))
  } finally {
    preview?.mockRestore()
    try {
      await db.destroy()
    } finally {
      configureTransportRuntime(originalRuntime)
      if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
      else Reflect.deleteProperty(globalThis, 'WIKI')
    }
  }
})

beforeEach(() => {
  preview!.mockReset()
  requests.length = 0
})

describe('page preview pending-render HTTP contract', () => {
  it('publishes only the fixed pending message and code for the typed operation exception', async () => {
    preview!.mockRejectedValue(new errors.ApplicationError('private renderer diagnostic: secret-token', { status: 503, code: pendingCode }))

    const response = await requestPreview()

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')?.split(/\s*,\s*/)).toContain('Cookie')
    expect(await response.json()).toEqual({
      error: 'The page render is pending for its current source revision. Retry shortly.',
      code: 'PAGE_RENDER_PENDING'
    })
  })

  it('keeps unrelated typed 503 failures behind the real API error redaction', async () => {
    preview!.mockRejectedValue(new errors.ApplicationError('database password=private-secret', { status: 503, code: 'BACKEND_UNAVAILABLE' }))

    const response = await requestPreview()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Internal Server Error' })
  })

  it('does not trust a pending name or code forged onto an ordinary Error', async () => {
    preview!.mockRejectedValue(Object.assign(new Error('forged pending secret-token'), { name: pendingCode, code: pendingCode, status: 503 }))

    const response = await requestPreview()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Internal Server Error' })
  })

  it('stops the real client wait on an authoritative 404 denial rather than polling it as pending', async () => {
    preview!.mockRejectedValue(new errors.ApplicationError('This page does not exist.', { status: 404, code: 'PAGE_NOT_FOUND' }))

    const failure: unknown = await waitForPageRender(loopbackFetch, target, AbortSignal.timeout(2_000)).then(
      () => undefined,
      error => error
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ status: 404, message: 'This page does not exist.' })
    expect(failure).not.toHaveProperty('code')
    expect(requests.map(request => [request.method, request.url])).toEqual([['GET', '/_api/pages/preview?id=7']])
  })

  it('lets the real client wait reach the exact saved revision using authorized GETs without replaying a mutation', async () => {
    let pending = true
    preview!.mockImplementation(async input => {
      if (input.requester?.id !== 7 || input.sessionId !== sessionId || input.id !== readySource.id) {
        throw new errors.ApplicationError('This page does not exist.', { status: 404, code: 'PAGE_NOT_FOUND' })
      }
      if (pending) {
        pending = false
        throw new errors.ApplicationError('renderer diagnostic must stay private', { status: 503, code: pendingCode })
      }
      return readySource
    })

    await expect(waitForPageRender(loopbackFetch, target, AbortSignal.timeout(2_000))).resolves.toBeUndefined()

    expect(requests.map(request => [request.method, request.url, request.cookie])).toEqual([
      ['GET', '/_api/pages/preview?id=7', sessionCookie],
      ['GET', '/_api/pages/preview?id=7', sessionCookie]
    ])
  })
})
