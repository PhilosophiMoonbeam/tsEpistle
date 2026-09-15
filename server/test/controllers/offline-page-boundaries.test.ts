import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const router = {
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  use: vi.fn()
}

const pageOperations = {
  get: vi.fn(),
  getOfflineSnapshot: vi.fn()
}
const auth = {
  checkAccess: vi.fn(),
  loadPageRuleAuthority: vi.fn()
}
const runtime = { models: { knex: vi.fn() } }
const canReadPage = vi.fn()
const canWritePage = vi.fn()
const managesSystem = vi.fn()
const principalId = vi.fn()
const canViewRestrictedPageFields = vi.fn()
const projectPageFields = vi.fn()
const buildPageOkfView = vi.fn()
const createAuthRateLimiter = vi.fn()
const setAuthRateLimitHeaders = vi.fn()

vi.mockModule('express', import.meta.url, () => ({
  default: { Router: () => router }
}))
vi.mockModule('../../operations/pages.ts', import.meta.url, () => ({ default: pageOperations }))
vi.mockModule('../../operations/page-locale-relations.ts', import.meta.url, () => ({
  linkPageLocaleRelation: vi.fn(),
  listPageLocaleRelations: vi.fn(),
  unlinkPageLocaleRelation: vi.fn()
}))
vi.mockModule('../../helpers/page-access.ts', import.meta.url, () => ({ canReadPage, canWritePage, managesSystem, principalId }))
vi.mockModule('../../helpers/page-field-projection.ts', import.meta.url, () => ({ canViewRestrictedPageFields, projectPageFields }))
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
vi.mockModule('../../helpers/auth-rate-limiter.ts', import.meta.url, () => ({ createAuthRateLimiter, setAuthRateLimitHeaders }))
vi.mockModule('../../okf/page-view.ts', import.meta.url, () => ({ buildPageOkfView }))
vi.mockModule('../../../shared/page-branding.ts', import.meta.url, () => ({
  PageBrandingAssignmentSchema: { safeParse: vi.fn(() => ({ success: false })) },
  PageBrandingViewSchema: { safeParse: vi.fn(() => ({ success: false })) }
}))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({
  getTransportRuntime: () => runtime,
  getWikiAuth: () => auth
}))

await vi.importFresh('../../controllers/api/pages.ts', import.meta.url)

const handlerFor = (path: string) => router.get.mock.calls.find(([registeredPath]) => registeredPath === path)?.[1]
const getPage = handlerFor('/:id')!
const getOfflineSnapshot = handlerFor('/:id/offline-snapshot')!

const response = () => {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    set: vi.fn(),
    status: vi.fn(),
    vary: vi.fn()
  }
  res.set.mockReturnValue(res)
  res.status.mockReturnValue(res)
  res.vary.mockReturnValue(res)
  return res
}

const publicPage = {
  id: 7,
  path: 'docs/alpha',
  hash: 'page-hash',
  title: 'Alpha',
  description: 'A public page',
  visibility: 'public',
  ownerId: null,
  contentType: 'markdown',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  sourceRevision: 8,
  locale: 'en',
  extra: {},
  tags: []
}

const offlineSnapshot = {
  schemaVersion: 1,
  pageId: 7,
  locale: 'en',
  path: 'docs/alpha',
  canonicalPath: '/en/docs/alpha',
  title: 'Alpha',
  description: 'A public page',
  sourceRevision: '8',
  capturedAt: '2026-09-02T00:00:00.000Z',
  expiresAt: null,
  content: {
    representation: 'sanitized-html-fragment',
    sanitizerVersion: 'offline-html-allowlist-v1',
    html: '<p>Readable</p>'
  },
  searchText: 'Readable',
  contentType: 'sanitized-html-fragment',
  integrity: 'integrity'
}

beforeEach(() => {
  for (const operation of [
    pageOperations.get,
    pageOperations.getOfflineSnapshot,
    auth.checkAccess,
    auth.loadPageRuleAuthority,
    canReadPage,
    canWritePage,
    managesSystem,
    principalId,
    canViewRestrictedPageFields,
    projectPageFields,
    buildPageOkfView,
    createAuthRateLimiter,
    setAuthRateLimitHeaders
  ])
    operation.mockReset()

  const requester = { id: 9, permissions: ['read:pages'] }
  const authority = { requester, permissions: ['read:pages'], groups: [], tagAliases: {} }
  principalId.mockReturnValue(requester.id)
  canReadPage.mockReturnValue(true)
  canViewRestrictedPageFields.mockReturnValue(false)
  projectPageFields.mockImplementation(({ value }: { value: unknown }) => value)
  auth.checkAccess.mockReturnValue(true)
  auth.loadPageRuleAuthority.mockResolvedValue(authority)
  buildPageOkfView.mockResolvedValue({ authority: { state: 'missing', metadata: null, trust: null }, projection: { state: 'pending', value: null } })
  pageOperations.get.mockResolvedValue(publicPage)
  pageOperations.getOfflineSnapshot.mockResolvedValue(offlineSnapshot)
})

describe('page response privacy boundaries', () => {
  it('marks an ordinary public page detail response private because its projection is requester-sensitive', async () => {
    const requester = { id: 9, permissions: ['read:pages'] }
    const res = response()

    await getPage({ user: requester, sessionID: 'reader-session', params: { id: '7' } }, res, vi.fn())

    expect(pageOperations.get).toHaveBeenCalledWith(expect.objectContaining({ requester, id: 7, sessionId: 'reader-session' }))
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 7, path: 'docs/alpha' }))
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('keeps the privacy headers on ordinary detail validation failures', async () => {
    const res = response()

    await getPage({ user: { id: 9, permissions: ['read:pages'] }, params: { id: 'not-an-id' } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(pageOperations.get).not.toHaveBeenCalled()
  })
})

describe('offline snapshot transport boundary', () => {
  it('returns only the operation snapshot and applies private no-store framing', async () => {
    const res = response()

    await getOfflineSnapshot({ params: { id: '7' } }, res, vi.fn())

    expect(pageOperations.getOfflineSnapshot).toHaveBeenCalledWith({ id: 7 })
    expect(res.json).toHaveBeenCalledWith(offlineSnapshot)
    const payload = res.json.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([
      'canonicalPath',
      'capturedAt',
      'content',
      'contentType',
      'description',
      'expiresAt',
      'integrity',
      'locale',
      'pageId',
      'path',
      'schemaVersion',
      'searchText',
      'sourceRevision',
      'title'
    ])
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it.each([
    ['absent', 404, 'database row was absent'],
    ['protected', 403, 'protected page source was secret'],
    ['stale render', 404, 'rendered bytes came from another revision'],
    ['unsafe projection', 404, 'unsafe projection source was secret']
  ])('normalizes %s snapshot denial to one bounded public response', async (_label: string, status: number, internalMessage: string) => {
    const denial = Object.assign(new Error(internalMessage), {
      status,
      code: 'OFFLINE_PAGE_INELIGIBLE'
    })
    pageOperations.getOfflineSnapshot.mockRejectedValueOnce(denial)
    const res = response()
    const next = vi.fn()

    await getOfflineSnapshot({ params: { id: '7' } }, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({
      error: 'This page is not available for offline use.',
      code: 'OFFLINE_PAGE_INELIGIBLE'
    })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret')
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(next).not.toHaveBeenCalled()
  })

  it('leaves infrastructure failures on the normal error path', async () => {
    const failure = Object.assign(new Error('database credentials leaked'), { status: 503 })
    pageOperations.getOfflineSnapshot.mockRejectedValueOnce(failure)
    const res = response()
    const next = vi.fn()

    await getOfflineSnapshot({ params: { id: '7' } }, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('keeps malformed IDs as 400 instead of converting them to eligibility denial', async () => {
    const res = response()

    await getOfflineSnapshot({ params: { id: 'not-an-id' } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(pageOperations.getOfflineSnapshot).not.toHaveBeenCalled()
  })
})
