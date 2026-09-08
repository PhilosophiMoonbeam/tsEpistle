const searchVisible = vi.fn(async () => [])
const filterVisibleCurrentIds = vi.fn(async ({ pageIds }) => pageIds)
const getCurrentMany = vi.fn(async () => new Map())
vi.mockModule('../knowledge/lifecycle.ts', import.meta.url, () => ({
  PageKnowledgeRepository: class {
    searchVisible(input) {
      return searchVisible(input)
    }

    filterVisibleCurrentIds(input) {
      return filterVisibleCurrentIds(input)
    }

    getCurrentMany(pageIds) {
      return getCurrentMany(pageIds)
    }
  }
}))

const page = (overrides = {}) => ({
  id: 1,
  sourceRevision: '1',
  localeCode: 'en',
  path: 'docs/runbook',
  title: 'Runbook',
  description: '',
  visibility: 'public',
  ownerId: null,
  isPublished: true,
  editorKey: 'markdown',
  extra: {},
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  tags: [],
  ...overrides
})

const installSearchWiki = ({
  pageResults = [],
  protectedIds = [],
  protectedIdSnapshots,
  metadataMatches = [],
  privateRanks = [],
  rawRows,
  engineResponse,
  isManager = false
} = {}) => {
  const queries = [...pageResults]
  const protectedMetadataRows = [...metadataMatches]
  const protectionSnapshots = protectedIdSnapshots ?? [protectedIds]
  let protectionRead = 0
  const where = {
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    andWhere: vi.fn(function (value) {
      if (typeof value === 'function') value({ where: vi.fn().mockReturnThis(), orWhere: vi.fn().mockReturnThis() })
      return this
    })
  }
  const pages = {
    query: vi.fn(() => {
      const query = {
        select: vi.fn().mockReturnThis(),
        column: vi.fn().mockReturnThis(),
        withGraphJoined: vi.fn().mockReturnThis(),
        modifyGraph: vi.fn((_relation, callback) => {
          callback({ select: vi.fn() })
          return query
        }),
        modify: vi.fn(callback => {
          callback(where)
          return Promise.resolve(queries.shift() ?? [])
        })
      }
      return query
    })
  }
  const knex = vi.fn(async table => {
    if (table !== 'pageAccessPasswords') return []
    const ids = protectionSnapshots[Math.min(protectionRead, protectionSnapshots.length - 1)] ?? []
    protectionRead += 1
    return ids.map(pageId => ({ pageId }))
  })
  const rawResponseRows = rawRows === undefined ? undefined : [...rawRows]
  knex.raw = vi.fn(async (_sql, bindings) => {
    if (rawResponseRows !== undefined) return { rows: rawResponseRows.shift() ?? [] }
    if (protectedIds.length > 0) return { rows: (protectedMetadataRows.shift() ?? []).map(id => ({ id })) }
    const limit = Number(bindings.at(-1))
    return { rows: privateRanks.slice(0, Number.isSafeInteger(limit) ? limit : privateRanks.length) }
  })
  const query = vi.fn().mockResolvedValue(engineResponse ?? { results: [], suggestions: [], totalHits: 0 })
  global.WIKI = {
    Error: { PageNotFound: class PageNotFound extends Error {} },
    auth: {
      checkAccess: vi.fn((_requester, permissions) => (permissions.includes('manage:system') ? isManager : true))
    },
    config: { db: { type: 'postgres' }, lang: { code: 'en' }, search: { maxHits: 100 } },
    data: { searchEngine: { supportsPageFilters: true, query } },
    models: { knex, pages }
  }
  return { pages, query, where }
}

const loadOperations = () => vi.importFresh('../operations/pages.ts', import.meta.url).then(module => module.default)

describe('page search visibility', () => {
  beforeEach(() => {
    vi.resetModules()
    searchVisible.mockReset().mockResolvedValue([])
    filterVisibleCurrentIds.mockReset().mockImplementation(async ({ pageIds }) => pageIds)
    getCurrentMany.mockReset().mockResolvedValue(new Map())
  })

  it('returns no candidates for a blank query without issuing private wildcard retrieval', async () => {
    const { pages, query } = installSearchWiki()
    const operations = await loadOperations()

    await expect(operations.search({ requester: { id: 7 }, query: '   ' })).resolves.toMatchObject({ results: [], totalHits: 0 })
    expect(pages.query).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('returns protected public pages for metadata phrases but not protected content-only matches', async () => {
    const protectedPage = page({ id: 3, sourceRevision: '8', title: 'Amber Falcon Runbook', description: 'Restricted procedures' })
    installSearchWiki({
      protectedIds: [3],
      metadataMatches: [[3], [3]],
      pageResults: [[protectedPage], [protectedPage]],
      engineResponse: {
        results: [{ id: 3, sourceRevision: '8', locale: 'en', path: 'docs/runbook', score: 8, matchedFields: ['title'] }],
        suggestions: [],
        totalHits: 1
      }
    })
    const operations = await loadOperations()

    await expect(operations.search({ query: '"Amber Falcon"' })).resolves.toMatchObject({
      results: [{ id: 3, sourceRevision: '8', matchedFields: ['title'] }]
    })

    vi.resetModules()
    const contentOnlyPage = page({ id: 3, sourceRevision: '8', title: 'Amber Falcon Runbook', description: 'Restricted procedures' })
    installSearchWiki({
      protectedIds: [3],
      metadataMatches: [[], []],
      pageResults: [[contentOnlyPage], [contentOnlyPage]],
      engineResponse: {
        results: [{ id: 3, sourceRevision: '8', locale: 'en', path: 'docs/runbook', score: 8, matchedFields: ['content'] }],
        suggestions: [],
        totalHits: 1
      }
    })
    const contentOperations = await loadOperations()
    await expect(contentOperations.search({ query: 'classified-content' })).resolves.toMatchObject({ results: [], totalHits: 0 })
  })

  it('applies private phrase, OR, and negation queries through the shared bounded retrieval path', async () => {
    const privatePage = page({ id: 7, sourceRevision: '4', visibility: 'private', ownerId: 7, path: 'private/alpha', title: 'Alpha Beta' })
    const verify = async queryText => {
      vi.resetModules()
      installSearchWiki({ pageResults: [[], [privatePage]], privateRanks: [{ id: 7, sourceRevision: '4', score: 0.4 }] })
      const operations = await loadOperations()
      await expect(operations.search({ requester: { id: 7 }, query: queryText })).resolves.toMatchObject({
        results: [{ id: 7, visibility: 'private' }]
      })
    }

    await verify('alpha - secret')
    await verify('"alpha beta"')
    await verify('alpha OR beta')
    await verify('alpha -secret')
  })

  it('keeps bounded negative-only private complements but does not claim positive content evidence', async () => {
    const privatePage = page({ id: 17, sourceRevision: '4', visibility: 'private', ownerId: 7, path: 'private/without-secret', title: 'Open notes' })
    installSearchWiki({ pageResults: [[], [privatePage]], privateRanks: [{ id: 17, sourceRevision: '4', score: 0.4 }] })
    const operations = await loadOperations()

    await expect(operations.search({ requester: { id: 7 }, query: '-secret' })).resolves.toMatchObject({
      results: [{ id: 17, matchedFields: [] }]
    })
  })

  it('keeps private candidates owner-scoped, permits managers across owners, and caps their contribution at fifty', async () => {
    const ownerPages = Array.from({ length: 60 }, (_, index) => page({
      id: index + 1,
      sourceRevision: String(index + 1),
      visibility: 'private',
      ownerId: 7,
      path: `private/${index + 1}`,
      title: `Draft ${index + 1}`
    }))
    const ranks = ownerPages.map(candidate => ({ id: candidate.id, sourceRevision: candidate.sourceRevision, score: 1 }))
    installSearchWiki({ pageResults: [[], ownerPages], privateRanks: ranks })
    let operations = await loadOperations()
    const ownerResult = await operations.search({ requester: { id: 7 }, query: 'draft', limit: 1001 })
    expect(ownerResult.results).toHaveLength(50)
    expect(ownerResult.results.every(result => result.visibility === 'private' && result.ownerId === 7)).toBe(true)

    vi.resetModules()
    const managerPage = page({ id: 81, sourceRevision: '5', visibility: 'private', ownerId: 8, path: 'private/other-owner', title: 'Managed draft' })
    installSearchWiki({
      isManager: true,
      pageResults: [[], [managerPage]],
      privateRanks: [{ id: 81, sourceRevision: '5', score: 1 }]
    })
    operations = await loadOperations()
    await expect(operations.search({ requester: { id: 1 }, query: 'draft', limit: 1001 })).resolves.toMatchObject({
      results: [{ id: 81, visibility: 'private', ownerId: 8 }]
    })
  })

  it('caps the combined private lexical and knowledge contribution at fifty', async () => {
    const lexicalPages = Array.from({ length: 50 }, (_, index) => page({
      id: index + 1,
      sourceRevision: '1',
      visibility: 'private',
      ownerId: 7,
      path: `private/${index + 1}`,
      title: `Private ${index + 1}`
    }))
    const knowledgePage = page({ id: 51, sourceRevision: '1', visibility: 'private', ownerId: 7, path: 'private/knowledge', title: 'Knowledge tail' })
    searchVisible.mockResolvedValueOnce([{
      id: 51,
      sourceRevision: '1',
      locale: 'en',
      path: 'private/knowledge',
      visibility: 'private',
      score: 7,
      matchedFields: ['knowledge'],
      knowledge: {}
    }])
    installSearchWiki({
      pageResults: [[], lexicalPages, [knowledgePage]],
      privateRanks: lexicalPages.map(candidate => ({ id: candidate.id, sourceRevision: '1', score: 1 }))
    })
    const operations = await loadOperations()

    const result = await operations.search({ requester: { id: 7 }, query: 'private' })
    expect(result.results.filter(candidate => candidate.visibility === 'private')).toHaveLength(50)
    expect(result.results).toEqual(expect.arrayContaining([expect.objectContaining({ id: 51, matchedFields: ['knowledge'] })]))
    expect(result.windowTruncated).toBe(true)
  })

  it('drops a private content candidate when protection is added before final hydration', async () => {
    const privatePage = page({ id: 61, sourceRevision: '3', visibility: 'private', ownerId: 7, path: 'private/changed-protection' })
    installSearchWiki({
      pageResults: [[], [privatePage]],
      protectedIdSnapshots: [[], [61]],
      rawRows: [[{ id: 61, sourceRevision: '3', score: 1 }], []]
    })
    const operations = await loadOperations()

    await expect(operations.search({ requester: { id: 7 }, query: 'classified' })).resolves.toMatchObject({ results: [], totalHits: 0 })
  })

  it('passes selected scope and the Agent knowledge filter before the knowledge window cap', async () => {
    const selected = page({ id: 88, sourceRevision: '12', title: 'Database Rotation', path: 'ops/rotation' })
    searchVisible.mockResolvedValueOnce([
      {
        id: 88,
        sourceRevision: '12',
        locale: 'en',
        path: 'ops/rotation',
        visibility: 'public',
        score: 7,
        matchedFields: ['knowledge'],
        knowledge: {}
      }
    ])
    installSearchWiki({ pageResults: [[selected], [selected]] })
    const operations = await loadOperations()

    await expect(
      operations.search({ query: 'rotation paraphrase', pageIds: [88], limit: 1, knowledge: { lifecycleStatus: 'stable' } })
    ).resolves.toMatchObject({ results: [{ id: 88, sourceRevision: '12', matchedFields: ['knowledge'] }] })
    expect(searchVisible).toHaveBeenCalledWith(expect.objectContaining({
      pageIds: [88],
      authorizedPageIds: [88],
      filter: { lifecycleStatus: 'stable' }
    }))
  })

  it('applies the knowledge filter to lexical public IDs before the engine window', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => page({
      id: index + 1,
      sourceRevision: '1',
      path: `docs/${index + 1}`,
      title: index === 100 ? 'Stable tail' : `Unfiltered ${index + 1}`
    }))
    const allowed = candidates.at(-1)
    filterVisibleCurrentIds.mockImplementation(async ({ pageIds }) => (pageIds === undefined ? [] : pageIds.filter(id => id === allowed.id)))
    getCurrentMany.mockResolvedValue(new Map([[
      allowed.id,
      {
        sourceRevision: '1',
        state: 'complete',
        conceptType: null,
        lifecycle: { status: 'stable', trustTier: 'human-reviewed', stale: false }
      }
    ]]))
    const { query } = installSearchWiki({ pageResults: [candidates, [allowed]] })
    query.mockImplementation(async (_query, options) => ({
      results: options.pageIds.map(id => ({
        id,
        sourceRevision: '1',
        locale: 'en',
        path: candidates.find(candidate => candidate.id === id).path,
        score: 1,
        matchedFields: ['title']
      })),
      suggestions: [],
      totalHits: options.pageIds.length
    }))
    const operations = await loadOperations()

    await expect(operations.search({ query: 'tail', knowledge: { lifecycleStatus: 'stable' } })).resolves.toMatchObject({
      results: [{ id: allowed.id, sourceRevision: '1' }]
    })
    expect(query).toHaveBeenCalledWith('tail', expect.objectContaining({ pageIds: [allowed.id] }))
  })
  it('pins the public engine scope to authorized metadata revisions and ignores caller revision maps', async () => {
    const authorized = page({ id: 77, sourceRevision: '12', path: 'docs/pinned' })
    installSearchWiki({
      pageResults: [[authorized], [authorized]],
      engineResponse: {
        results: [{ id: 77, sourceRevision: '12', locale: 'en', path: 'docs/pinned', score: 2, matchedFields: ['title'] }],
        suggestions: [],
        totalHits: 1
      }
    })
    const operations = await loadOperations()

    await expect(
      operations.search({ query: 'pinned', pageRevisions: { '77': '1' }, pageIds: [77] })
    ).resolves.toMatchObject({ results: [expect.objectContaining({ id: 77, sourceRevision: '12' })] })
    expect(global.WIKI.data.searchEngine.query).toHaveBeenCalledWith(
      'pinned',
      expect.objectContaining({ pageIds: [77], pageRevisions: { '77': '12' } })
    )
  })


  it('rejects stale lexical evidence when an old indexed id is replaced at the same route', async () => {
    const replacement = page({ id: 22, sourceRevision: '9', title: 'Replacement', path: 'docs/reused-route' })
    installSearchWiki({
      pageResults: [[replacement], [replacement]],
      engineResponse: {
        results: [{ id: 21, sourceRevision: '8', locale: 'en', path: 'docs/reused-route', score: 10, matchedFields: ['title'] }],
        suggestions: ['reused-route'],
        totalHits: 1
      }
    })
    const operations = await loadOperations()

    await expect(operations.search({ query: 'replacement' })).resolves.toMatchObject({ results: [], suggestions: [], totalHits: 0 })
  })
  it('fails closed when a provider or private rank omits its source revision', async () => {
    const publicPage = page({ id: 31, sourceRevision: '4', path: 'docs/revisioned' })
    installSearchWiki({
      pageResults: [[publicPage], [publicPage]],
      engineResponse: {
        results: [{ id: 31, locale: 'en', path: 'docs/revisioned', score: 1, matchedFields: ['title'] }],
        suggestions: [],
        totalHits: 1
      }
    })
    let operations = await loadOperations()
    await expect(operations.search({ query: 'revisioned' })).resolves.toMatchObject({ results: [], totalHits: 0 })

    vi.resetModules()
    const privatePage = page({ id: 32, sourceRevision: '4', visibility: 'private', ownerId: 7, path: 'private/revisioned' })
    installSearchWiki({
      pageResults: [[], [privatePage]],
      privateRanks: [{ id: 32, score: 1 }]
    })
    operations = await loadOperations()
    await expect(operations.search({ requester: { id: 7 }, query: 'revisioned' })).resolves.toMatchObject({ results: [], totalHits: 0 })
  })

})
