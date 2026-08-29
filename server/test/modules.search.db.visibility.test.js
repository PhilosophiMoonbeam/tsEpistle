const originalWIKI = global.WIKI

describe('database search public source isolation', () => {
  afterEach(() => {
    vi.resetModules()
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  it('filters private rows before matching and limiting public search results', async () => {
    const where = vi.fn().mockReturnThis()
    const query = {
      column: vi.fn().mockReturnThis(),
      withGraphJoined: vi.fn().mockReturnThis(),
      modifyGraph: vi.fn((_relation, callback) => {
        callback({ select: vi.fn() })
        return query
      }),
      where,
      limit: vi.fn().mockReturnThis(),
      then: resolve => Promise.resolve([]).then(resolve)
    }
    global.WIKI = {
      config: { db: { type: 'postgres' }, search: { maxHits: 20 } },
      models: { pages: { query: vi.fn().mockReturnValue(query) } }
    }
    const plugin = (await vi.importFresh('../modules/search/db/engine.ts', import.meta.url)).default

    expect(await plugin.query('secret', {})).toEqual({ results: [], suggestions: [], totalHits: 0 })
    expect(where).toHaveBeenCalledWith('visibility', 'public')
    expect(query.limit).toHaveBeenCalledWith(20)
  })
})
