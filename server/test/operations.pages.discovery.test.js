import knexModule from 'knex'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { PAGE_INDEX_CANDIDATE_LIMIT, listPageIndexCandidates as realListPageIndexCandidates } from '../repositories/page-index.ts'

const connection = getPostgresTestConnection('_page_discovery_test', import.meta.path)
const originalWiki = global.WIKI
const realPageIndex = { PAGE_INDEX_CANDIDATE_LIMIT, listPageIndexCandidates: realListPageIndexCandidates }
const pageRow = (id, path, overrides = {}) => ({
  id,
  path,
  localeCode: 'en',
  title: `Page ${id}`,
  description: null,
  content: `Evidence ${id}`,
  sourceRevision: id,
  contentType: 'markdown',
  visibility: 'public',
  ownerId: null,
  creatorId: 7,
  authorId: 7,
  isPublished: true,
  isSearchable: true,
  publishStartDate: null,
  publishEndDate: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...overrides
})

describe('structured page discovery', () => {
  let db

  beforeAll(async () => {
    if (!connection) return
    db = knexModule({ client: 'pg', connection, pool: { min: 0, max: 4 } })
    await db.raw('DROP TABLE IF EXISTS "pageUnlockGrants", "pageAccessPasswords", "pageTags", tags, pages CASCADE')
    await db.raw(`
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        path text NOT NULL,
        "localeCode" text NOT NULL,
        title text NOT NULL,
        description text,
        content text NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "contentType" text NOT NULL,
        visibility text NOT NULL,
        "ownerId" integer,
        "creatorId" integer NOT NULL,
        "authorId" integer NOT NULL,
        "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL,
        "publishStartDate" timestamptz,
        "publishEndDate" timestamptz,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY,
        tag text NOT NULL UNIQUE,
        title text,
        "redirectToId" integer,
        "isArchived" boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY ("pageId", "tagId")
      );
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY,
        version integer NOT NULL
      );
      CREATE TABLE "pageUnlockGrants" (
        "pageId" integer NOT NULL,
        "sessionId" text NOT NULL,
        "userId" integer NOT NULL,
        "passwordVersion" integer NOT NULL,
        "expiresAt" timestamptz NOT NULL
      );
    `)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Bun module mocks survive resetModules/restoreAllMocks. Restore the real
    // repository export before a native query or another ordinary boundary case.
    vi.mockModule('../repositories/page-index.ts', import.meta.url, () => realPageIndex)
    if (originalWiki === undefined) delete global.WIKI
    else global.WIKI = originalWiki
  })

  afterAll(async () => {
    if (db) await db.destroy()
  })

  const arrangeNative = async (pages, assignments = []) => {
    await db.raw('TRUNCATE "pageUnlockGrants", "pageAccessPasswords", "pageTags", tags, pages CASCADE')
    await db.batchInsert('pages', pages, 500)
    const names = [...new Set(assignments.flatMap(([, tags]) => tags))]
    if (names.length > 0) {
      await db('tags').insert(names.map((tag, index) => ({ id: index + 1, tag, title: tag })))
      await db('pageTags').insert(assignments.flatMap(([pageId, tags]) => tags.map(tag => ({ pageId, tagId: names.indexOf(tag) + 1 }))))
    }
    const checkAccess = (_requester, permissions) => permissions.includes('read:pages')
    const loadPageRuleAuthority = async requester => ({ requester, permissions: [], groups: [], tagAliases: {} })
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: db, pages: {}, tags: {}, pageHistory: {} }
    }
    vi.mockModule('../repositories/page-index.ts', import.meta.url, () => realPageIndex)
    const { default: Page } = await vi.importFresh('../models/pages.ts', import.meta.url)
    Page.knex(db)
    const Tag = Page.relationMappings.tags.modelClass
    Tag.knex(db)
    global.WIKI.models.pages = Page
    global.WIKI.models.tags = Tag
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    return operations
  }

  beforeEach(() => {
    vi.resetModules()
  })

  it('filters authorized descendants by depth and exact tags with stable pagination', async () => {
    const candidates = [
      { id: 1, localeCode: 'en', path: 'docs/zulu', title: 'Zulu', description: null, visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-20T00:00:00.000Z'), tags: [{ tag: 'runbook' }] },
      { id: 2, localeCode: 'en', path: 'docs/nested/alpha', title: 'Alpha', description: 'Nested', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-21T00:00:00.000Z'), tags: [{ tag: 'runbook' }, { tag: 'release' }] },
      { id: 3, localeCode: 'en', path: 'docs/nested/deep/hidden', title: 'Too Deep', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-22T00:00:00.000Z'), tags: [{ tag: 'runbook' }] },
      { id: 4, localeCode: 'en', path: 'other/page', title: 'Other', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-23T00:00:00.000Z'), tags: [{ tag: 'runbook' }] },
      { id: 5, localeCode: 'en', path: 'docs/missing-tag', title: 'A Missing Tag', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-24T00:00:00.000Z'), tags: [] },
      { id: 6, localeCode: 'en', path: 'docs/substring-tag', title: 'A Substring Tag', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-25T00:00:00.000Z'), tags: [{ tag: 'runbook-extra' }] },
      { id: 7, localeCode: 'en', path: 'docs/denied', title: 'A Denied Page', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-26T00:00:00.000Z'), tags: [{ tag: 'runbook' }] }
    ]
    const listPageIndexCandidates = vi.fn(async () => candidates)
    vi.mockModule('../repositories/page-index.ts', import.meta.url, () => ({ PAGE_INDEX_CANDIDATE_LIMIT: 5_001, listPageIndexCandidates }))
    const checkAccess = vi.fn().mockReturnValue(true)
    const checkPageAccess = vi.fn((_requester, _permissions, context) => context.path !== 'docs/denied')
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: {}, pages: {}, tags: {}, pageHistory: {} }
    }

    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const requester = { id: 7 }
    expect(await operations.discover({ requester, locale: 'en', path: 'docs', depth: 1, tags: ['RUNBOOK'], order: 'title', limit: 1, offset: 0 })).toEqual({
      pages: [{ id: 2, locale: 'en', path: 'docs/nested/alpha', title: 'Alpha', description: 'Nested', updatedAt: '2026-08-21T00:00:00.000Z', tags: ['runbook', 'release'] }],
      totalInWindow: 2,
      windowLimit: 5_000,
      nextOffset: 1
    })
    expect(await operations.discover({ requester, locale: 'en', path: 'docs', depth: 1, tags: ['runbook'], order: 'title', limit: 1, offset: 1 })).toMatchObject({
      pages: [{ id: 1, path: 'docs/zulu' }],
      totalInWindow: 2,
      nextOffset: null
    })
    expect(listPageIndexCandidates).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locale: 'en', path: 'docs', limit: 5_001 }))
  })
  it('filters selected pages before discovery pagination and candidate windows', async () => {
    if (connection) {
      const distractors = Array.from({ length: 5_002 }, (_, index) =>
        pageRow(index + 100, `docs/a-${String(index).padStart(5, '0')}`)
      )
      const operations = await arrangeNative([
        pageRow(1, 'docs/a', { updatedAt: '2026-08-21T00:00:00.000Z' }),
        pageRow(2, 'docs/b', { updatedAt: '2026-08-22T00:00:00.000Z' }),
        pageRow(3, 'docs/c', { updatedAt: '2026-08-23T00:00:00.000Z' }),
        ...distractors
      ], [[1, ['tag-1']], [2, ['tag-2']], [3, ['tag-3']]])
      const requester = { id: 7 }
      const input = { requester, locale: 'en', path: 'docs', depth: 1, order: 'path', limit: 1, offset: 0 }
      // The real repository must stop at its overflow sentinel, not fetch the
      // whole population. Discovery rejects before depth/tag/offset filtering.
      const bounded = await realPageIndex.listPageIndexCandidates(db, { locale: 'en', path: 'docs', scope: () => {} })
      expect(bounded).toHaveLength(5_001)
      expect(bounded.some(page => page.id === 2 || page.id === 3)).toBe(false)
      await expect(operations.discover({ ...input, depth: 0, tags: ['missing'], offset: 5_000 }))
        .rejects.toMatchObject({ name: 'PAGE_INDEX_TOO_BROAD', status: 422 })
      const agentScope = { kind: 'selected', pageIds: [2, 3] }
      expect(await operations.discover({ ...input, agentScope })).toEqual({
        pages: [{ id: 2, locale: 'en', path: 'docs/b', title: 'Page 2', description: null, updatedAt: '2026-08-22T00:00:00.000Z', tags: ['tag-2'] }],
        totalInWindow: 2,
        windowLimit: 5_000,
        nextOffset: 1
      })
      expect(await operations.discover({ ...input, agentScope, offset: 1 })).toEqual({
        pages: [{ id: 3, locale: 'en', path: 'docs/c', title: 'Page 3', description: null, updatedAt: '2026-08-23T00:00:00.000Z', tags: ['tag-3'] }],
        totalInWindow: 2,
        windowLimit: 5_000,
        nextOffset: null
      })
      return
    }
    const candidates = [1, 2, 3].map(id => ({
      id,
      localeCode: 'en',
      path: `docs/${String.fromCharCode(96 + id)}`,
      title: `Page ${id}`,
      description: null,
      visibility: 'public',
      ownerId: null,
      updatedAt: new Date(`2026-08-${20 + id}T00:00:00.000Z`),
      tags: [{ tag: `tag-${id}` }]
    }))
    const makeQuery = () => {
      const nested = () => ({
        where: vi.fn().mockReturnThis(),
        orWhere: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        orWhereRaw: vi.fn().mockReturnThis()
      })
      const query = {
        where: vi.fn(function (condition) {
          if (typeof condition === 'function') condition(nested())
          return this
        }),
        whereIn: vi.fn().mockReturnThis(),
        andWhere: vi.fn(function (condition) {
          if (typeof condition === 'function') condition(nested())
          return this
        }),
        whereRaw: vi.fn().mockReturnThis()
      }
      return query
    }
    const scopedQuery = makeQuery()
    const listPageIndexCandidates = vi.fn(async (_knex, options) => {
      options.scope(scopedQuery)
      return candidates
    })
    vi.mockModule('../repositories/page-index.ts', import.meta.url, () => ({ PAGE_INDEX_CANDIDATE_LIMIT: 5_001, listPageIndexCandidates }))
    const checkAccess = vi.fn().mockReturnValue(true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: {}, pages: {}, tags: {}, pageHistory: {} }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.discover({
      requester: { id: 7 },
      locale: 'en',
      path: 'docs',
      depth: 1,
      order: 'path',
      limit: 1,
      offset: 1,
      agentScope: { kind: 'selected', pageIds: [2, 3] }
    })).resolves.toMatchObject({
      pages: [{ id: 3, path: 'docs/c', tags: ['tag-3'] }],
      totalInWindow: 2,
      nextOffset: null
    })
    expect(scopedQuery.whereIn).toHaveBeenCalledWith('pages.id', [2, 3])
  })

  it('uses canonical locale and slash-bounded section scope for page-derived tags', async () => {
    if (connection) {
      const distractors = Array.from({ length: 5_002 }, (_, index) =>
        pageRow(index + 100, `docs/runbook-extra/${String(index).padStart(5, '0')}`)
      )
      const operations = await arrangeNative([
        pageRow(1, 'docs/runbook', { title: 'Root' }),
        pageRow(2, 'docs/runbook/child', { title: 'Child', updatedAt: '2026-08-21T00:00:00.000Z' }),
        pageRow(3, 'docs/runbook-extra', { title: 'Sibling', updatedAt: '2026-08-22T00:00:00.000Z' }),
        pageRow(4, 'docs/runbook/foreign-locale', { localeCode: 'fr', title: 'Foreign', updatedAt: '2026-08-23T00:00:00.000Z' }),
        pageRow(5, 'docs/runbook', { localeCode: 'fr', title: 'Foreign root' }),
        ...distractors
      ], [[1, ['inside']], [2, ['inside-child']], [3, ['sibling']], [4, ['foreign']], [5, ['foreign-root']]])
      const input = { requester: { id: 7 }, locale: 'en', path: '', depth: 5, order: 'path', limit: 10, offset: 0 }
      await expect(operations.discover(input)).rejects.toMatchObject({ name: 'PAGE_INDEX_TOO_BROAD', status: 422 })
      expect(await operations.discover({ ...input, agentScope: { kind: 'section', locale: 'en', path: 'docs/runbook' } })).toEqual({
        pages: [
          { id: 1, locale: 'en', path: 'docs/runbook', title: 'Root', description: null, updatedAt: '2026-08-20T00:00:00.000Z', tags: ['inside'] },
          { id: 2, locale: 'en', path: 'docs/runbook/child', title: 'Child', description: null, updatedAt: '2026-08-21T00:00:00.000Z', tags: ['inside-child'] }
        ],
        totalInWindow: 2,
        windowLimit: 5_000,
        nextOffset: null
      })
      // Preserve the intersection and foreign-locale output distinctions.
      // SQL locale constraints and the postfilter independently enforce these.
      expect(await operations.discover({ ...input, agentScope: { kind: 'section', locale: 'fr', path: 'docs/runbook' } })).toEqual({
        pages: [], totalInWindow: 0, windowLimit: 5_000, nextOffset: null
      })
      expect(await operations.discover({ ...input, locale: 'fr', agentScope: { kind: 'section', locale: 'fr', path: 'docs/runbook' } })).toEqual({
        pages: [
          { id: 5, locale: 'fr', path: 'docs/runbook', title: 'Foreign root', description: null, updatedAt: '2026-08-20T00:00:00.000Z', tags: ['foreign-root'] },
          { id: 4, locale: 'fr', path: 'docs/runbook/foreign-locale', title: 'Foreign', description: null, updatedAt: '2026-08-23T00:00:00.000Z', tags: ['foreign'] }
        ],
        totalInWindow: 2,
        windowLimit: 5_000,
        nextOffset: null
      })
      return
    }
    const candidates = [
      { id: 1, localeCode: 'en', path: 'docs/runbook', title: 'Root', description: null, visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-20T00:00:00.000Z'), tags: [{ tag: 'inside' }] },
      { id: 2, localeCode: 'en', path: 'docs/runbook/child', title: 'Child', description: null, visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-21T00:00:00.000Z'), tags: [{ tag: 'inside-child' }] },
      { id: 3, localeCode: 'en', path: 'docs/runbook-extra', title: 'Sibling', description: null, visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-22T00:00:00.000Z'), tags: [{ tag: 'sibling' }] },
      { id: 4, localeCode: 'fr', path: 'docs/runbook/foreign-locale', title: 'Foreign', description: null, visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-23T00:00:00.000Z'), tags: [{ tag: 'foreign' }] }
    ]
    const nested = () => ({
      where: vi.fn().mockReturnThis(),
      orWhere: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      orWhereRaw: vi.fn().mockReturnThis()
    })
    const scopedQuery = {
      where: vi.fn(function (condition) {
        if (typeof condition === 'function') condition(nested())
        return this
      }),
      whereIn: vi.fn().mockReturnThis(),
      andWhere: vi.fn(function (condition) {
        if (typeof condition === 'function') condition(nested())
        return this
      }),
      whereRaw: vi.fn().mockReturnThis()
    }
    const listPageIndexCandidates = vi.fn(async (_knex, options) => {
      options.scope(scopedQuery)
      return candidates
    })
    vi.mockModule('../repositories/page-index.ts', import.meta.url, () => ({ PAGE_INDEX_CANDIDATE_LIMIT: 5_001, listPageIndexCandidates }))
    const checkAccess = vi.fn().mockReturnValue(true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: {}, pages: {}, tags: {}, pageHistory: {} }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.discover({
      requester: { id: 7 },
      locale: 'en',
      path: '',
      depth: 5,
      order: 'path',
      limit: 10,
      offset: 0,
      agentScope: { kind: 'section', locale: 'en', path: 'docs/runbook' }
    })).resolves.toMatchObject({
      pages: [
        { id: 1, tags: ['inside'] },
        { id: 2, tags: ['inside-child'] }
      ],
      totalInWindow: 2
    })
    expect(scopedQuery.where).toHaveBeenCalledWith('pages.localeCode', 'en')
    expect(scopedQuery.andWhere).toHaveBeenCalled()
  })
  it('applies selected scope before the recent-evidence candidate batch limit', async () => {
    if (connection) {
      const distractors = Array.from({ length: 50 }, (_, index) =>
        pageRow(index + 1, `docs/${index + 1}`, { updatedAt: '2026-08-21T00:00:00.000Z' })
      )
      const operations = await arrangeNative([...distractors, pageRow(51, 'docs/51')], [[51, ['selected-evidence']]])
      expect(await operations.listRecent({ requester: { id: 7 }, limit: 1, agentScope: { kind: 'selected', pageIds: [51] } })).toEqual({
        kind: 'recent-page-evidence',
        requestedLimit: 1,
        exhausted: true,
        pages: [{
          id: 51,
          locale: 'en',
          path: 'docs/51',
          title: 'Page 51',
          contentType: 'markdown',
          sourceRevision: '51',
          updatedAt: '2026-08-20T00:00:00.000Z',
          content: 'Evidence 51',
          sourceContentCharacters: 11,
          contentTruncated: false,
          citation: { evidenceId: 'page:51:revision:51', label: 'Page 51', href: '/en/docs/51' }
        }]
      })
      return
    }
    const candidates = Array.from({ length: 51 }, (_, index) => {
      const id = index + 1
      return {
        id,
        localeCode: 'en',
        path: `docs/${id}`,
        title: `Page ${id}`,
        contentType: 'markdown',
        sourceRevision: String(id),
        content: `Evidence ${id}`,
        updatedAt: new Date(Date.UTC(2026, 7, id)),
        visibility: 'public',
        ownerId: null,
        isPublished: true,
        isSearchable: true,
        tags: []
      }
    })
    const operationsOrder = []
    let selectedIds
    let batchLimit = 0
    const query = {
      column: vi.fn(() => query),
      modify: vi.fn(callback => {
        const builder = {
          where: vi.fn().mockReturnThis(),
          whereIn: vi.fn((column, ids) => {
            expect(column).toBe('pages.id')
            selectedIds = new Set(ids)
            operationsOrder.push('scope')
            return builder
          }),
          andWhere: vi.fn().mockReturnThis(),
          orWhere: vi.fn().mockReturnThis(),
          whereRaw: vi.fn().mockReturnThis()
        }
        callback(builder)
        return query
      }),
      withGraphFetched: vi.fn(() => query),
      modifyGraph: vi.fn((_relation, callback) => { callback({ select: vi.fn() }); return query }),
      orderBy: vi.fn(() => query),
      limit: vi.fn(value => {
        batchLimit = value
        operationsOrder.push('limit')
        return query
      }),
      then: resolve =>
        Promise.resolve(candidates.filter(candidate => selectedIds === undefined || selectedIds.has(candidate.id)).slice(0, batchLimit)).then(resolve)
    }
    const checkAccess = vi.fn((_requester, permissions) => permissions.includes('manage:system'))
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
    global.WIKI = {
      auth: { checkAccess, checkPageAccess: vi.fn(() => true), loadPageRuleAuthority },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: vi.fn(), pages: { query: vi.fn(() => query) }, tags: {}, pageHistory: {} }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)

    await expect(operations.listRecent({
      requester: { id: 1 },
      limit: 1,
      agentScope: { kind: 'selected', pageIds: [51] }
    })).resolves.toMatchObject({
      kind: 'recent-page-evidence',
      exhausted: true,
      pages: [{ id: 51, citation: { evidenceId: 'page:51:revision:51' } }]
    })
    expect(operationsOrder).toEqual(['scope', 'limit'])
    expect(batchLimit).toBe(50)
  })
  it('rechecks selected and section scope on repository output independently of SQL admission', async () => {
    const candidates = [
      { ...pageRow(1, 'docs/runbook'), tags: [{ tag: 'inside' }] },
      { ...pageRow(2, 'docs/runbook/child'), tags: [{ tag: 'inside-child' }] },
      { ...pageRow(3, 'docs/runbook-extra'), tags: [{ tag: 'sibling' }] },
      { ...pageRow(4, 'docs/runbook/foreign-locale', { localeCode: 'fr' }), tags: [{ tag: 'foreign' }] }
    ]
    // Deliberately wider repository output, not a SQL-emulating builder.
    // Real SQL already masks removal of the operation's independent postfilter.
    vi.mockModule('../repositories/page-index.ts', import.meta.url, () => ({
      PAGE_INDEX_CANDIDATE_LIMIT: 5_001,
      listPageIndexCandidates: async () => candidates
    }))
    const checkAccess = vi.fn(() => true)
    global.WIKI = {
      auth: {
        checkAccess,
        checkPageAccess: checkAccess,
        loadPageRuleAuthority: async requester => ({ requester, permissions: [], groups: [], tagAliases: {} })
      },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: {}, pages: {}, tags: {}, pageHistory: {} }
    }
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    const input = { requester: { id: 7 }, locale: 'en', path: '', depth: 5, order: 'title', limit: 10, offset: 0 }
    expect(await operations.discover({ ...input, agentScope: { kind: 'selected', pageIds: [2, 3] } })).toMatchObject({
      pages: [{ id: 2, tags: ['inside-child'] }, { id: 3, tags: ['sibling'] }],
      totalInWindow: 2,
      nextOffset: null
    })
    expect(await operations.discover({ ...input, agentScope: { kind: 'section', locale: 'en', path: 'docs/runbook' } })).toMatchObject({
      pages: [{ id: 1, tags: ['inside'] }, { id: 2, tags: ['inside-child'] }],
      totalInWindow: 2,
      nextOffset: null
    })
  })
})
