import { beforeEach, describe, expect, it, vi } from './bun-test.mts'

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
    modify: vi.fn(callback => {
      const sectionBuilder = { where: vi.fn().mockReturnThis(), orWhereRaw: vi.fn().mockReturnThis() }
      const builder = {
        where: vi.fn().mockReturnThis(),
        whereIn: vi.fn().mockReturnThis(),
        whereRaw: vi.fn().mockReturnThis(),
        andWhere: vi.fn(scoped => { scoped(sectionBuilder); return builder })
      }
      callback(builder)
      return query
    }),
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
      { sourceId: 1, sourceRevision: '1', sourcePath: 'alpha', sourceLocale: 'en', targetId: 2, targetRevision: '2', targetPath: 'bravo', targetLocale: 'en' },
      { sourceId: 3, sourceRevision: '3', sourcePath: 'charlie', sourceLocale: 'en', targetId: 2, targetRevision: '2', targetPath: 'bravo', targetLocale: 'en' },
      { sourceId: 2, sourceRevision: '2', sourcePath: 'bravo', sourceLocale: 'en', targetId: 4, targetRevision: '4', targetPath: 'delta', targetLocale: 'en' },
      { sourceId: 4, sourceRevision: '4', sourcePath: 'delta', sourceLocale: 'en', targetId: 2, targetRevision: '2', targetPath: 'bravo', targetLocale: 'en' },
      { sourceId: 4, sourceRevision: '4', sourcePath: 'delta', sourceLocale: 'en', targetId: 5, targetRevision: '5', targetPath: 'hidden', targetLocale: 'en' },
      { sourceId: 5, sourceRevision: '5', sourcePath: 'hidden', sourceLocale: 'en', targetId: 6, targetRevision: '6', targetPath: 'beyond-hidden', targetLocale: 'en' }
    ]
    const receipts = edges
      .map(edge => `${edge.sourceId}:${edge.sourceRevision}`)
      .filter((key, index, all) => all.indexOf(key) === index)
      .map(key => {
        const [pageId, sourceRevision] = key.split(':')
        return { pageId: Number(pageId), sourceRevision }
      })
    const visiblePageQuery = pageQuery(pages)
    const edgeQuery = {
      join: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => edges)
    }
    const receiptQuery = {
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => receipts)
    }
    const checkAccess = vi.fn((_user, _permissions, context = {}) => context.path !== 'hidden')
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: {
        knex: vi.fn(table => {
          if (table === 'pageLinks as links') return edgeQuery
          if (table === 'pageMutationOutbox') return receiptQuery
          if (table === 'pageAccessPasswords') return [{ pageId: 5 }]
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

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const requester = { id: 7 }
    expect(await operations.listRelated({ pageId: 1, limit: 2, offset: 0, requester })).toMatchObject({
      pages: [
        { id: 2, distance: 1, direction: 'outgoing', viaPageId: 1 },
        { id: 3, distance: 2, direction: 'incoming', viaPageId: 2 }
      ],
      truncated: true,
      nextOffset: 2
    })
    expect(visiblePageQuery.column).toHaveBeenCalledWith(expect.arrayContaining(['pages.updatedAt']))
    expect(await operations.listRelated({ pageId: 1, limit: 2, offset: 2, requester })).toMatchObject({
      pages: [{ id: 4, distance: 2, direction: 'bidirectional', viaPageId: 2 }],
      truncated: false,
      nextOffset: null
    })
    expect(await operations.listRelated({ pageId: 1, limit: 20, offset: 0, maxDepth: 1, requester })).toMatchObject({
      pages: [{ id: 2, distance: 1 }],
      truncated: false,
      nextOffset: null
    })
    expect(await operations.listRelated({ pageId: 1, limit: 100, offset: 5_001, requester })).toMatchObject({
      pages: [],
      truncated: false,
      nextOffset: null
    })
  })
  it('supports locale and section roots while excluding out-of-scope graph bridges', async () => {
    const pages = [
      page(1, 'Root', 'docs/root'),
      page(2, 'Inside', 'docs/inside'),
      { ...page(3, 'Foreign bridge', 'docs/foreign'), localeCode: 'fr' },
      page(4, 'Behind foreign', 'docs/deep'),
      page(5, 'Outside bridge', 'outside/bridge'),
      page(6, 'Behind outside', 'docs/behind-outside')
    ]
    const edges = [
      { sourceId: 1, sourceRevision: '1', sourcePath: 'docs/root', sourceLocale: 'en', targetId: 2, targetRevision: '2', targetPath: 'docs/inside', targetLocale: 'en' },
      { sourceId: 1, sourceRevision: '1', sourcePath: 'docs/root', sourceLocale: 'en', targetId: 3, targetRevision: '3', targetPath: 'docs/foreign', targetLocale: 'fr' },
      { sourceId: 3, sourceRevision: '3', sourcePath: 'docs/foreign', sourceLocale: 'fr', targetId: 4, targetRevision: '4', targetPath: 'docs/deep', targetLocale: 'en' },
      { sourceId: 1, sourceRevision: '1', sourcePath: 'docs/root', sourceLocale: 'en', targetId: 5, targetRevision: '5', targetPath: 'outside/bridge', targetLocale: 'en' },
      { sourceId: 5, sourceRevision: '5', sourcePath: 'outside/bridge', sourceLocale: 'en', targetId: 6, targetRevision: '6', targetPath: 'docs/behind-outside', targetLocale: 'en' }
    ]
    const visiblePageQuery = pageQuery(pages)
    const edgeQuery = {
      join: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      andWhere: vi.fn(function (scoped) {
        scoped({ where: vi.fn().mockReturnThis(), orWhereRaw: vi.fn().mockReturnThis() })
        return this
      }),
      select: vi.fn(async () => edges)
    }
    const receiptQuery = {
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => [1, 3, 5].map(id => ({ pageId: id, sourceRevision: String(id) })))
    }
    const checkAccess = vi.fn(() => true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: {
        knex: vi.fn(table => {
          if (table === 'pageLinks as links') return edgeQuery
          if (table === 'pageMutationOutbox') return receiptQuery
          if (table === 'pageAccessPasswords') return []
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
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const requester = { id: 7 }
    const localeResult = await operations.listRelated({ pageId: 1, requester, agentScope: { kind: 'locale', locale: 'en' } })
    expect(localeResult.pages.map(({ id, distance, viaPageId }) => ({ id, distance, viaPageId }))).toEqual([
      { id: 2, distance: 1, viaPageId: 1 },
      { id: 5, distance: 1, viaPageId: 1 },
      { id: 6, distance: 2, viaPageId: 5 }
    ])
    const sectionResult = await operations.listRelated({
      pageId: 1,
      requester,
      agentScope: { kind: 'section', locale: 'en', path: 'docs' }
    })
    expect(sectionResult.pages.map(({ id, distance, viaPageId }) => ({ id, distance, viaPageId }))).toEqual([
      { id: 2, distance: 1, viaPageId: 1 }
    ])
  })

  it('does not traverse through excluded selected pages or expose an excluded root', async () => {
    const pages = [
      page(1, 'Root', 'root'),
      page(2, 'Excluded bridge', 'bridge'),
      page(3, 'Beyond bridge', 'beyond')
    ]
    const edges = [
      { sourceId: 1, sourceRevision: '1', sourcePath: 'root', sourceLocale: 'en', targetId: 2, targetRevision: '2', targetPath: 'bridge', targetLocale: 'en' },
      { sourceId: 2, sourceRevision: '2', sourcePath: 'bridge', sourceLocale: 'en', targetId: 3, targetRevision: '3', targetPath: 'beyond', targetLocale: 'en' }
    ]
    const visiblePageQuery = pageQuery(pages)
    const edgeQuery = {
      join: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      whereIn: vi.fn(function () { return this }),
      select: vi.fn(async () => edges)
    }
    const receiptQuery = {
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => [
        { pageId: 1, sourceRevision: '1' },
        { pageId: 2, sourceRevision: '2' }
      ])
    }
    const checkAccess = vi.fn(() => true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    const getPageFromDb = vi.fn(async id => pages.find(candidate => candidate.id === id))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: {
        knex: vi.fn(table => {
          if (table === 'pageLinks as links') return edgeQuery
          if (table === 'pageMutationOutbox') return receiptQuery
          if (table === 'pageAccessPasswords') return []
          throw new Error(`Unexpected table ${table}`)
        }),
        pages: {
          getPageFromDb,
          query: vi.fn(() => visiblePageQuery),
          relatedQuery: vi.fn()
        },
        tags: {},
        pageHistory: {}
      }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const agentScope = { kind: 'selected', pageIds: [1, 3] }

    await expect(operations.listRelated({ pageId: 1, requester: { id: 7 }, agentScope })).resolves.toEqual({
      pages: [],
      truncated: false,
      nextOffset: null
    })
    expect(edgeQuery.whereIn).toHaveBeenCalledWith('source.id', [1, 3])
    expect(edgeQuery.whereIn).toHaveBeenCalledWith('target.id', [1, 3])
    await expect(operations.listRelated({ pageId: 2, requester: { id: 7 }, agentScope })).resolves.toEqual({
      pages: [],
      truncated: false,
      nextOffset: null
    })
    expect(getPageFromDb).not.toHaveBeenCalledWith(2)
  })
  it('paginates only scoped related nodes after excluding out-of-scope peers', async () => {
    const pages = [
      page(1, 'Root', 'root'),
      page(2, 'Excluded', 'excluded'),
      page(3, 'Bravo', 'bravo'),
      page(4, 'Charlie', 'charlie'),
      page(5, 'Delta', 'delta')
    ]
    const edges = [2, 3, 4, 5].map(targetId => ({
      sourceId: 1,
      sourceRevision: '1',
      sourcePath: 'root',
      sourceLocale: 'en',
      targetId,
      targetRevision: String(targetId),
      targetPath: pages.find(candidate => candidate.id === targetId).path,
      targetLocale: 'en'
    }))
    const visiblePageQuery = pageQuery(pages)
    const edgeQuery = {
      join: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      whereIn: vi.fn(function () { return this }),
      select: vi.fn(async () => edges)
    }
    const receiptQuery = {
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => [{ pageId: 1, sourceRevision: '1' }])
    }
    const checkAccess = vi.fn(() => true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: {
        knex: vi.fn(table => {
          if (table === 'pageLinks as links') return edgeQuery
          if (table === 'pageMutationOutbox') return receiptQuery
          if (table === 'pageAccessPasswords') return []
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
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.listRelated({
      pageId: 1,
      requester: { id: 7 },
      limit: 1,
      offset: 1,
      agentScope: { kind: 'selected', pageIds: [1, 3, 4, 5] }
    })).resolves.toMatchObject({
      pages: [{ id: 4, viaPageId: 1 }],
      truncated: true,
      nextOffset: 2
    })
  })

  it('omits links whose source or target is outside the host selection', async () => {
    const pages = [page(1, 'Root', 'root'), page(2, 'Outside', 'outside')]
    const linkRows = [
      { id: 1, title: 'Root', path: 'root', sourceRevision: '1', sourceLocale: 'en', link: 'outside', locale: 'en', targetId: 2, targetRevision: '2', targetPath: 'outside', targetLocale: 'en' },
      { id: 2, title: 'Outside', path: 'outside', sourceRevision: '2', sourceLocale: 'en', link: 'root', locale: 'en', targetId: 1, targetRevision: '1', targetPath: 'root', targetLocale: 'en' }
    ]
    const visiblePageQuery = pageQuery(pages)
    const linkQuery = {
      column: vi.fn(() => linkQuery),
      fullOuterJoin: vi.fn(() => linkQuery),
      leftJoin: vi.fn(function (_table, callback) {
        const join = { on: vi.fn(() => join), andOn: vi.fn(() => join) }
        callback.call(join)
        return linkQuery
      }),
      where: vi.fn(() => linkQuery),
      whereIn: vi.fn(() => linkQuery),
      then: resolve => Promise.resolve(linkRows).then(resolve)
    }
    const receiptQuery = {
      where: vi.fn(function () { return this }),
      select: vi.fn(async () => [
        { pageId: 1, sourceRevision: '1' },
        { pageId: 2, sourceRevision: '2' }
      ])
    }
    const checkAccess = vi.fn(() => true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    const knex = vi.fn(table => {
      if (table === 'pages') return linkQuery
      if (table === 'pageMutationOutbox') return receiptQuery
      if (table === 'pageAccessPasswords') return []
      throw new Error(`Unexpected table ${table}`)
    })
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: {
        knex,
        pages: {
          getPageFromDb: vi.fn(async id => pages.find(candidate => candidate.id === id)),
          query: vi.fn(() => visiblePageQuery),
          relatedQuery: vi.fn()
        },
        tags: {},
        pageHistory: {}
      }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.listLinks({
      locale: 'en',
      requester: { id: 7 },
      agentScope: { kind: 'selected', pageIds: [1] }
    })).resolves.toEqual([{ id: 1, title: 'Root', path: 'en/root', links: [] }])
    expect(linkQuery.whereIn).toHaveBeenCalledWith('pages.id', [1])
    expect(linkQuery.whereIn).toHaveBeenCalledWith('target.id', [1])
  })
})
