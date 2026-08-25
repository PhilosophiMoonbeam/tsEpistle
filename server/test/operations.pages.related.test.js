import { beforeEach, describe, expect, it, vi } from 'vitest'

const page = (id, title, path, tags = []) => ({
  id,
  localeCode: 'en',
  path,
  title,
  description: `${title} description`,
  visibility: 'public',
  ownerId: null,
  isPublished: true,
  contentType: 'markdown',
  sourceRevision: String(id),
  updatedAt: new Date('2026-08-25T00:00:00.000Z'),
  editorKey: 'markdown',
  extra: {},
  tags: tags.map((tag, index) => ({ id: id * 10 + index, tag }))
})

const pageQuery = pages => {
  const query = {
    column: vi.fn(() => query),
    withGraphJoined: vi.fn(() => query),
    modifyGraph: vi.fn((_relation, callback) => { callback({ select: vi.fn() }); return query }),
    modify: vi.fn(callback => { callback({ where: vi.fn() }); return query }),
    then: resolve => Promise.resolve(pages).then(resolve)
  }
  return query
}

describe('related page graph traversal', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('walks all authorized explicit links breadth-first with stable pagination and no hidden bridges', async () => {
    const pages = [
      page(1, 'Alpha', 'alpha', ['seed']),
      page(2, 'Bravo', 'bravo'),
      page(3, 'Charlie', 'charlie'),
      page(4, 'Delta', 'delta'),
      page(5, 'Hidden', 'hidden'),
      page(6, 'Beyond Hidden', 'beyond-hidden')
    ]
    const edges = [
      { sourceId: 1, targetId: 2 },
      { sourceId: 3, targetId: 2 },
      { sourceId: 2, targetId: 4 },
      { sourceId: 4, targetId: 2 },
      { sourceId: 4, targetId: 5 },
      { sourceId: 5, targetId: 6 }
    ]
    const visiblePageQuery = pageQuery(pages)
    const edgeQuery = {
      join: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => edges)
    }
    const checkAccess = vi.fn((_user, _permissions, context = {}) => context.path !== 'hidden')
    global.WIKI = {
      auth: { checkAccess },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: {
        knex: vi.fn(table => {
          if (table === 'pageLinks as links') return edgeQuery
          throw new Error(`Unexpected table ${table}`)
        }),
        pages: {
          getPageFromDb: vi.fn(async id => pages.find(candidate => candidate.id === id)),
          query: vi.fn(() => visiblePageQuery),
          relatedQuery: vi.fn()
        },
        tags: {},
        pageHistory: {}
      }
    }

    const { default: operations } = await import('../operations/pages.ts')
    const requester = { id: 7 }
    await expect(operations.listRelated({ pageId: 1, limit: 2, offset: 0, requester })).resolves.toMatchObject({
      pages: [
        { id: 2, distance: 1, direction: 'outgoing', viaPageId: 1 },
        { id: 3, distance: 2, direction: 'incoming', viaPageId: 2 }
      ],
      truncated: true,
      nextOffset: 2
    })
    expect(visiblePageQuery.column).toHaveBeenCalledWith(expect.arrayContaining(['pages.updatedAt']))
    await expect(operations.listRelated({ pageId: 1, limit: 2, offset: 2, requester })).resolves.toMatchObject({
      pages: [{ id: 4, distance: 2, direction: 'bidirectional', viaPageId: 2 }],
      truncated: false,
      nextOffset: null
    })
    await expect(operations.listRelated({ pageId: 1, limit: 20, offset: 0, maxDepth: 1, requester })).resolves.toMatchObject({
      pages: [{ id: 2, distance: 1 }],
      truncated: false,
      nextOffset: null
    })
    await expect(operations.listRelated({ pageId: 1, limit: 100, offset: 5_001, requester })).resolves.toMatchObject({
      pages: [],
      truncated: false,
      nextOffset: null
    })
    expect(checkAccess).toHaveBeenCalledWith(requester, ['read:pages'], expect.objectContaining({ path: 'hidden' }))
  })
})
