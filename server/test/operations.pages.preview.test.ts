import { beforeEach, describe, expect, it, vi } from './bun-test.mts'
const unlock = vi.fn(async () => {})
vi.mockModule('../operations/page-protection.ts', import.meta.url, () => ({ assertPageUnlocked: unlock }))
const page = {
  id: 42,
  localeCode: 'en',
  path: 'docs/start',
  title: 'Start',
  description: 'A guide',
  sourceRevision: '8',
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  visibility: 'public',
  isPublished: true,
  ownerId: null,
  tags: [],
  editorKey: 'markdown',
  extra: {},
  content: 'source',
  render: '<p>Authorized preview text</p>',
  authorEmail: 'do-not-expose@example.test'
}
const getPage = vi.fn(async () => page)
const checkAccess = vi.fn(() => true)
class PageNotFound extends Error {}
beforeEach(() => {
  vi.resetModules()
  unlock.mockReset().mockResolvedValue(undefined)
  getPage.mockReset().mockResolvedValue(page)
  checkAccess.mockReset().mockReturnValue(true)
  global.WIKI = { Error: { PageNotFound }, auth: { checkAccess }, models: { pages: { getPageFromDb: getPage } } } as unknown as typeof WIKI
})
describe('source preview access', () => {
  it('projects only safe source fields after checking current page access and password unlock', async () => {
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const result = await operations.preview({ id: 42, requester: { id: 7 }, sessionId: 'session' })
    expect(unlock).toHaveBeenCalledWith({ requester: { id: 7 }, pageId: 42, sessionId: 'session' })
    expect(result).toMatchObject({ id: 42, excerpt: 'Authorized preview text', sourceRevision: '8' })
    expect(result).not.toHaveProperty('content')
    expect(result).not.toHaveProperty('authorEmail')
    expect(result).not.toHaveProperty('render')
  })
  it('does not produce an excerpt for a revoked page or a locked page', async () => {
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    checkAccess.mockReturnValue(false)
    await expect(operations.preview({ id: 42, requester: { id: 7 } })).rejects.toMatchObject({ status: 404 })
    expect(unlock).not.toHaveBeenCalled()
    checkAccess.mockReturnValue(true)
    unlock.mockRejectedValue(new Error('PAGE_LOCKED'))
    await expect(operations.preview({ id: 42, requester: { id: 7 } })).rejects.toThrow('PAGE_LOCKED')
  })
  it('withholds scheduled or unpublished public previews from readers', async () => {
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    checkAccess.mockImplementation((_user, permissions) => permissions.includes('read:pages'))
    getPage.mockResolvedValue({ ...page, isPublished: false })
    await expect(operations.preview({ id: 42, requester: { id: 7 } })).rejects.toMatchObject({ status: 404 })
    getPage.mockResolvedValue({ ...page, publishStartDate: '2099-01-01T00:00:00Z' })
    await expect(operations.preview({ id: 42, requester: { id: 7 } })).rejects.toMatchObject({ status: 404 })
  })

  it('denies unpublished or expired direct reads to readers while allowing the scoped editor', async () => {
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    getPage.mockResolvedValue({ ...page, isPublished: false })
    checkAccess.mockImplementation((_user, permissions) => permissions.includes('read:pages'))
    await expect(operations.get({ id: 42, requester: { id: 7 } })).rejects.toMatchObject({ status: 404 })

    checkAccess.mockImplementation((_user, permissions) => permissions.includes('write:pages'))
    await expect(operations.get({ id: 42, requester: { id: 7 } })).resolves.toMatchObject({ id: 42, path: 'docs/start' })

    getPage.mockResolvedValue({ ...page, publishEndDate: '2000-01-01T00:00:00Z' })
    checkAccess.mockImplementation((_user, permissions) => permissions.includes('read:pages'))
    await expect(operations.get({ id: 42, requester: { id: 7 } })).rejects.toMatchObject({ status: 404 })
  })

  it('resolves private paths in the requesting owner namespace', async () => {
    checkAccess.mockImplementation((_requester, permissions) => permissions.includes('read:pages'))
    getPage.mockResolvedValue({ ...page, visibility: 'private', ownerId: 7 })
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const result = await operations.preview({ locale: 'en', path: 'docs/start', visibility: 'private', requester: { id: 7 } })
    expect(getPage).toHaveBeenCalledWith({ locale: 'en', path: 'docs/start', visibility: 'private', ownerId: 7 })
    expect(result.visibility).toBe('private')
  })

  it('permits a system manager to resolve one private owner route but rejects an ambiguous cross-owner route', async () => {
    const privatePage = { ...page, id: 84, visibility: 'private' as const, ownerId: 8 }
    const candidates = [{ id: privatePage.id, localeCode: 'en', path: 'docs/start', visibility: 'private' as const, ownerId: 8, tags: [] }]
    const tagBuilder = { select: vi.fn() }
    const pageQuery = {
      column: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn((_relation, callback) => {
        callback(tagBuilder)
        return pageQuery
      }),
      modify: vi.fn(callback => {
        callback({ where: vi.fn() })
        return pageQuery
      }),
      limit: vi.fn(async () => candidates)
    }
    getPage.mockImplementation(async value => (typeof value === 'number' && value === privatePage.id ? privatePage : undefined))
    checkAccess.mockImplementation((_requester, permissions) => permissions.includes('manage:system'))
    global.WIKI.models.pages.query = vi.fn(() => pageQuery) as never
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.getByPath({ locale: 'en', path: 'docs/start', visibility: 'private', requester: { id: 1 } })).resolves.toMatchObject({
      id: privatePage.id,
      visibility: 'private'
    })
    expect(getPage).toHaveBeenCalledWith(privatePage.id)

    getPage.mockResolvedValue({ ...privatePage, path: 'moved/private-route' })
    await expect(operations.getByPath({ locale: 'en', path: 'docs/start', visibility: 'private', requester: { id: 1 } })).rejects.toBeInstanceOf(PageNotFound)
    getPage.mockImplementation(async value => (typeof value === 'number' && value === privatePage.id ? privatePage : undefined))

    candidates.push({ id: 85, localeCode: 'en', path: 'docs/start', visibility: 'private', ownerId: 9, tags: [] })
    await expect(operations.getByPath({ locale: 'en', path: 'docs/start', visibility: 'private', requester: { id: 1 } })).rejects.toBeInstanceOf(PageNotFound)
    expect(getPage).not.toHaveBeenCalledWith(85)
  })
})
