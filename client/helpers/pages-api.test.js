import {
  buildOkfMetadataPayload,
  deletePage,
  discardCollaborationDraft,
  fetchPage,
  fetchPageHistory,
  fetchPageLinks,
  fetchPageList,
  fetchPages,
  fetchPageLocaleRelations,
  fetchPageTags,
  fetchPageTree,
  fetchPageVersion,
  fetchRecentPages,
  linkPageLocaleRelation,
  restorePageVersion,
  searchPages,
  unlinkPageLocaleRelation,
  updatePage,
  validateOkfMetadataPayload
} from './pages-api.ts'

function createJsonResponse(payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

const missingOkf = {
  authority: { state: 'missing', metadata: null, trust: null },
  projection: { state: 'pending', value: null }
}
const validProjection = {
  schemaVersion: 2,
  sourceRevision: '8',
  state: 'partial',
  conceptType: null,
  summary: '',
  tags: [],
  searchTerms: [],
  entities: [],
  relationships: [],
  openQuestions: [],
  lifecycle: {
    status: 'stable',
    trustTier: 'human-reviewed',
    verification: 'current',
    stale: false,
    generatedAt: '2026-01-01T00:00:00.000Z',
    verifiedAt: '2026-01-02T00:00:00.000Z',
    staleAfter: null
  },
  missingFields: ['concept.type', 'concept.searchTerms'],
  provenance: { deterministicVersion: 'wiki-knowledge-v2', utility: null }
}
const pagePayload = (okf = missingOkf) => ({
  id: 7,
  locale: 'en',
  path: 'docs/alpha',
  hash: 'abc123',
  title: 'Alpha',
  description: null,
  visibility: 'public',
  ownerId: null,
  isPublished: true,
  publishStartDate: null,
  publishEndDate: null,
  contentType: 'markdown',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  sourceRevision: 8,
  editor: 'markdown',
  authorId: 2,
  authorName: 'Author',
  authorEmail: 'author@example.com',
  creatorId: 1,
  creatorName: 'Creator',
  creatorEmail: 'creator@example.com',
  okf
})

describe('pages api helper', () => {
  test('fetches and validates page links payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 1,
          path: 'en/docs/home',
          title: 'Home',
          links: ['en/docs/target'],
          extra: 'ignored'
        }
      ])
    )

    expect(await fetchPageLinks(fetchImpl, 'en')).toEqual([{ id: 1, path: 'en/docs/home', title: 'Home', links: ['en/docs/target'] }])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/links?locale=en', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('URL-encodes page links locale requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

    expect(await fetchPageLinks(fetchImpl, 'pt BR')).toEqual([])

    expect(fetchImpl.mock.calls[0][0]).toBe('/_api/pages/links?locale=pt%20BR')
  })

  test('rejects malformed page links payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: 1, path: 'en/docs/home', title: 'Home', links: [7] }]))

    await expect(Promise.resolve(fetchPageLinks(fetchImpl, 'en', 'Bad links payload'))).rejects.toThrow('Bad links payload')
  })

  test('surfaces API error messages for failed page links requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system or read:pages is required' }, false))

    await expect(Promise.resolve(fetchPageLinks(fetchImpl, 'en', 'Bad links payload'))).rejects.toThrow('manage:system or read:pages is required')
  })

  test('fetches and validates page detail payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        id: 7,
        locale: 'en',
        path: 'docs/alpha',
        hash: 'abc123',
        title: 'Alpha',
        description: null,
        visibility: 'public',
        ownerId: null,
        isPublished: true,
        publishStartDate: null,
        publishEndDate: null,
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        sourceRevision: 8,
        editor: 'markdown',
        authorId: 2,
        authorName: 'Author',
        authorEmail: 'author@example.com',
        creatorId: 1,
        creatorName: 'Creator',
        creatorEmail: 'creator@example.com',
        okf: missingOkf,
        extra: 'ignored'
      })
    )

    expect(await fetchPage(fetchImpl, 7)).toEqual({
      id: 7,
      locale: 'en',
      path: 'docs/alpha',
      hash: 'abc123',
      title: 'Alpha',
      description: null,
      visibility: 'public',
      ownerId: null,
      isPublished: true,
      publishStartDate: null,
      publishEndDate: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      sourceRevision: '8',
      editor: 'markdown',
      authorId: 2,
      authorName: 'Author',
      authorEmail: 'author@example.com',
      creatorId: 1,
      creatorName: 'Creator',
      creatorEmail: 'creator@example.com',
      okf: missingOkf
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/7', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })
  test('treats a successful page response with missing OKF as invalid', async () => {
    const payload = pagePayload()
    delete payload.okf
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))
    await expect(fetchPage(fetchImpl, 7)).resolves.toMatchObject({
      okf: { authority: { state: 'invalid', metadata: null, trust: null }, projection: { state: 'pending', value: null } }
    })
  })

  test('normalizes current and pending OKF projection states with provenance', async () => {
    const current = {
      authority: {
        state: 'valid',
        metadata: { type: 'Reference', status: 'stable', generated: { by: 'human:2', at: '2026-01-01T00:00:00.000Z' } },
        trust: {
          trustTier: 'human-reviewed',
          verification: 'current',
          status: 'stable',
          stale: false,
          generatedAt: '2026-01-01T00:00:00.000Z',
          verifiedAt: '2026-01-02T00:00:00.000Z'
        }
      },
      projection: { state: 'current', value: validProjection }
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(pagePayload(current)))
    await expect(fetchPage(fetchImpl, 7)).resolves.toMatchObject({ sourceRevision: '8', okf: current })
    const malformed = structuredClone(current)
    malformed.projection.value.provenance.extra = true
    const malformedFetch = vi.fn().mockResolvedValue(createJsonResponse(pagePayload(malformed)))
    await expect(fetchPage(malformedFetch, 7, 'Bad OKF payload')).rejects.toThrow('Bad OKF payload')
  })

  test('validates bounded knowledge projection search terms', async () => {
    const current = {
      authority: {
        state: 'valid',
        metadata: { type: 'Reference', status: 'stable', generated: { by: 'human:2', at: '2026-01-01T00:00:00.000Z' } },
        trust: {
          trustTier: 'human-reviewed',
          verification: 'current',
          status: 'stable',
          stale: false,
          generatedAt: '2026-01-01T00:00:00.000Z',
          verifiedAt: '2026-01-02T00:00:00.000Z'
        }
      },
      projection: { state: 'current', value: validProjection }
    }
    const malformed = structuredClone(current)
    malformed.projection.value.searchTerms = ['x'.repeat(121)]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(pagePayload(malformed)))

    await expect(fetchPage(fetchImpl, 7, 'Bad knowledge projection')).rejects.toThrow('Bad knowledge projection')

    const obsolete = structuredClone(current)
    obsolete.projection.value.schemaVersion = 1
    const obsoleteFetch = vi.fn().mockResolvedValue(createJsonResponse(pagePayload(obsolete)))
    await expect(fetchPage(obsoleteFetch, 7, 'Obsolete knowledge projection')).rejects.toThrow('Obsolete knowledge projection')
  })

  test('accepts knowledge-only search matches and rejects unknown match fields', async () => {
    const response = {
      results: [
        {
          id: 7,
          title: 'Alpha',
          description: '',
          path: 'docs/alpha',
          locale: 'en',
          visibility: 'public',
          tags: [],
          score: 1,
          matchedFields: ['knowledge']
        }
      ],
      suggestions: [],
      totalHits: 1
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(response))

    await expect(searchPages(fetchImpl, 'alpha')).resolves.toMatchObject({
      results: [{ id: 7, matchedFields: ['knowledge'] }]
    })

    response.results[0].matchedFields = ['untrusted']
    await expect(searchPages(fetchImpl, 'alpha', {}, 'Bad search response')).rejects.toThrow('Bad search response')
  })

  test('strips page duplicates, actors, derived facts, and deleted sources from editable metadata', () => {
    expect(
      buildOkfMetadataPayload({
        type: 'Reference',
        status: 'stable',
        resource: 'https://example.test',
        sources: [{ resource: 'https://source.test' }],
        title: 'page title',
        description: 'page description',
        tags: ['page'],
        generated: { by: 'human:2' },
        verified: { by: 'human:2' },
        restored_from: { revision: '1' },
        'x-wiki': { projection: 'derived' },
        extension: { retained: true }
      })
    ).toEqual({
      type: 'Reference',
      status: 'stable',
      resource: 'https://example.test',
      sources: [{ resource: 'https://source.test' }],
      extension: { retained: true }
    })
    expect(buildOkfMetadataPayload({ type: 'Reference', status: 'stable' })).not.toHaveProperty('sources')
  })

  test('distinguishes absent OKF authority from invalid editable metadata', () => {
    expect(validateOkfMetadataPayload(null)).toEqual({ valid: true, payload: undefined })
    expect(buildOkfMetadataPayload(undefined)).toBeUndefined()

    const emptySource = validateOkfMetadataPayload({
      type: 'Reference',
      status: 'stable',
      sources: [{ resource: '' }]
    })
    expect(emptySource.valid).toBe(false)
    expect(emptySource.error.message).toContain('Source 1 resource is required')
    expect(() =>
      buildOkfMetadataPayload({
        type: 'Reference',
        status: 'stable',
        sources: [{ resource: '' }]
      })
    ).toThrow('Fix the Knowledge / OKF metadata before saving: Source 1 resource is required')

    expect(() =>
      buildOkfMetadataPayload({
        type: 'Reference',
        status: 'stable',
        stale_after: 'tomorrow'
      })
    ).toThrow('Stale after must be a valid ISO-8601 timestamp')
    expect(() =>
      buildOkfMetadataPayload({
        type: '',
        status: 'stable'
      })
    ).toThrow('Type is required')
  })

  test.each([
    '2026-08-31T12:00:00Z',
    '2026-08-31T12:00:00.000Z',
    '2026-08-31T12:00:00.123456Z',
    '2024-02-29T23:59:59+13:59',
    '2026-08-31T12:00:00+14:00',
    '2026-08-31T12:00:00-14:00'
  ])('accepts server-valid OKF timestamps: %s', timestamp => {
    const timestampFields = [{ stale_after: timestamp }, { generated: { by: 'machine:1', at: timestamp } }, { verified: { by: 'human:1', at: timestamp } }]

    for (const fields of timestampFields) {
      expect(validateOkfMetadataPayload({ type: 'Reference', ...fields }).valid).toBe(true)
    }
  })

  test.each([
    '2026-08-31T12:00Z',
    '2026-02-29T12:00:00Z',
    '2026-04-31T12:00:00Z',
    '2026-08-31T24:00:00Z',
    '2026-08-31T12:60:00Z',
    '2026-08-31T12:00:60Z',
    '2026-08-31T12:00:00+13:60',
    '2026-08-31T12:00:00+14:01',
    '2026-08-31T12:00:00-14:01',
    '2026-08-31T12:00:00+15:00'
  ])('blocks server-invalid OKF timestamps before save: %s', timestamp => {
    const timestampFields = [{ stale_after: timestamp }, { generated: { by: 'machine:1', at: timestamp } }, { verified: { by: 'human:1', at: timestamp } }]

    for (const fields of timestampFields) {
      const metadata = { type: 'Reference', ...fields }
      expect(validateOkfMetadataPayload(metadata).valid).toBe(false)
      expect(() => buildOkfMetadataPayload(metadata)).toThrow('Fix the Knowledge / OKF metadata before saving')
    }
  })
  test('includes editable OKF metadata with canonical CAS on page update', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ page: { id: 7, updatedAt: '2026-01-03T00:00:00.000Z', sourceRevision: 9 } }))
    await updatePage(
      fetchImpl,
      7,
      {
        content: 'body',
        description: '',
        editor: 'markdown',
        visibility: 'public',
        isPublished: true,
        locale: 'en',
        path: 'docs/alpha',
        publishEndDate: '',
        publishStartDate: '',
        scriptCss: '',
        scriptJs: '',
        tags: [],
        title: 'Alpha',
        okfMetadata: { type: 'Reference', status: 'stable' }
      },
      '8',
      4
    )
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      expectedSourceRevision: '8',
      expectedCollaborationGeneration: 4,
      okfMetadata: { type: 'Reference', status: 'stable' }
    })
    await expect(updatePage(fetchImpl, 7, {}, '0')).rejects.toThrow('Page update failed')
    await expect(updatePage(fetchImpl, 7, {}, '8', 0)).rejects.toThrow('Page update failed')
  })

  test('rejects malformed page detail payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ id: 7, locale: 'en', path: 'docs/alpha' }))

    await expect(Promise.resolve(fetchPage(fetchImpl, 7, 'Bad page payload'))).rejects.toThrow('Bad page payload')
  })

  test('surfaces API error messages for failed page detail requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'This page does not exist.' }, false))

    await expect(Promise.resolve(fetchPage(fetchImpl, 7, 'Bad page payload'))).rejects.toThrow('This page does not exist.')
  })

  test('fetches and validates page list payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 10,
          locale: 'en',
          path: 'docs/alpha',
          title: null,
          description: null,
          isPublished: true,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          tags: ['alpha', 'docs'],
          extra: 'ignored'
        }
      ])
    )

    expect(await fetchPageList(fetchImpl)).toEqual([
      {
        id: 10,
        locale: 'en',
        path: 'docs/alpha',
        title: null,
        description: null,
        isPublished: true,
        visibility: 'public',
        ownerId: null,
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        tags: ['alpha', 'docs']
      }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })
  test('accepts reader-shaped page rows without publication metadata and retains the omission', async () => {
    const readerRow = {
      id: 10,
      locale: 'en',
      path: 'docs/alpha',
      title: null,
      description: null,
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      tags: ['alpha', 'docs']
    }
    const listFetch = vi.fn().mockResolvedValue(createJsonResponse([readerRow]))
    const pagesFetch = vi.fn().mockResolvedValue(createJsonResponse([readerRow]))

    const listRows = await fetchPageList(listFetch)
    expect(listRows).toEqual([readerRow])
    expect(listRows[0]).not.toHaveProperty('isPublished')
    await expect(fetchPages(pagesFetch)).resolves.toEqual([readerRow])
  })

  test.each([undefined, null, 1, 'true'])('rejects malformed publication metadata when isPublished is present as %p', async isPublished => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 10,
          locale: 'en',
          path: 'docs/alpha',
          title: 'Alpha',
          description: null,
          isPublished,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          tags: ['alpha']
        }
      ])
    )

    await expect(fetchPageList(fetchImpl, 'Bad page list publication metadata')).rejects.toThrow('Bad page list publication metadata')
  })

  test('preserves privileged publication booleans', async () => {
    const rows = [true, false].map((isPublished, index) => ({
      id: index + 10,
      locale: 'en',
      path: `docs/${isPublished ? 'published' : 'draft'}`,
      title: null,
      description: null,
      isPublished,
      publishStartDate: null,
      publishEndDate: null,
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      tags: []
    }))
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(rows))

    await expect(fetchPageList(fetchImpl)).resolves.toEqual(rows)
  })

  test('rejects malformed page list rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', tags: ['alpha'] }]))

    await expect(Promise.resolve(fetchPageList(fetchImpl, 'Bad page list payload'))).rejects.toThrow('Bad page list payload')
  })

  test('rejects non-array page list payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ pages: [] }))

    await expect(Promise.resolve(fetchPageList(fetchImpl, 'Bad page list payload'))).rejects.toThrow('Bad page list payload')
  })

  test('surfaces API error messages for failed page list requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system or read:pages is required' }, false))

    await expect(Promise.resolve(fetchPageList(fetchImpl, 'Bad page list payload'))).rejects.toThrow('manage:system or read:pages is required')
  })

  test('fetches and validates admin page tags payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 1,
          tag: 'alpha',
          title: 'Alpha',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          extra: 'ignored'
        },
        {
          id: 2,
          tag: 'zeta',
          title: null,
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z'
        }
      ])
    )

    expect(await fetchPageTags(fetchImpl)).toEqual([
      { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 2, tag: 'zeta', title: null, createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/tags', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('accepts empty string tag values allowed by the tag update contract', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(createJsonResponse([{ id: 1, tag: '', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }]))

    expect(await fetchPageTags(fetchImpl)).toEqual([
      { id: 1, tag: '', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
    ])
  })

  test('rejects malformed admin page tags rows', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(createJsonResponse([{ id: 1, tag: 12, title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }]))

    await expect(Promise.resolve(fetchPageTags(fetchImpl, 'Bad page tags payload'))).rejects.toThrow('Bad page tags payload')
  })

  test('rejects non-array admin page tags payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ tags: [] }))

    await expect(Promise.resolve(fetchPageTags(fetchImpl, 'Bad page tags payload'))).rejects.toThrow('Bad page tags payload')
  })

  test('surfaces API error messages for failed page tags requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system or read:pages is required' }, false))

    await expect(Promise.resolve(fetchPageTags(fetchImpl, 'Bad page tags payload'))).rejects.toThrow('manage:system or read:pages is required')
  })

  test('fetches and validates dashboard recent-pages payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 10,
          locale: 'en',
          path: 'docs/alpha',
          title: 'Alpha',
          updatedAt: '2026-01-03T00:00:00.000Z',
          visibility: 'private'
        },
        {
          id: 11,
          locale: 'fr',
          path: 'docs/beta',
          title: 'Beta',
          updatedAt: '2026-01-02T00:00:00.000Z',
          visibility: 'public'
        }
      ])
    )

    expect(await fetchRecentPages(fetchImpl)).toEqual([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z', visibility: 'private' },
      { id: 11, locale: 'fr', path: 'docs/beta', title: 'Beta', updatedAt: '2026-01-02T00:00:00.000Z', visibility: 'public' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/recent', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('accepts empty string fields allowed by the dashboard GraphQL contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 12,
          locale: 'en',
          path: '',
          title: '',
          updatedAt: '2026-01-01T00:00:00.000Z',
          visibility: 'public'
        }
      ])
    )

    expect(await fetchRecentPages(fetchImpl)).toEqual([
      { id: 12, locale: 'en', path: '', title: '', updatedAt: '2026-01-01T00:00:00.000Z', visibility: 'public' }
    ])
  })

  test('rejects malformed dashboard recent-pages rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: null }]))

    await expect(Promise.resolve(fetchRecentPages(fetchImpl, 'Bad recent pages payload'))).rejects.toThrow('Bad recent pages payload')
  })

  test('rejects non-array dashboard recent-pages payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ pages: [] }))

    await expect(Promise.resolve(fetchRecentPages(fetchImpl, 'Bad recent pages payload'))).rejects.toThrow('Bad recent pages payload')
  })

  test('surfaces API error messages for failed recent-pages requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system or read:pages is required' })
    })

    await expect(Promise.resolve(fetchRecentPages(fetchImpl, 'Bad recent pages payload'))).rejects.toThrow('manage:system or read:pages is required')
  })

  test('deletes pages with a source-revision compare-and-swap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Page has been deleted.' }))

    expect(await deletePage(fetchImpl, 7, '8')).toEqual({ message: 'Page has been deleted.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/7', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expectedSourceRevision: '8' })
    })
  })

  test('discards a collaboration draft with page timestamp and source-revision fences', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ discarded: true }))

    await discardCollaborationDraft(fetchImpl, 7, '2026-08-15T00:00:00.000Z', '8')

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/7/collaboration/draft', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expectedUpdatedAt: '2026-08-15T00:00:00.000Z', expectedSourceRevision: '8' })
    })
  })

  test('surfaces collaboration discard conflicts instead of treating them as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse(
        {
          error: 'Another user is actively editing this page.'
        },
        false
      )
    )

    await expect(Promise.resolve(discardCollaborationDraft(fetchImpl, 7, '2026-08-15T00:00:00.000Z', '8'))).rejects.toThrow(
      'Another user is actively editing this page.'
    )
  })

  test('surfaces API error messages for failed page delete requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'This page does not exist.' }, false))

    await expect(Promise.resolve(deletePage(fetchImpl, 7, '8'))).rejects.toThrow('This page does not exist.')
  })

  test('rejects malformed successful page delete responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({}))

    await expect(Promise.resolve(deletePage(fetchImpl, 7, '8', 'Bad page delete response'))).rejects.toThrow('Bad page delete response')
  })

  test('validates complete immutable revision metadata', async () => {
    const version = {
      versionId: 9,
      content: '# Before',
      contentType: 'markdown',
      title: 'Before',
      description: 'Earlier content',
      editor: 'visual-markdown',
      locale: 'en',
      path: 'docs/before',
      tags: ['docs'],
      versionDate: '2026-08-15T00:00:00.000Z',
      visibility: 'private'
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(version))

    expect(await fetchPageVersion(fetchImpl, 42, 9)).toEqual(version)
    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/42/history/9', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })

  test('rejects revision payloads that omit canonical editor metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        versionId: 9,
        content: '# Before',
        title: 'Before',
        description: '',
        path: 'before'
      })
    )

    await expect(Promise.resolve(fetchPageVersion(fetchImpl, 42, 9, 'Invalid revision'))).rejects.toThrow('Invalid revision')
  })

  test('restores against the page source revision observed when history opened', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Page version restored successfully.' }))
    const expectedSourceRevision = '8'

    expect(await restorePageVersion(fetchImpl, 42, 9, expectedSourceRevision)).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/42/history/9/restore', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expectedSourceRevision })
    })
  })

  test('fetches paginated revision metadata for the history timeline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        total: 1,
        trail: [
          {
            versionId: 9,
            authorId: 7,
            authorName: 'Owner',
            actionType: 'edit',
            valueBefore: null,
            valueAfter: null,
            versionDate: '2026-08-15T00:00:00.000Z'
          }
        ]
      })
    )

    expect(await fetchPageHistory(fetchImpl, 42, 0, 25)).toMatchObject({ total: 1 })
    expect(fetchImpl.mock.calls[0][0]).toBe('/_api/pages/42/history?offsetPage=0&offsetSize=25')
  })

  test('preserves per-resource edit capability on page tree rows', async () => {
    const row = {
      id: 10,
      path: 'docs',
      title: 'Docs',
      isFolder: true,
      pageId: 7,
      parent: 0,
      locale: 'en',
      visibility: 'public',
      ownerId: null,
      canEdit: true
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([row]))

    expect(await fetchPageTree(fetchImpl, { locale: 'en', parent: 0 })).toEqual([row])
    expect(fetchImpl.mock.calls[0][0]).toBe('/_api/pages/tree?locale=en&mode=ALL&parent=0')
  })

  test('passes personal scope when expanding a reader path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))
    await fetchPageTree(fetchImpl, { locale: 'en', path: 'shared/page', visibility: 'private', includeAncestors: true })
    expect(fetchImpl.mock.calls[0][0]).toBe('/_api/pages/tree?locale=en&mode=ALL&path=shared%2Fpage&includeAncestors=true&visibility=private')
  })

  test('rejects page tree rows without an explicit edit capability', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
        {
          id: 10,
          path: 'docs',
          title: 'Docs',
          isFolder: true,
          pageId: 7,
          parent: 0,
          locale: 'en',
          visibility: 'public',
          ownerId: null
        }
      ])
    )

    await expect(Promise.resolve(fetchPageTree(fetchImpl, { locale: 'en' }, 'Bad page tree'))).rejects.toThrow('Bad page tree')
  })

  test('validates page translation relations', async () => {
    const relation = {
      id: 7,
      locale: 'fr',
      path: 'guide/bonjour',
      title: 'Bonjour',
      visibility: 'public'
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([relation]))

    expect(await fetchPageLocaleRelations(fetchImpl, 42)).toEqual([relation])
    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/42/locale-relations', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })

  test('rejects malformed page translation relations', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ id: 7, locale: 'fr', path: 'guide/bonjour' }]))

    await expect(Promise.resolve(fetchPageLocaleRelations(fetchImpl, 42, 'Bad translations'))).rejects.toThrow('Bad translations')
  })

  test('links and unlinks translations through resource-scoped endpoints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

    expect(await linkPageLocaleRelation(fetchImpl, 42, 7)).toEqual([])
    expect(await unlinkPageLocaleRelation(fetchImpl, 42, 7)).toEqual([])
    expect(fetchImpl.mock.calls).toEqual([
      [
        '/_api/pages/42/locale-relations',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ relatedPageId: 7 })
        }
      ],
      [
        '/_api/pages/42/locale-relations/7',
        {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }
      ]
    ])
  })
})
