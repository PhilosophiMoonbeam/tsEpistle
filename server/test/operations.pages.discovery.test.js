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
    vi.doMock('../repositories/page-index.ts', () => ({ PAGE_INDEX_CANDIDATE_LIMIT: 5_001, listPageIndexCandidates }))
    const checkAccess = vi.fn().mockReturnValue(true)
    global.WIKI = {
      auth: { checkAccess },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {},
      Error: {},
      models: { knex: {}, pages: {}, tags: {}, pageHistory: {} }
    }

    const { default: operations } = await import('../operations/pages.ts')
    const requester = { id: 7 }
    await expect(operations.discover({ requester, locale: 'en', path: 'docs', depth: 1, tags: ['RUNBOOK'], order: 'title', limit: 1, offset: 0 })).resolves.toEqual({
      pages: [{ id: 2, locale: 'en', path: 'docs/nested/alpha', title: 'Alpha', description: 'Nested', updatedAt: '2026-08-21T00:00:00.000Z', tags: ['runbook', 'release'] }],
      totalInWindow: 2,
      windowLimit: 5_000,
      nextOffset: 1
    })
    await expect(operations.discover({ requester, locale: 'en', path: 'docs', depth: 1, tags: ['runbook'], order: 'title', limit: 1, offset: 1 })).resolves.toMatchObject({
      pages: [{ id: 1, path: 'docs/zulu' }],
      totalInWindow: 2,
      nextOffset: null
    })
    expect(listPageIndexCandidates).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locale: 'en', path: 'docs', limit: 5_001 }))
    expect(checkAccess).toHaveBeenCalledWith(requester, ['read:pages'], expect.objectContaining({ path: 'docs/nested/alpha', tags: ['runbook', 'release'] }))
  })
})
