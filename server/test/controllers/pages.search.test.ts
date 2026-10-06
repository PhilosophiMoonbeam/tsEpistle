import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const search = vi.fn()
vi.mockModule('../../operations/pages.ts', import.meta.url, () => ({ default: { search } }))
vi.mockModule('../../operations/page-locale-relations.ts', import.meta.url, () => ({
  linkPageLocaleRelation: vi.fn(),
  listPageLocaleRelations: vi.fn(),
  unlinkPageLocaleRelation: vi.fn()
}))
vi.mockModule('../../operations/page-watching.ts', import.meta.url, () => ({
  getPageWatchState: vi.fn(),
  listPageWatchNotifications: vi.fn(),
  markPageWatchNotificationRead: vi.fn(),
  unwatchPage: vi.fn(),
  watchPage: vi.fn()
}))
vi.mockModule('../../operations/approvals.ts', import.meta.url, () => ({
  getPageApproval: vi.fn(),
  listApprovalInbox: vi.fn(),
  submitPageApproval: vi.fn(),
  transitionApproval: vi.fn()
}))
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({
  assertPageUnlocked: vi.fn(),
  getPageProtection: vi.fn(),
  removePageProtection: vi.fn(),
  setPageProtection: vi.fn(),
  unlockPage: vi.fn()
}))
vi.mockModule('../../operations/deleted-page-recovery.ts', import.meta.url, () => ({ default: {} }))
vi.mockModule('../../okf/page-view.ts', import.meta.url, () => ({ buildPageOkfView: vi.fn() }))

interface SearchResult {
  id: number
  locale: string
  path: string
  visibility: string
  title: string
}
interface SearchResponse {
  results: SearchResult[]
  nextCursor: string | null
  snapshotCount: number
}

const ids = Array.from({ length: 45 }, (_, index) => index + 1)
const rows = ids.map(id => ({ id, locale: 'en', path: `docs/page-${id}`, visibility: 'private', title: `Page ${id}` }))
let server: Server
let baseUrl: string

beforeAll(async () => {
  const { default: router } = await vi.importFresh('../../controllers/api/pages.ts', import.meta.url)
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 7 } as Express.User
    req.sessionID = 'search-request-regression'
    next()
  })
  app.use('/pages', router)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Search test server did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}/pages/search`
})
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
})
beforeEach(() => {
  search.mockReset()
  search.mockResolvedValue({ results: rows, suggestions: [], totalHits: rows.length })
})

describe('page search HTTP query boundary', () => {
  it('rejects duplicate, structured, and empty cursors instead of restarting the search', async () => {
    for (const cursor of ['cursor=bad&cursor=other', 'cursor[]=bad', 'cursor[token]=bad', 'cursor=']) {
      const response = await fetch(`${baseUrl}?query=docs&paginated=true&${cursor}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: expect.any(String) })
    }
    expect(search).not.toHaveBeenCalled()
    const malformed = await fetch(`${baseUrl}?query=docs&paginated=true&cursor=bad`)
    expect(malformed.status).toBe(409)
    expect(search).not.toHaveBeenCalled()
  })

  it('rejects malformed locale, path, and pagination values before scope normalization', async () => {
    for (const malformed of [
      'locale=en&locale=fr',
      'locale[]=en',
      'locale[value]=en',
      'path=docs&path=private',
      'path[]=docs',
      'path[value]=docs',
      'paginated=true&paginated=false',
      'paginated[]=true',
      'paginated[value]=true',
      'paginated=',
      'paginated=other'
    ]) {
      const response = await fetch(`${baseUrl}?query=docs&${malformed}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: expect.any(String) })
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('preserves false pagination and binds continuation to its original scope', async () => {
    const ordinary = await fetch(`${baseUrl}?query=docs&paginated=false&locale=en&path=docs`)
    expect(ordinary.status).toBe(200)
    expect(search).toHaveBeenLastCalledWith({ requester: { id: 7 }, query: 'docs', locale: 'en', path: 'docs' })
    const first = await fetch(`${baseUrl}?query=docs&paginated=true&locale=en&path=docs`)
    expect(first.status).toBe(200)
    const snapshot = (await first.json()) as SearchResponse
    expect(snapshot.results.map(row => row.id)).toEqual(ids.slice(0, 20))
    expect(snapshot.nextCursor).not.toBeNull()
    expect(search).toHaveBeenLastCalledWith({ requester: { id: 7 }, query: 'docs', locale: 'en', path: 'docs', limit: 1001 })
    search.mockClear()
    const cursor = encodeURIComponent(snapshot.nextCursor!)
    for (const malformed of ['locale=en&locale=fr&path=docs', 'locale=en&path=docs&path=other']) {
      const response = await fetch(`${baseUrl}?query=docs&paginated=true&cursor=${cursor}&${malformed}`)
      expect(response.status).toBe(400)
    }
    const changedScope = await fetch(`${baseUrl}?query=docs&paginated=true&cursor=${cursor}&locale=fr&path=docs`)
    expect(changedScope.status).toBe(409)
    expect(search).not.toHaveBeenCalled()
    const next = await fetch(`${baseUrl}?query=docs&paginated=true&cursor=${cursor}&locale=en&path=docs`)
    expect(next.status).toBe(200)
    const continuation = (await next.json()) as SearchResponse
    expect(continuation.results.map(row => row.id)).toEqual(ids.slice(20, 40))
    expect(search).toHaveBeenLastCalledWith({
      requester: { id: 7 },
      query: 'docs',
      locale: 'en',
      path: 'docs',
      limit: 1001,
      agentScope: { kind: 'selected', pageIds: ids }
    })
  })
})
