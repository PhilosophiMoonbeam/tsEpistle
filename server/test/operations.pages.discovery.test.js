describe('structured page discovery', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('filters authorized descendants by depth and exact tags with stable pagination', async () => {
    const candidates = [
      { id: 1, localeCode: 'en', path: 'docs/zulu', title: 'Zulu', description: null, visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-20T00:00:00.000Z'), tags: [{ tag: 'runbook' }] },
      { id: 2, localeCode: 'en', path: 'docs/nested/alpha', title: 'Alpha', description: 'Nested', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-21T00:00:00.000Z'), tags: [{ tag: 'runbook' }, { tag: 'release' }] },
      { id: 3, localeCode: 'en', path: 'docs/nested/deep/hidden', title: 'Too Deep', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-22T00:00:00.000Z'), tags: [{ tag: 'runbook' }] },
      { id: 4, localeCode: 'en', path: 'other/page', title: 'Other', description: '', visibility: 'public', ownerId: null, updatedAt: new Date('2026-08-23T00:00:00.000Z'), tags: [{ tag: 'runbook' }] }
    ]
    const listPageIndexCandidates = vi.fn(async () => candidates)
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
})
