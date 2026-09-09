const pageTreeAccess = vi.fn()
vi.mockModule('../../repositories/page-tree-access.ts', import.meta.url, () => ({ pageTreeAccess, treeAncestorIds: () => [] }))
const taxonomyLegacyChange = vi.fn()
vi.mockModule('../../operations/taxonomy.ts', import.meta.url, () => ({ default: () => ({ legacyChange: taxonomyLegacyChange }) }))
vi.mockModule('express', import.meta.url, () => {
  const router = {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    use: vi.fn()
  }

  const expressMock = {
    Router: () => router,
    __router: router
  }

  return { default: expressMock, ...expressMock }
})

const express = await import('express')
const storedKnowledgeProjection = (sourceRevision = '8') => ({
  version: 2,
  source: {
    pageId: 7,
    sourceRevision,
    sha256: 'a'.repeat(64),
    locale: 'en',
    path: 'docs/alpha',
    visibility: 'public',
    contentType: 'markdown',
    updatedAt: '2026-01-02T00:00:00.000Z',
    authorId: 2
  },
  concept: {
    id: 'en/docs/alpha',
    type: 'Reference',
    title: 'Alpha',
    description: 'Alpha description',
    summary: 'Projected Alpha',
    tags: ['alpha'],
    searchTerms: [],
    sections: [],
    links: [],
    sources: [],
    entities: [],
    relationships: [],
    openQuestions: []
  },
  lifecycle: {
    status: 'stable',
    trustTier: 'human-reviewed',
    verification: 'current',
    generatedAt: '2026-01-02T00:00:00.000Z',
    verifiedAt: '2026-01-02T00:00:00.000Z',
    staleAfter: null
  },
  completeness: { state: 'complete', missingFields: [] },
  provenance: { deterministicVersion: 'wiki-knowledge-v2', fields: [], utility: null }
})

const projectionSearchDictionary = 'english'

const knexWithProjection = (projection = null) => {
  const knex = vi.fn().mockImplementation(table => {
    const chain = {
      first: vi.fn().mockResolvedValue(table === 'pageKnowledgeProjections as projections' && projection !== null
        ? {
            pageId: 7,
            sourceRevision: '8',
            sourceSha256: 'a'.repeat(64),
            deterministicVersion: 'wiki-knowledge-v2',
            searchDictionary: projectionSearchDictionary,
            projection
          }
        : undefined),
      join: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue([])
    }
    return chain
  })
  knex.client = { config: { client: 'pg' } }
  return knex
}

const graphPage = ({ id, path, localeCode = 'en', title, sourceRevision = 1 }) => ({
  id,
  path,
  localeCode,
  title,
  description: '',
  visibility: 'public',
  ownerId: null,
  isPublished: true,
  publishStartDate: '',
  publishEndDate: '',
  contentType: 'markdown',
  sourceRevision,
  updatedAt: '2026-01-02T00:00:00.000Z',
  tags: []
})

const graphPageQuery = (pages, failure) => {
  const result = failure ? Promise.reject(failure) : Promise.resolve(pages)
  const chain = {
    column: vi.fn(),
    modify: vi.fn(),
    modifyGraph: vi.fn(),
    then: result.then.bind(result),
    withGraphJoined: vi.fn()
  }
  chain.column.mockReturnValue(chain)
  chain.withGraphJoined.mockReturnValue(chain)
  chain.modifyGraph.mockImplementation((_relation, applyModifier) => {
    applyModifier({ select: vi.fn() })
    return chain
  })
  chain.modify.mockImplementation(applyModifier => {
    applyModifier({ where: vi.fn() })
    return chain
  })
  return chain
}
const linksKnex = ({ rows, protectedPageIds = [], receipts = [] }) =>
  vi.fn(table => {
    if (table === 'pageAccessPasswords') return Promise.resolve(protectedPageIds.map(pageId => ({ pageId })))
    if (table === 'pageMutationOutbox') {
      const query = {
        where: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        then: vi.fn((resolve, reject) => Promise.resolve(receipts).then(resolve, reject))
      }
      return query
    }
    if (table !== 'pages') throw new Error(`Unexpected table ${table}`)
    const query = {
      column: vi.fn().mockReturnThis(),
      fullOuterJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn(function (_table, callback) {
        if (typeof callback === 'function') {
          const joinBuilder = {
            on: vi.fn().mockReturnThis(),
            andOn: vi.fn().mockReturnThis()
          }
          callback.call(joinBuilder)
        }
        return this
      }),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((resolve, reject) => Promise.resolve(rows).then(resolve, reject))
    }
    return query
  })


describe('controllers/api pages endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    taxonomyLegacyChange.mockReset().mockResolvedValue({ tagId: 7, pageCount: 0, refreshWarnings: [] })
    express.__router.delete.mockClear()
    express.__router.get.mockClear()
    express.__router.patch.mockClear()
    express.__router.post.mockClear()
    express.__router.put.mockClear()

    global.WIKI = {
      data: {
        searchEngine: {
          config: {
            dictLanguage: projectionSearchDictionary
          }
        }
      },
      auth: {
        checkAccess: vi.fn((user, permissions) => {
          const userPermissions = user?.permissions ?? []
          return userPermissions.includes('manage:system') || permissions.some(permission => userPermissions.includes(permission))
        }),
        checkPageAccess: vi.fn((user, permissions, _context, authority) =>
          authority?.requester === user &&
          permissions.some(permission => user?.permissions?.includes(permission))
        ),
        loadPageRuleAuthority: vi.fn(async requester => ({
          requester,
          permissions: requester?.permissions ?? [],
          groups: [],
          tagAliases: {}
        }))
      },
      config: {
        db: {
          type: 'postgres'
        }
      },
      collaboration: {
        issueSession: vi.fn(),
        discardDraft: vi.fn()
      },
      models: {
        knex: knexWithProjection(),
        tags: {
          query: vi.fn().mockReturnValue({
            deleteById: vi.fn().mockResolvedValue(1),
            findById: vi.fn().mockReturnValue({
              $relatedQuery: vi.fn().mockReturnValue({
                unrelate: vi.fn().mockResolvedValue(1)
              }),
              patch: vi.fn().mockResolvedValue(1)
            })
          })
        },
        pages: {
          deletePage: vi.fn().mockResolvedValue(undefined),
          updatePage: vi.fn().mockResolvedValue({ id: 7 }),
          getPageFromDb: vi.fn().mockResolvedValue({
            id: 7,
            path: 'docs/alpha',
            hash: 'abc123',
            title: 'Alpha',
            description: 'Alpha description',
            visibility: 'public',
            ownerId: null,
            isPublished: 1,
            publishStartDate: '',
            publishEndDate: '',
            contentType: 'markdown',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            sourceRevision: 8,
            editorKey: 'markdown',
            localeCode: 'en',
            authorId: 2,
            authorName: 'Author',
            authorEmail: 'author@example.com',
            creatorId: 1,
            creatorName: 'Creator',
            creatorEmail: 'creator@example.com',
            tags: [],
          }),
          query: vi.fn(() => {
            const rows = [
              {
                id: 10,
                locale: 'en',
                path: 'docs/alpha',
                title: 'Alpha',
                updatedAt: '2026-01-03T00:00:00.000Z',
                tags: [{ tag: 'alpha' }],
                visibility: 'public',
                ownerId: null
              },
              {
                id: 11,
                locale: 'fr',
                path: 'docs/beta',
                title: 'Beta',
                updatedAt: '2026-01-02T00:00:00.000Z',
                tags: [{ tag: 'beta' }],
                visibility: 'public',
                ownerId: null
              }
            ]
            const queryBuilder = {
              andWhere: vi.fn(),
              limit: vi.fn().mockResolvedValue(rows),
              orWhere: vi.fn(),
              where: vi.fn(),
              whereExists: vi.fn(callback => {
                callback({
                  select: vi.fn().mockReturnThis(),
                  from: vi.fn().mockReturnThis(),
                  join: vi.fn().mockReturnThis(),
                  where: vi.fn().mockReturnThis(),
                  whereIn: vi.fn().mockReturnThis(),
                  whereRaw: vi.fn().mockReturnThis()
                })
                return queryBuilder
              })
            }
            const chain = {
              column: vi.fn(),
              limit: queryBuilder.limit,
              modify: vi.fn(),
              modifyGraph: vi.fn(),
              orderBy: vi.fn(),
              withGraphFetched: vi.fn(),
              withGraphJoined: vi.fn(),
              __tagBuilder: { select: vi.fn() }
            }
            chain.column.mockReturnValue(chain)
            chain.modify.mockImplementation(applyModifier => {
              applyModifier(queryBuilder)
              return chain
            })
            chain.withGraphFetched.mockReturnValue(chain)
            chain.modifyGraph.mockImplementation((relation, applyGraphModifier) => {
              applyGraphModifier(chain.__tagBuilder)
              return chain
            })
            chain.orderBy.mockReturnValue(chain)
            return chain
          })
        }
      }
    }
  })

  const loadHandler = async () => {
    await vi.importFresh('../../controllers/api/pages.ts', import.meta.url)
    return {
      deletePage: express.__router.delete.mock.calls.find(([path]) => path === '/:id')[1],
      deleteTag: express.__router.delete.mock.calls.find(([path]) => path === '/tags/:id')[1],
      publication: express.__router.patch.mock.calls.find(([path]) => path === '/:id/publication')[1],
      updatePage: express.__router.put.mock.calls.find(([path]) => path === '/:id')[1],
      getPage: express.__router.get.mock.calls.find(([path]) => path === '/:id')[1],
      links: express.__router.get.mock.calls.find(([path]) => path === '/links')[1],
      listPages: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      listTags: express.__router.get.mock.calls.find(([path]) => path === '/tags')[1],
      searchTags: express.__router.get.mock.calls.find(([path]) => path === '/tags/search')[1],
      recent: express.__router.get.mock.calls.find(([path]) => path === '/recent')[1],
      updateTag: express.__router.patch.mock.calls.find(([path]) => path === '/tags/:id')[1],
      visibility: express.__router.patch.mock.calls.find(([path]) => path === '/:id/visibility')[1],
      restore: express.__router.post.mock.calls.find(([path]) => path === '/:id/history/:versionId/restore')[1],
      submitApproval: express.__router.post.mock.calls.find(([path]) => path === '/:id/approval')[1],
      collaborationSession: express.__router.post.mock.calls.find(([path]) => path === '/:id/collaboration/session')[1],
      collaborationDiscard: express.__router.delete.mock.calls.find(([path]) => path === '/:id/collaboration/draft')[1],
      tree: express.__router.get.mock.calls.find(([path]) => path === '/tree')[1]
    }
  }

  it('reports visibility path collisions as conflicts after validating the source revision', async () => {
    const collision = new Error('Destination page path already exists.')
    collision.name = 'PagePathCollision'
    global.WIKI.models.pages.changeVisibility = vi.fn().mockRejectedValue(collision)
    const { visibility } = await loadHandler()
    const req = {
      body: { visibility: 'public', confirmPublication: true, expectedSourceRevision: '8' },
      params: { id: '2' },
      user: { id: 1, permissions: ['read:pages', 'manage:system'] }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await visibility(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Destination page path already exists.' })
  })


  it('requires and forwards the observed source revision for revision restores', async () => {
    const sourceRevision = '8'
    const requester = { id: 1, permissions: ['read:pages', 'write:pages', 'manage:system'] }
    global.WIKI.models.knex = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
    })
    global.WIKI.models.pages.query = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        findById: vi.fn().mockResolvedValue({
          id: 7,
          path: 'docs/alpha',
          localeCode: 'en',
          sourceRevision,
          visibility: 'public',
          ownerId: null
        })
      })
    })
    global.WIKI.models.pages.updatePage = vi.fn().mockResolvedValue(undefined)
    global.WIKI.models.pageHistory = {
      getVersion: vi.fn().mockResolvedValue({
        versionId: 3,
        content: '# Earlier',
        contentType: 'markdown',
        title: 'Earlier',
        description: '',
        editor: 'visual-markdown',
        locale: 'en',
        path: 'docs/alpha',
        tags: ['docs'],
        versionDate: '2026-08-14T00:00:00.000Z',
        visibility: 'public'
      })
    }
    const { restore } = await loadHandler()
    const req = {
      body: { expectedSourceRevision: sourceRevision },
      params: { id: '7', versionId: '3' },
      user: requester,
      sessionID: 'restore-session'
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await restore(req, res, vi.fn())

    expect(global.WIKI.models.pages.updatePage).toHaveBeenCalledWith(expect.objectContaining({
      id: 7,
      user: requester,
      expectedSourceRevision: sourceRevision,
      action: 'restored'
    }))
    expect(res.json).toHaveBeenCalledWith({ message: 'Page version restored successfully.' })
  })

  it('rejects revision restores without a source revision', async () => {
    global.WIKI.models.knex = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
    })
    const { restore } = await loadHandler()
    const req = {
      body: {},
      params: { id: '7', versionId: '3' },
      user: { id: 1, permissions: ['read:pages', 'write:pages', 'manage:system'] },
      sessionID: 'restore-session'
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await restore(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'expectedSourceRevision must be a canonical positive decimal string' })
  })

  it('requires an observed source revision before submitting a page approval', async () => {
    const { submitApproval } = await loadHandler()
    const req = {
      body: { assigneeId: 3 },
      params: { id: '7' },
      user: { id: 1, permissions: ['read:pages', 'write:pages'] },
      sessionID: 'approval-session'
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await submitApproval(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'expectedSourceRevision must be a canonical positive decimal string' })
  })

  it('rejects locked GraphQL updates and permits REST and GraphQL updates with a current-session grant', async () => {
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions) =>
      permissions.some(permission => user?.permissions?.includes(permission))
    )
    let grantActive = false
    const deleteExpired = vi.fn().mockResolvedValue(0)
    global.WIKI.models.knex.mockImplementation(table => {
      if (table === 'pageAccessPasswords') {
        return {
          where: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ pageId: 7, version: 2 })
          })
        }
      }
      if (table === 'pageUnlockGrants') {
        return {
          where: vi.fn().mockImplementation((column, operator) => {
            if (column === 'expiresAt' && operator === '<=') return { delete: deleteExpired }
            return {
              where: vi.fn().mockReturnValue({
                first: vi.fn().mockImplementation(async () => grantActive ? { id: 'grant-1' } : undefined)
              })
            }
          })
        }
      }
      throw new Error(`Unexpected table ${table}`)
    })
    const requester = { id: 5, permissions: ['read:pages', 'write:pages'] }
    const args = { id: 7, expectedSourceRevision: '8', expectedCollaborationGeneration: 4, title: 'Updated' }
    const context = { req: { user: requester, sessionID: 'current-session' } }
    const { updatePage } = await loadHandler()
    const { default: pageResolvers } = await vi.importFresh('../../graph/resolvers/page.ts', import.meta.url)

    const lockedGraphResult = await pageResolvers.PageMutation.update(null, args, context)

    expect(lockedGraphResult.responseResult).toEqual(expect.objectContaining({ succeeded: false, message: 'Access denied' }))
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()

    grantActive = true
    const grantedResponse = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await updatePage(
      { body: args, params: { id: '7' }, sessionID: 'current-session', user: requester },
      grantedResponse,
      vi.fn()
    )
    const grantedGraphResult = await pageResolvers.PageMutation.update(null, args, context)

    expect(grantedResponse.json).toHaveBeenCalledWith({ page: { id: 7, capabilities: { viewStewardContacts: false } } })
    expect(grantedGraphResult.responseResult).toEqual(expect.objectContaining({ succeeded: true }))
    expect(global.WIKI.models.pages.updatePage).toHaveBeenCalledTimes(2)
    expect(global.WIKI.models.pages.updatePage).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedCollaborationGeneration: 4
    }))
  })

  it.each([
    undefined,
    8,
    '0',
    '01',
    '+8',
    ' 8',
    '8 ',
    '8.0',
    '1'.repeat(65)
  ])('rejects noncanonical page update source revisions: %s', async expectedSourceRevision => {
    const { updatePage } = await loadHandler()
    const req = {
      body: { expectedSourceRevision, title: 'Updated' },
      params: { id: '7' },
      sessionID: 'session-write',
      user: { id: 5, permissions: ['read:pages', 'write:pages'] }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updatePage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'expectedSourceRevision must be a canonical positive decimal string' })
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, '1', null])('rejects invalid collaboration generation fences: %s', async expectedCollaborationGeneration => {
    const { updatePage } = await loadHandler()
    const req = {
      body: { expectedSourceRevision: '8', expectedCollaborationGeneration, title: 'Updated' },
      params: { id: '7' },
      sessionID: 'session-write',
      user: { id: 5, permissions: ['read:pages', 'write:pages'] }
    }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updatePage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'expectedCollaborationGeneration must be a positive safe integer' })
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
  })

  it('forwards editable OKF metadata without echoing spoofed trust actors', async () => {
    const requester = { id: 5, permissions: ['read:pages', 'write:pages'] }
    const okfMetadata = {
      type: 'Reference',
      title: 'Updated authority',
      generated: { by: 'human:999', at: '2026-01-01T00:00:00.000Z' },
      verified: { by: 'human:999', at: '2026-01-01T00:00:00.000Z' }
    }
    global.WIKI.models.pages.updatePage.mockResolvedValueOnce({
      id: 7,
      extra: {
        okf: {
          type: 'Reference',
          title: 'Updated authority',
          generated: { by: 'human:5', at: '2026-08-31T00:00:00.000Z' }
        }
      }
    })
    const { updatePage } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updatePage(
      {
        body: { expectedSourceRevision: '8', title: 'Updated', okfMetadata },
        params: { id: '7' },
        sessionID: 'session-write',
        user: requester
      },
      res,
      vi.fn()
    )

    expect(res.json).toHaveBeenCalledWith({
      page: {
        id: 7,
        extra: {
          okf: {
            type: 'Reference',
            title: 'Updated authority',
            generated: { by: 'human:5', at: '2026-08-31T00:00:00.000Z' }
          }
        },
        capabilities: { viewStewardContacts: false }
      }
    })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('human:999')
  })

  it('maps malformed OKF metadata to a bounded 400 response without exposing a stack', async () => {
    const validationError = Object.assign(new Error(`Invalid OKF metadata: ${'x'.repeat(600)}`), {
      name: 'OkfDocumentError',
      code: 'INVALID_OKF_ROOT'
    })
    global.WIKI.models.pages.updatePage.mockRejectedValueOnce(validationError)
    const { updatePage } = await loadHandler()
    const next = vi.fn()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updatePage(
      {
        body: { expectedSourceRevision: '8', okfMetadata: [] },
        params: { id: '7' },
        sessionID: 'session-write',
        user: { id: 5, permissions: ['read:pages', 'write:pages'] }
      },
      res,
      next
    )

    expect(res.status).toHaveBeenCalledWith(400)
    const response = res.json.mock.calls[0][0]
    expect(response.error).toHaveLength(500)
    expect(response).not.toHaveProperty('stack')
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    [Object.assign(new Error('The page is stale.'), { name: 'PageUpdateConflict', status: 409 })],
    [Object.assign(new Error('The page changed during the update.'), { name: 'PageUpdateConflict' })]
  ])('maps stale and concurrent page source conflicts to 409', async conflict => {
    global.WIKI.models.pages.updatePage.mockRejectedValueOnce(conflict)
    const { updatePage } = await loadHandler()
    const next = vi.fn()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updatePage(
      {
        body: { expectedSourceRevision: '8', title: 'Updated' },
        params: { id: '7' },
        sessionID: 'session-write',
        user: { id: 5, permissions: ['read:pages', 'write:pages'] }
      },
      res,
      next
    )

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: conflict.message })
    expect(next).not.toHaveBeenCalled()
  })
  it('accepts a collaboration session with the observed timestamp', async () => {
    const expectedUpdatedAt = '2026-08-15T00:00:00.000Z'
    const requester = { id: 7, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.models.knex = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
    })
    global.WIKI.collaboration.issueSession.mockResolvedValue({
      pageId: 7,
      protocolVersion: 1
    })
    const { collaborationSession } = await loadHandler()
    const req = {
      body: { expectedUpdatedAt },
      params: { id: '7' },
      user: requester,
      sessionID: 'collaboration-session'
    }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await collaborationSession(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({ pageId: 7, protocolVersion: 1 })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('rejects collaboration sessions without a concurrency timestamp', async () => {
    global.WIKI.models.knex = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
    })
    const { collaborationSession } = await loadHandler()
    const req = {
      body: {},
      params: { id: '7' },
      user: { id: 7, permissions: ['read:pages', 'write:pages'] },
      sessionID: 'collaboration-session'
    }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await collaborationSession(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(global.WIKI.collaboration.issueSession).not.toHaveBeenCalled()
  })

  it('discards a collaboration draft after the observed timestamp and source revision', async () => {
    const expectedUpdatedAt = '2026-08-15T00:00:00.000Z'
    const expectedSourceRevision = '8'
    const requester = { id: 7, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.models.knex = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
    })
    const { collaborationDiscard } = await loadHandler()
    const req = {
      body: { expectedUpdatedAt, expectedSourceRevision },
      params: { id: '7' },
      user: requester,
      sessionID: 'collaboration-session'
    }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await collaborationDiscard(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({ discarded: true })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('rejects collaboration discard without a concurrency timestamp', async () => {
    global.WIKI.models.knex = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
    })
    const { collaborationDiscard } = await loadHandler()
    const req = {
      body: {},
      params: { id: '7' },
      user: { id: 7, permissions: ['read:pages', 'write:pages'] },
      sessionID: 'collaboration-session'
    }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await collaborationDiscard(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(global.WIKI.collaboration.discardDraft).not.toHaveBeenCalled()
  })

  it('lists root page tree entries when parent is zero', async () => {
    const rows = [{
      id: 1,
      path: 'home',
      title: 'Home',
      isFolder: 0,
      visibility: 'public',
      ownerId: null,
      pageId: 1,
      parent: null,
      localeCode: 'en'
    }]
    const orderBy = vi.fn().mockResolvedValue(rows)
    const queryBuilder = {
      where: vi.fn((applyWhere) => {
        const whereBuilder = {
          andWhere: vi.fn(),
          whereNotNull: vi.fn(),
          orWhereIn: vi.fn(),
          where: vi.fn(),
          whereNull: vi.fn()
        }
        applyWhere(whereBuilder)
        return { orderBy }
      })
    }
    const transaction = Object.assign(vi.fn(() => queryBuilder), { commit: vi.fn(), rollback: vi.fn() })
    global.WIKI.models.knex.transaction = vi.fn().mockResolvedValue(transaction)
    pageTreeAccess.mockResolvedValue({ readable: new Set([1]), editable: new Set([1]), reachable: new Set() })
    const { tree } = await loadHandler()
    const req = { query: { locale: 'en', mode: 'ALL', parent: '0' }, user: { id: 1 } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await tree(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(res.json).toHaveBeenCalledWith([{
      ...rows[0],
      isFolder: false,
      visibility: 'public',
      ownerId: null,
      parent: 0,
      locale: 'en',
      canEdit: true
    }])
  })

  it('rejects invalid Browse scope before running a tree query', async () => {
    const { tree } = await loadHandler()
    for (const query of [{ locale: 'en', parent: '-1' }, { locale: 'en', mode: 'SECRET' }, { locale: 'en', visibility: 'everyone' }]) {
      const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }, next = vi.fn()
      await tree({ query, user: { id: 1 } }, res, next)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
      expect(res.vary).toHaveBeenCalledWith('Cookie')
      expect(next).not.toHaveBeenCalled()
    }
    expect(pageTreeAccess).not.toHaveBeenCalled()
  })
  it('keeps private tree headers when the Browse operation fails', async () => {
    const failure = new Error('Browse backend unavailable')
    const transaction = Object.assign(vi.fn(), { commit: vi.fn(), rollback: vi.fn() })
    global.WIKI.models.knex.transaction = vi.fn().mockResolvedValue(transaction)
    pageTreeAccess.mockReset().mockRejectedValueOnce(failure)
    const { tree } = await loadHandler()
    const req = { query: { locale: 'en', mode: 'ALL', parent: '0' }, user: { id: 1 } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await tree(req, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })


  it('resolves historical tag filters while preserving query semantics and access filtering', async () => {
    const rows = [
      {
        id: 10,
        locale: 'en',
        path: 'docs/alpha',
        title: 'Alpha',
        description: 'Alpha description',
        isPublished: 1,
        visibility: 'public',
        ownerId: null,
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        tags: [{ tag: 'alpha' }, { tag: 'docs' }]
      },
      {
        id: 11,
        locale: 'fr',
        path: 'docs/beta',
        title: 'Beta',
        description: 'Beta description',
        isPublished: 0,
        visibility: 'private',
        ownerId: 1,
        contentType: 'markdown',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
        tags: [{ tag: 'beta' }]
      }
    ]
    const existsBuilder = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      join: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      whereIn: vi.fn().mockReturnThis(),
      whereRaw: vi.fn().mockReturnThis()
    }
    const queryBuilder = {
      limit: vi.fn(),
      where: vi.fn(),
      whereExists: vi.fn(callback => {
        callback(existsBuilder)
        return queryBuilder
      }),
      orderBy: vi.fn()
    }
    const modify = vi.fn((applyQueryModifier) => {
      applyQueryModifier(queryBuilder)
      return Promise.resolve(rows)
    })
    const tagBuilder = { select: vi.fn() }
    const modifyGraph = vi.fn((relation, applyGraphModifier) => {
      applyGraphModifier(tagBuilder)
      return { modify }
    })
    const withGraphFetched = vi.fn().mockReturnValue({ modifyGraph })
    const column = vi.fn().mockReturnValue({ withGraphFetched })
    global.WIKI.models.pages.query.mockReturnValueOnce({ column })
    global.WIKI.auth.loadPageRuleAuthority.mockImplementation(async requester => ({
      requester,
      permissions: requester?.permissions ?? [],
      groups: [],
      tagAliases: { 'old-alpha': 'alpha', alpha: 'alpha', docs: 'docs' }
    }))
    const { listPages } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] }, query: { locale: 'en', limit: '50', orderBy: 'UPDATED', orderByDirection: 'DESC', tags: 'old-alpha, docs' } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listPages(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      {
        id: 10,
        locale: 'en',
        path: 'docs/alpha',
        title: 'Alpha',
        description: 'Alpha description',
        visibility: 'public',
        ownerId: null,
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        tags: ['alpha', 'docs']
      }
    ])
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })
  it('accepts reader-shaped list rows without restricted publication metadata', async () => {
    const row = {
      id: 42,
      locale: 'en',
      path: 'docs/reader',
      title: 'Reader page',
      description: 'Visible description',
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      tags: [{ tag: 'docs' }]
    }
    const expected = { ...row, tags: ['docs'] }
    const queryBuilder = { where: vi.fn(), orderBy: vi.fn() }
    const modify = vi.fn(applyQueryModifier => {
      applyQueryModifier(queryBuilder)
      return Promise.resolve([row])
    })
    const modifyGraph = vi.fn((_relation, applyGraphModifier) => {
      applyGraphModifier({ select: vi.fn() })
      return { modify }
    })
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphFetched: vi.fn().mockReturnValue({ modifyGraph })
      })
    })
    const { listPages } = await loadHandler()
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listPages({ user: { id: 7, permissions: ['read:pages'] }, query: {} }, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([expected])
    expect(res.json.mock.calls[0][0][0]).not.toHaveProperty('isPublished')
    expect(res.json.mock.calls[0][0][0]).not.toHaveProperty('publishStartDate')
    expect(res.json.mock.calls[0][0][0]).not.toHaveProperty('publishEndDate')
  })

  it('retains boolean publication metadata for privileged page list rows', async () => {
    const row = {
      id: 43,
      locale: 'en',
      path: 'docs/admin',
      title: 'Admin page',
      description: null,
      isPublished: false,
      publishStartDate: null,
      publishEndDate: null,
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      tags: []
    }
    const queryBuilder = { where: vi.fn(), orderBy: vi.fn() }
    const modify = vi.fn(applyQueryModifier => {
      applyQueryModifier(queryBuilder)
      return Promise.resolve([row])
    })
    const modifyGraph = vi.fn((_relation, applyGraphModifier) => {
      applyGraphModifier({ select: vi.fn() })
      return { modify }
    })
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphFetched: vi.fn().mockReturnValue({ modifyGraph })
      })
    })
    const { listPages } = await loadHandler()
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listPages({ user: { id: 1, permissions: ['read:pages', 'manage:system'] }, query: {} }, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([{
      id: 43,
      path: 'docs/admin',
      locale: 'en',
      title: 'Admin page',
      description: null,
      isPublished: false,
      publishStartDate: null,
      publishEndDate: null,
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      tags: []
    }])
  })

  it('rejects malformed publication metadata rather than exposing it', async () => {
    const row = {
      id: 44,
      locale: 'en',
      path: 'docs/malformed',
      title: 'Malformed page',
      description: null,
      isPublished: 'false',
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      tags: []
    }
    const queryBuilder = { where: vi.fn(), orderBy: vi.fn() }
    const modify = vi.fn(applyQueryModifier => {
      applyQueryModifier(queryBuilder)
      return Promise.resolve([row])
    })
    const modifyGraph = vi.fn((_relation, applyGraphModifier) => {
      applyGraphModifier({ select: vi.fn() })
      return { modify }
    })
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphFetched: vi.fn().mockReturnValue({ modifyGraph })
      })
    })
    const { listPages } = await loadHandler()
    const next = vi.fn()
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listPages({ user: { id: 7, permissions: ['read:pages'] }, query: {} }, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(TypeError))
    expect(res.json).not.toHaveBeenCalled()
  })

  it('returns permission-filtered tag suggestions through a correlated candidate query', async () => {
    const rows = [{
      path: 'docs/alpha',
      locale: 'en',
      visibility: 'public',
      ownerId: null,
      tags: [{ tag: 'alpha' }]
    }]
    const existsBuilder = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      join: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      whereRaw: vi.fn().mockReturnThis()
    }
    const queryBuilder = {
      where: vi.fn(),
      whereExists: vi.fn(callback => {
        callback(existsBuilder)
        return queryBuilder
      })
    }
    const modify = vi.fn(applyQueryModifier => {
      applyQueryModifier(queryBuilder)
      return Promise.resolve(rows)
    })
    const modifyGraph = vi.fn((_relation, applyGraphModifier) => {
      applyGraphModifier({ select: vi.fn() })
      return { modify }
    })
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphJoined: vi.fn().mockReturnValue({ modifyGraph })
      })
    })
    const { searchTags } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] }, query: { query: 'ALP' } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await searchTags(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith(['alpha'])
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })
  it('sets private cache headers before rejecting an invalid tag suggestion query', async () => {
    const { searchTags } = await loadHandler()
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await searchTags({ query: { query: '' } }, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('routes publication through the protected mutation with server-controlled identity and strips unrelated edits', async () => {
    const { publication } = await loadHandler()
    const user = { id: 2, permissions: ['read:pages', 'write:pages', 'manage:system'] }
    const req = { params: { id: '7' }, sessionID: 'session', user, body: { expectedSourceRevision: '8', isPublished: false, content: 'not a content edit', visibility: 'public' } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis() }, next = vi.fn()
    await publication(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(global.WIKI.models.pages.updatePage).toHaveBeenCalledWith({ id: 7, expectedSourceRevision: '8', isPublished: false, user })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
  })

  it('returns 403 for unauthorized page list requests', async () => {
    const { listPages } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: {} }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listPages(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected page list failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphFetched: vi.fn().mockReturnValue({
          modifyGraph: vi.fn((relation, applyGraphModifier) => {
            applyGraphModifier({ select: vi.fn() })
            return {
              modify: vi.fn().mockRejectedValue(new Error('page list db down'))
            }
          })
        })
      })
    })
    const { listPages } = await loadHandler()
    const req = { user: { id: 1, permissions: ['read:pages', 'manage:system'] }, query: {} }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listPages(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('page list db down')
  })


  it('lists unique page tags with GraphQL-compatible access filtering and tag ordering', async () => {
    const withGraphJoined = vi.fn().mockResolvedValue([
      {
        locale: 'en',
        path: 'docs/public',
        visibility: 'public',
        ownerId: null,
        tags: [
          { id: 2, tag: 'zeta', title: 'Zeta', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
          { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' }
        ]
      },
      {
        locale: 'fr',
        path: 'docs/private',
        visibility: 'private',
        ownerId: 7,
        tags: [
          { id: 3, tag: 'hidden', title: 'Hidden', createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-06T00:00:00.000Z' }
        ]
      },
      {
        locale: 'en',
        path: 'docs/duplicate',
        visibility: 'public',
        ownerId: null,
        tags: [
          { id: 2, tag: 'zeta', title: 'Zeta Duplicate', createdAt: '2026-01-07T00:00:00.000Z', updatedAt: '2026-01-08T00:00:00.000Z' }
        ]
      }
    ])
    const modify = vi.fn(applyModifier => {
      applyModifier({ where: vi.fn((callback) => callback({ where: vi.fn(), orWhere: vi.fn() })), orWhere: vi.fn() })
      return { withGraphJoined }
    })
    const column = vi.fn().mockReturnValue({ modify })
    global.WIKI.models.pages.query.mockReturnValueOnce({ column })
    const { listTags } = await loadHandler()
    const req = { user: { id: 8, permissions: ['read:pages'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listTags(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' },
      { id: 2, tag: 'zeta', title: 'Zeta', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' }
    ])
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('returns 403 for unauthorized page tag list requests', async () => {
    const { listTags } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listTags(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected page tag list failures to next', async () => {
    const next = vi.fn()
    const withGraphJoined = vi.fn().mockRejectedValue(new Error('tags db down'))
    const modify = vi.fn().mockReturnValue({ withGraphJoined })
    const column = vi.fn().mockReturnValue({ modify })
    global.WIKI.models.pages.query.mockReturnValueOnce({ column })
    const { listTags } = await loadHandler()
    const req = { user: { id: 1, permissions: ['read:pages', 'manage:system'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await listTags(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('tags db down')
  })


  it('returns the minimal dashboard recent-pages payload for authorized requests', async () => {
    const { recent } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await recent(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z', visibility: 'public' },
      { id: 11, locale: 'fr', path: 'docs/beta', title: 'Beta', updatedAt: '2026-01-02T00:00:00.000Z', visibility: 'public' }
    ])
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('filters pages that fail per-row page access checks', async () => {
    global.WIKI.auth.checkPageAccess.mockImplementation((user, permissions, page, authority) =>
      authority?.requester === user &&
      permissions.includes('read:pages') &&
      page?.path !== 'docs/beta'
    )
    const { recent } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await recent(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z', visibility: 'public' }
    ])
  })

  it('returns 403 for unauthorized recent-pages requests', async () => {
    const { recent } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await recent(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected recent-pages failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        modify: vi.fn().mockReturnValue({
          withGraphFetched: vi.fn().mockReturnValue({
            modifyGraph: vi.fn((relation, applyGraphModifier) => {
              applyGraphModifier({ select: vi.fn() })
              return {
                orderBy: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockRejectedValue(new Error('pages db down'))
                  })
                })
              }
            })
          })
        })
      })
    })
    const { recent } = await loadHandler()
    const req = { user: { id: 1, permissions: ['read:pages', 'manage:system'] } }
    const res = { json: vi.fn(), set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), vary: vi.fn().mockReturnThis() }

    await recent(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('pages db down')
  })

  it('returns page link records for accessible endpoint records', async () => {
    const rows = [
      {
        id: 1,
        path: 'docs/home',
        title: 'Home',
        sourceRevision: 1,
        sourceLocale: 'en',
        link: 'docs/target',
        locale: 'en',
        targetId: 2,
        targetRevision: 1,
        targetPath: 'docs/target',
        targetLocale: 'en'
      },
      {
        id: 1,
        path: 'docs/home',
        title: 'Home',
        sourceRevision: 1,
        sourceLocale: 'en',
        link: 'docs/other',
        locale: 'fr',
        targetId: 3,
        targetRevision: 1,
        targetPath: 'docs/other',
        targetLocale: 'fr'
      },
      { id: 2, path: 'docs/target', title: 'Target', sourceRevision: 1, sourceLocale: 'en', link: null, locale: null }
    ]
    global.WIKI.models.pages.query.mockImplementationOnce(() =>
      graphPageQuery([
        graphPage({ id: 1, path: 'docs/home', title: 'Home' }),
        graphPage({ id: 2, path: 'docs/target', title: 'Target' }),
        graphPage({ id: 3, path: 'docs/other', localeCode: 'fr', title: 'Other' })
      ])
    )
    global.WIKI.models.knex = linksKnex({
      rows,
      receipts: [{ pageId: 1, sourceRevision: 1 }]
    })


    const { links } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 1, title: 'Home', path: 'en/docs/home', links: ['en/docs/target', 'fr/docs/other'] },
      { id: 2, title: 'Target', path: 'en/docs/target', links: [] }
    ])
  })

  it('filters page links when source or target page access is denied', async () => {
    const rows = [
      {
        id: 1,
        path: 'docs/home',
        title: 'Home',
        sourceRevision: 1,
        sourceLocale: 'en',
        link: 'docs/target',
        locale: 'en',
        targetId: 2,
        targetRevision: 1,
        targetPath: 'docs/target',
        targetLocale: 'en'
      },
      {
        id: 3,
        path: 'docs/hidden-source',
        title: 'Hidden Source',
        sourceRevision: 1,
        sourceLocale: 'en',
        link: 'docs/target',
        locale: 'en',
        targetId: 2,
        targetRevision: 1,
        targetPath: 'docs/target',
        targetLocale: 'en'
      },
      {
        id: 1,
        path: 'docs/home',
        title: 'Home',
        sourceRevision: 1,
        sourceLocale: 'en',
        link: 'docs/secret',
        locale: 'en',
        targetId: 4,
        targetRevision: 1,
        targetPath: 'docs/secret',
        targetLocale: 'en'
      }
    ]
    global.WIKI.models.pages.query.mockImplementationOnce(() =>
      graphPageQuery([
        graphPage({ id: 1, path: 'docs/home', title: 'Home' }),
        graphPage({ id: 2, path: 'docs/target', title: 'Target' }),
        graphPage({ id: 3, path: 'docs/hidden-source', title: 'Hidden Source' }),
        graphPage({ id: 4, path: 'docs/secret', title: 'Secret' })
      ])
    )
    global.WIKI.models.knex = linksKnex({ rows, receipts: [{ pageId: 1, sourceRevision: 1 }] })
    global.WIKI.auth.checkPageAccess.mockImplementation((user, permissions, page, authority) =>
      authority?.requester === user &&
      permissions.includes('read:pages') &&
      page?.path !== 'docs/hidden-source' &&
      page?.path !== 'docs/secret'
    )
    const { links } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 1, title: 'Home', path: 'en/docs/home', links: ['en/docs/target'] }
    ])
  })

  it('returns 400 for invalid page links locale requests', async () => {
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: '' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'locale must be a non-empty string' })
    expect(global.WIKI.models.knex).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized page links requests', async () => {
    const { links } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(global.WIKI.models.knex).not.toHaveBeenCalled()
  })

  it('forwards graph metadata failures to next', async () => {
    const next = vi.fn()
    const failure = new Error('graph metadata unavailable')
    global.WIKI.models.pages.query.mockImplementationOnce(() => graphPageQuery([], failure))
    global.WIKI.models.knex = linksKnex({ rows: [] })
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.json).not.toHaveBeenCalled()
  })


  it('returns internal page details for authorized page detail requests', async () => {
    const { getPage } = await loadHandler()
    const req = { user: { id: 3, permissions: ['read:pages', 'write:pages'] }, sessionID: 'session-write', params: { id: '7' } }
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({
      id: 7,
      path: 'docs/alpha',
      hash: 'abc123',
      title: 'Alpha',
      description: 'Alpha description',
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
      locale: 'en',
      branding: null,
      okf: {
        authority: { state: 'missing', metadata: null, trust: null },
        projection: { state: 'pending', value: null }
      },
      brandingAssignment: null,
      capabilities: { viewStewardContacts: true },
      authorId: 2,
      authorName: 'Author',
      authorEmail: 'author@example.com',
      creatorId: 1,
      creatorName: 'Creator',
      creatorEmail: 'creator@example.com'
    })
  })

  it('omits field-restricted page metadata from reader detail responses', async () => {
    const { getPage } = await loadHandler()
    const req = { user: { id: 4, permissions: ['read:pages'] }, sessionID: 'session-read', params: { id: '7' } }
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({
      id: 7,
      path: 'docs/alpha',
      hash: 'abc123',
      title: 'Alpha',
      description: 'Alpha description',
      visibility: 'public',
      ownerId: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      sourceRevision: '8',
      locale: 'en',
      branding: null,
      capabilities: { viewStewardContacts: false },
      okf: {
        authority: { state: 'missing', metadata: null, trust: null },
        projection: { state: 'pending', value: null }
      }
    })
  })

  it('returns complete valid authority and a revision-matched current projection to field-restricted readers', async () => {
    const metadata = {
      type: 'Reference',
      title: 'Authoritative Alpha',
      status: 'stable',
      generated: { by: 'human:2', at: '2026-01-01T00:00:00.000Z' },
      verified: { by: 'human:3', at: '2026-01-02T00:00:00.000Z' },
      extension: { safe: true }
    }
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      ...await global.WIKI.models.pages.getPageFromDb(),
      extra: { okf: metadata }
    })
    global.WIKI.models.knex = knexWithProjection(storedKnowledgeProjection('8'))
    const { getPage } = await loadHandler()
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(
      { user: { id: 4, permissions: ['read:pages'] }, sessionID: 'session-read', params: { id: '7' } },
      res,
      vi.fn()
    )

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      okf: {
        authority: {
          state: 'valid',
          metadata,
          trust: {
            trustTier: 'human-reviewed',
            verification: 'current',
            status: 'stable',
            stale: false,
            generatedAt: '2026-01-01T00:00:00.000Z',
            verifiedAt: '2026-01-02T00:00:00.000Z'
          }
        },
        projection: {
          state: 'current',
          value: {
            schemaVersion: 2,
            sourceRevision: '8',
            state: 'complete',
            conceptType: 'Reference',
            summary: 'Projected Alpha',
            tags: ['alpha'],
            searchTerms: [],
            entities: [],
            relationships: [],
            openQuestions: [],
            lifecycle: {
              status: 'stable',
              trustTier: 'human-reviewed',
              verification: 'current',
              generatedAt: '2026-01-02T00:00:00.000Z',
              verifiedAt: '2026-01-02T00:00:00.000Z',
              staleAfter: null,
              stale: false
            },
            missingFields: [],
            provenance: { deterministicVersion: 'wiki-knowledge-v2', fields: [], utility: null }
          }
        }
      }
    }))
  })

  it.each([
    ['invalid JSON', '{not-json'],
    ['schema-invalid data', { version: 1 }]
  ])('degrades %s in a stored projection to pending while preserving readable authority', async (_description, projection) => {
    const metadata = { type: 'Reference', status: 'stable' }
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      ...await global.WIKI.models.pages.getPageFromDb(),
      extra: { okf: metadata }
    })
    global.WIKI.models.knex = knexWithProjection(projection)
    const { getPage } = await loadHandler()
    const next = vi.fn()
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(
      { user: { id: 4, permissions: ['read:pages'] }, sessionID: 'session-read', params: { id: '7' } },
      res,
      next
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      okf: {
        authority: expect.objectContaining({ state: 'valid', metadata }),
        projection: { state: 'pending', value: null }
      }
    }))
  })

  it('propagates projection database failures from page detail reads', async () => {
    const databaseError = new Error('projection db down')
    global.WIKI.models.knex = vi.fn().mockImplementation(table => ({
      first:
        table === 'pageKnowledgeProjections as projections'
          ? vi.fn().mockRejectedValue(databaseError)
          : vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis()
    }))
    const { getPage } = await loadHandler()
    const next = vi.fn()
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(
      { user: { id: 4, permissions: ['read:pages'] }, sessionID: 'session-read', params: { id: '7' } },
      res,
      next
    )

    expect(next).toHaveBeenCalledWith(databaseError)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('marks invalid stored authority explicitly without returning unsafe raw values', async () => {
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      ...await global.WIKI.models.pages.getPageFromDb(),
      extra: { okf: { type: '', unsafeSecret: 'must-not-leak' } }
    })
    const { getPage } = await loadHandler()
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(
      { user: { id: 4, permissions: ['read:pages'] }, sessionID: 'session-read', params: { id: '7' } },
      res,
      vi.fn()
    )

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      okf: {
        authority: { state: 'invalid', metadata: null, trust: null },
        projection: { state: 'pending', value: null }
      }
    }))
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('must-not-leak')
  })

  it('marks a mismatched repository projection pending and does not expose its value', async () => {
    global.WIKI.models.knex = knexWithProjection(storedKnowledgeProjection('9'))
    const { getPage } = await loadHandler()
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(
      { user: { id: 4, permissions: ['read:pages'] }, sessionID: 'session-read', params: { id: '7' } },
      res,
      vi.fn()
    )

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevision: '8',
      okf: {
        authority: { state: 'missing', metadata: null, trust: null },
        projection: { state: 'pending', value: null }
      }
    }))
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Projected Alpha')
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid page detail ids: %s', async (id) => {
    const { getPage } = await loadHandler()
    const req = { user: { id: 7, permissions: ['read:pages'] }, sessionID: 'invalid-detail', params: { id } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.pages.getPageFromDb).not.toHaveBeenCalled()
  })

  it('returns 404 when page detail is missing', async () => {
    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce(null)
    const { getPage } = await loadHandler()
    const req = { user: { id: 7, permissions: [] }, sessionID: 'missing-detail', params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This page does not exist.' })
  })

  it('returns 403 when page detail route access is denied', async () => {
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'authentication or read:pages is required' })
    expect(global.WIKI.models.pages.getPageFromDb).not.toHaveBeenCalled()
  })

  it('returns the same not-found response when page-level access is denied', async () => {
    const { getPage } = await loadHandler()
    global.WIKI.auth.checkPageAccess.mockImplementation(() => false)
    const req = { user: { id: 7, permissions: ['read:pages'] }, sessionID: 'denied-detail', params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This page does not exist.' })
    expect(global.WIKI.models.knex.mock.calls.some(([table]) => table === 'pageKnowledgeProjections as projections')).toBe(false)
  })

  it('masks private authority and projection data from non-owners before querying knowledge storage', async () => {
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      ...await global.WIKI.models.pages.getPageFromDb(),
      visibility: 'private',
      ownerId: 7,
      extra: { okf: { type: 'Reference', privateSecret: 'must-not-leak' } }
    })
    const { getPage } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(
      { user: { id: 8, permissions: ['read:pages'] }, sessionID: 'other-session', params: { id: '7' } },
      res,
      vi.fn()
    )

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This page does not exist.' })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('must-not-leak')
    expect(global.WIKI.models.knex.mock.calls.some(([table]) => table === 'pageKnowledgeProjections as projections')).toBe(false)
  })

  it('returns private page details to the authenticated owner without requiring global page permissions', async () => {
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      ...await global.WIKI.models.pages.getPageFromDb(),
      visibility: 'private',
      ownerId: 7
    })
    const { getPage } = await loadHandler()
    const req = { user: { id: 7, permissions: [] }, sessionID: 'owner-detail', params: { id: '7' } }
    const res = { json: vi.fn(), set: vi.fn(), status: vi.fn().mockReturnThis(), vary: vi.fn() }

    await getPage(req, res, vi.fn())

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 7, visibility: 'private', ownerId: 7 }))
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.vary).toHaveBeenCalledWith('Cookie')
  })

  it('forwards unexpected page detail failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.pages.getPageFromDb.mockRejectedValueOnce(new Error('page db down'))
    const { getPage } = await loadHandler()
    const req = { user: { id: 1, permissions: ['read:pages', 'manage:system'] }, sessionID: 'detail-error', params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('page db down')
  })


  it('requires delete:pages or manage:system for page deletes', async () => {
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'delete:pages or manage:system is required' })
    expect(global.WIKI.models.pages.deletePage).not.toHaveBeenCalled()
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid page delete ids: %s', async (id) => {
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['read:pages', 'delete:pages'] }, sessionID: 'delete-validation', params: { id } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.pages.deletePage).not.toHaveBeenCalled()
  })

  it('deletes pages through the model with GraphQL-compatible user context', async () => {
    const { deletePage } = await loadHandler()
    const req = { user: { id: 5, permissions: ['read:pages', 'delete:pages'] }, sessionID: 'delete-session', params: { id: '7' }, body: { expectedSourceRevision: '8' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await deletePage(req, res, vi.fn())
    expect(res.json).toHaveBeenCalledWith({ message: 'Page has been deleted.' })

  })

  it('maps page delete not-found failures to JSON 404 errors', async () => {
    const err = new Error('This page does not exist.')
    err.name = 'PageNotFound'
    global.WIKI.models.pages.deletePage.mockRejectedValueOnce(err)
    const { deletePage } = await loadHandler()
    const req = { user: { id: 5, permissions: ['read:pages', 'delete:pages'] }, sessionID: 'delete-session', params: { id: '7' }, body: { expectedSourceRevision: '8' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This page does not exist.' })
  })

  it('maps page delete model authorization failures to JSON 403 errors', async () => {
    const err = new Error('You are not authorized to delete this page.')
    err.name = 'PageDeleteForbidden'
    global.WIKI.models.pages.deletePage.mockRejectedValueOnce(err)
    const { deletePage } = await loadHandler()
    const req = { user: { id: 5, permissions: ['read:pages', 'delete:pages'] }, sessionID: 'delete-session', params: { id: '7' }, body: { expectedSourceRevision: '8' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to delete this page.' })
  })

  it('forwards unexpected page delete failures to the central error policy', async () => {
    const failure = new Error('page db down')
    global.WIKI.models.pages.deletePage.mockRejectedValueOnce(failure)
    const { deletePage } = await loadHandler()
    const req = { user: { id: 5, permissions: ['read:pages', 'delete:pages'] }, sessionID: 'delete-session', params: { id: '7' }, body: { expectedSourceRevision: '8' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await deletePage(req, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.json).not.toHaveBeenCalled()
  })


  it('requires manage:system for tag updates', async () => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid tag update ids: %s', async (id) => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id }, body: { tag: 'News', title: 'News' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
  })

  it.each([
    [{ tag: 12, title: 'News' }, 'tag must be a string'],
    [{ tag: 'News', title: null }, 'title must be a string']
  ])('rejects malformed tag update payloads', async (body, error) => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error })
  })

  it('updates a tag through the reviewed lifecycle', async () => {
    const { updateTag } = await loadHandler()
    const req = { user: { id: 1, permissions: ['manage:system'] }, sessionID: 'session', params: { id: '7' }, body: { tag: '  News  ', title: ' Current News ' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await updateTag(req, res, vi.fn())
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been updated successfully.' })
  })

  it('returns lifecycle validation and review conflicts through the operation error policy', async () => {
    taxonomyLegacyChange.mockRejectedValueOnce(Object.assign(new Error('Review this change in Administration → Tags.'), { status: 409 }))
    const { updateTag } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await updateTag({ user: { id: 1, permissions: ['manage:system'] }, sessionID: 'tag-session', params: { id: '7' }, body: { tag: 'news', title: '' } }, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Review this change in Administration → Tags.' })
  })

  it('forwards unexpected tag lifecycle failures to the central error policy', async () => {
    const failure = new Error('tag db down')
    taxonomyLegacyChange.mockRejectedValueOnce(failure)
    const { updateTag } = await loadHandler()
    const next = vi.fn(), res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await updateTag({ user: { id: 1, permissions: ['manage:system'] }, sessionID: 'tag-session', params: { id: '7' }, body: { tag: 'news', title: '' } }, res, next)
    expect(next).toHaveBeenCalledWith(failure)
    expect(res.json).not.toHaveBeenCalled()
  })


  it('requires manage:system for tag deletes', async () => {
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid tag delete ids: %s', async (id) => {
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it('archives a tag through the reviewed lifecycle with administrator context', async () => {
    const { deleteTag } = await loadHandler()
    const req = { user: { id: 1, permissions: ['manage:system'] }, sessionID: 'tag-session', params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await deleteTag(req, res, vi.fn())
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been archived. Historical references are preserved.' })
  })

  it('returns a JSON 404 when archiving a missing tag', async () => {
    taxonomyLegacyChange.mockRejectedValueOnce(Object.assign(new Error('This tag no longer exists.'), { status: 404 }))
    const { deleteTag } = await loadHandler()
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await deleteTag({ user: { id: 1, permissions: ['manage:system'] }, sessionID: 'tag-session', params: { id: '7' } }, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This tag no longer exists.' })
  })
})
