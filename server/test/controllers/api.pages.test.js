jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
    use: jest.fn()
  }

  return {
    Router: () => router,
    __router: router
  }
})

describe('controllers/api pages endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()
    express.__router.patch.mockClear()

    global.WIKI = {
      auth: {
        checkAccess: jest.fn().mockReturnValue(true)
      },
      models: {
        tags: {
          query: jest.fn().mockReturnValue({
            findById: jest.fn().mockReturnValue({
              patch: jest.fn().mockResolvedValue(1)
            })
          })
        },
        pages: {
          query: jest.fn().mockReturnValue({
            column: jest.fn().mockReturnValue({
              withGraphJoined: jest.fn().mockReturnValue({
                modifyGraph: jest.fn((relation, applyGraphModifier) => {
                  const builder = { select: jest.fn() }
                  applyGraphModifier(builder)
                  return {
                    orderBy: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue([
                        {
                          id: 10,
                          locale: 'en',
                          path: 'docs/alpha',
                          title: 'Alpha',
                          updatedAt: '2026-01-03T00:00:00.000Z',
                          tags: [{ tag: 'alpha' }],
                          isPrivate: true
                        },
                        {
                          id: 11,
                          locale: 'fr',
                          path: 'docs/beta',
                          title: 'Beta',
                          updatedAt: '2026-01-02T00:00:00.000Z',
                          tags: [{ tag: 'beta' }]
                        }
                      ])
                    }),
                    __tagBuilder: builder
                  }
                })
              })
            })
          })
        }
      }
    }
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/pages')
    return {
      recent: express.__router.get.mock.calls.find(([path]) => path === '/recent')[1],
      updateTag: express.__router.patch.mock.calls.find(([path]) => path === '/tags/:id')[1]
    }
  }

  it('registers the recent pages route', () => {
    const { recent } = loadHandler()

    expect(typeof recent).toBe('function')
  })

  it('returns the minimal dashboard recent-pages payload for authorized requests', async () => {
    const { recent } = loadHandler()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await recent(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(1, { permissions: ['read:pages'] }, ['manage:system', 'read:pages'])
    expect(global.WIKI.models.pages.query).toHaveBeenCalled()
    const queryBuilder = global.WIKI.models.pages.query.mock.results[0].value
    expect(queryBuilder.column).toHaveBeenCalledWith(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt'])
    const columnBuilder = queryBuilder.column.mock.results[0].value
    expect(columnBuilder.withGraphJoined).toHaveBeenCalledWith('tags')
    const tagJoinBuilder = columnBuilder.withGraphJoined.mock.results[0].value
    expect(tagJoinBuilder.modifyGraph).toHaveBeenCalledWith('tags', expect.any(Function))
    const modifiedBuilder = tagJoinBuilder.modifyGraph.mock.results[0].value
    expect(modifiedBuilder.__tagBuilder.select).toHaveBeenCalledWith('tag')
    expect(modifiedBuilder.orderBy).toHaveBeenCalledWith('updatedAt', 'desc')
    expect(modifiedBuilder.orderBy.mock.results[0].value.limit).toHaveBeenCalledWith(10)
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(2, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/alpha', locale: 'en', tags: [{ tag: 'alpha' }] })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(3, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/beta', locale: 'fr', tags: [{ tag: 'beta' }] })
    expect(res.json).toHaveBeenCalledWith([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: 11, locale: 'fr', path: 'docs/beta', title: 'Beta', updatedAt: '2026-01-02T00:00:00.000Z' }
    ])
  })

  it('filters pages that fail per-row page access checks', async () => {
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const { recent } = loadHandler()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await recent(req, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z' }
    ])
  })

  it('returns 403 for unauthorized recent-pages requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { recent } = loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await recent(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected recent-pages failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: jest.fn().mockReturnValue({
        withGraphJoined: jest.fn().mockReturnValue({
          modifyGraph: jest.fn((relation, applyGraphModifier) => {
            applyGraphModifier({ select: jest.fn() })
            return {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockRejectedValue(new Error('pages db down'))
              })
            }
          })
        })
      })
    })
    const { recent } = loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await recent(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('pages db down')
  })

  it('registers the tag update route', () => {
    const { updateTag } = loadHandler()

    expect(typeof updateTag).toBe('function')
  })

  it('requires manage:system for tag updates', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['read:pages'] }, ['manage:system'])
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
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id }, body: { tag: 'News', title: 'News' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it.each([
    [{ tag: 12, title: 'News' }, 'tag must be a string'],
    [{ tag: 'News', title: null }, 'title must be a string']
  ])('rejects malformed tag update payloads', async (body, error) => {
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it('updates tags with GraphQL-compatible trim and lowercase semantics', async () => {
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: '  News  ', title: '  Current News  ' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    const tagsQuery = global.WIKI.models.tags.query.mock.results[0].value
    expect(tagsQuery.findById).toHaveBeenCalledWith(7)
    const tagPatch = tagsQuery.findById.mock.results[0].value
    expect(tagPatch.patch).toHaveBeenCalledWith({ tag: 'news', title: 'Current News' })
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been updated successfully.' })
  })

  it('allows empty strings to preserve existing updateTag GraphQL write semantics', async () => {
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: '', title: '' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    const tagsQuery = global.WIKI.models.tags.query.mock.results[0].value
    expect(tagsQuery.findById.mock.results[0].value.patch).toHaveBeenCalledWith({ tag: '', title: '' })
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been updated successfully.' })
  })

  it('returns a JSON 404 when a tag update affects no rows', async () => {
    global.WIKI.models.tags.query.mockReturnValueOnce({
      findById: jest.fn().mockReturnValue({
        patch: jest.fn().mockResolvedValue(0)
      })
    })
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This tag does not exist.' })
  })

  it('returns JSON errors for unexpected tag update failures', async () => {
    global.WIKI.models.tags.query.mockReturnValueOnce({
      findById: jest.fn().mockReturnValue({
        patch: jest.fn().mockRejectedValue(new Error('tag db down'))
      })
    })
    const { updateTag } = loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'tag db down' })
  })
})
