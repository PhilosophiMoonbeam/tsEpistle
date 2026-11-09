import createKnex from 'knex'
import objection from 'objection'
import express from 'express'
import { buildSchema, graphql } from 'graphql'
import pageErrors from '../../helpers/error.ts'

// The database owns candidate filtering/ordering; the real operation owns admission
// and visible offsets. HTTP and GraphQL consumers below do not mock that operation.
describe('shared page-list publication admission', () => {
  let db, operations, requester, server, baseUrl, resolvers
  const reader = { id: 7, permissions: ['read:pages'] }
  const writer = { id: 7, permissions: ['read:pages', 'write:pages'] }
  const manager = { id: 1, permissions: ['manage:system'] }
  const now = Date.parse('2026-11-08T12:00:00Z')
  const originalWiki = global.WIKI
  const loadPageRuleAuthority = async user => ({ requester: user, permissions: user?.permissions ?? [], groups: [], tagAliases: { historical: 'docs', docs: 'docs' } })
  const row = (id, extra = {}) => ({
    id, path: `docs/${id}`, localeCode: 'en', title: 'Tied title', description: '',
    visibility: 'public', ownerId: null, isPublished: true, isSearchable: true,
    publishStartDate: null, publishEndDate: '', contentType: 'markdown',
    creatorId: 7, authorId: 8, createdAt: '2026-01-01', updatedAt: '2026-01-02', ...extra
  })
  const ids = rows => rows.map(page => page.id)

  // Imported operations retain WIKI, so its database and transports share the suite lifetime.
  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      for (const field of ['path', 'localeCode', 'title', 'description', 'visibility', 'publishStartDate', 'publishEndDate', 'contentType', 'createdAt', 'updatedAt']) table.string(field)
      for (const field of ['ownerId', 'creatorId', 'authorId']) table.integer(field)
      table.boolean('isPublished'); table.boolean('isSearchable')
    })
    await db.schema.createTable('tags', table => { table.integer('id').primary(); table.string('tag') })
    await db.schema.createTable('pageTags', table => { table.integer('pageId'); table.integer('tagId') })
    class Tag extends objection.Model { static tableName = 'tags' }
    class Page extends objection.Model {
      static tableName = 'pages'
      static relationMappings = { tags: { relation: objection.Model.ManyToManyRelation, modelClass: Tag, join: { from: 'pages.id', through: { from: 'pageTags.pageId', to: 'pageTags.tagId' }, to: 'tags.id' } } }
    }
    Page.knex(db)
    const auth = {
      checkAccess: (user, permissions) => user?.permissions?.includes('manage:system') || permissions.some(permission => user?.permissions?.includes(permission)),
      checkPageAccess: (user, permissions, context, authority) => authority?.requester === user &&
        (user?.permissions?.includes('manage:system') || (permissions.some(permission => user?.permissions?.includes(permission)) &&
          context.path !== 'denied/read' && (!permissions.includes('write:pages') || (context.path !== 'denied/write' && !context.tags.some(tag => tag.tag === 'blocked'))))),
      loadPageRuleAuthority
    }
    global.WIKI = { Error: pageErrors, auth, config: { db: { type: 'sqlite' }, lang: { code: 'en' } }, data: { searchEngine: { config: { dictLanguage: 'english' } } }, models: { knex: db, pages: Page } }
    operations = (await import('../../operations/pages.ts')).default
    resolvers = (await import('../../graph/resolvers/page.ts')).default
    const { configureTransportRuntime } = await import('../../controllers/_types.ts')
    configureTransportRuntime(global.WIKI)
    const app = express()
    app.use((req, _res, next) => { req.user = requester; next() })
    app.use('/_api/pages', (await import('../../controllers/api/pages.ts')).default)
    app.use('/api/v1/pages', (await import('../../controllers/api-v1/pages.ts')).default)
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }))
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    requester = reader
    global.WIKI.auth.loadPageRuleAuthority = loadPageRuleAuthority
    await db('pageTags').delete()
    await db('tags').delete()
    await db('pages').delete()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } finally {
      try {
        if (db) await db.destroy()
      } finally {
        if (originalWiki === undefined) delete global.WIKI
        else global.WIKI = originalWiki
      }
    }
  })

  const seed = async () => {
    await db('pages').insert([
      row(1, { isPublished: false }), row(2), row(3, { publishStartDate: '2099-01-01' }),
      row(4, { publishStartDate: new Date(now).toISOString(), publishEndDate: new Date(now).toISOString() }),
      row(5, { publishEndDate: '2020-01-01' }), row(6, { publishStartDate: 'malformed' }),
      row(7, { publishEndDate: 'malformed' }), row(8), row(9, { isPublished: false })
    ])
  }

  it('uses visible offsets in both branches across hidden batches and inclusive bounds', async () => {
    await seed()
    for (const limit of [undefined, 1, 2, 10]) {
      for (const offset of [0, 1, 2, 3, 10]) {
        const input = { requester: reader, offset, ...(limit === undefined ? {} : { limit }) }
        expect(ids(await operations.list(input))).toEqual([2, 4, 8].slice(offset, limit === undefined ? undefined : offset + limit))
      }
    }
    await db('pages').whereIn('id', [2, 4, 8]).delete()
    expect(await operations.list({ requester: reader, limit: 2 })).toEqual([])
    expect(await operations.list({ requester: reader })).toEqual([])
  })

  it('retains private inventory and checks actual per-page tags/read and write denies', async () => {
    await db('pages').insert([
      row(1, { isPublished: false }), row(2, { path: 'denied/write', isPublished: false }),
      row(3, { isPublished: false }), row(4, { path: 'denied/read' }),
      row(5, { visibility: 'private', ownerId: 7, isPublished: false, publishStartDate: 'bad' }),
      row(6, { visibility: 'private', ownerId: 8, isPublished: false })
    ])
    await db('tags').insert({ id: 1, tag: 'blocked' })
    await db('pageTags').insert({ pageId: 3, tagId: 1 })
    for (const limit of [undefined, 20]) {
      expect(ids(await operations.list({ requester: reader, limit }))).toEqual([5])
      expect(ids(await operations.list({ requester: writer, limit }))).toEqual([1, 5])
      expect(ids(await operations.list({ requester: manager, limit }))).toEqual([1, 2, 3, 4, 5, 6])
      expect(await operations.list({ limit })).toEqual([])
      const authority = await global.WIKI.auth.loadPageRuleAuthority(writer)
      expect(ids(await operations.list({ requester: reader, authority, limit }))).toEqual([5])
    }
    const loadAuthority = global.WIKI.auth.loadPageRuleAuthority
    global.WIKI.auth.loadPageRuleAuthority = async () => loadAuthority(writer)
    expect(await operations.list({ requester: reader, limit: 20 })).toEqual([])
    expect(await operations.list({ requester: reader })).toEqual([])
  })

  it('preserves alias AND filters, locale, creator/author union and stable ordering ties', async () => {
    await seed()
    await db('pages').insert([row(10, { localeCode: 'fr' }), row(11, { creatorId: 9, authorId: 9 })])
    await db('tags').insert([{ id: 1, tag: 'docs' }, { id: 2, tag: 'second' }])
    await db('pageTags').insert([1, 2, 4, 8, 10, 11].flatMap(pageId => [{ pageId, tagId: 1 }, { pageId, tagId: 2 }]))
    for (const limit of [undefined, 10]) {
      expect(ids(await operations.list({ requester: reader, limit, locale: 'en', creatorId: 7, authorId: 8, tags: ['historical', 'second'], orderBy: 'TITLE', orderByDirection: 'DESC', offset: 1 }))).toEqual([4, 8])
    }
  })

  it('excludes hidden identities through real REST and GraphQL serialization', async () => {
    await seed()
    for (const suffix of ['', '?limit=2']) {
      const response = await fetch(`${baseUrl}/_api/pages${suffix}`)
      expect(response.status).toBe(200)
      expect(ids(await response.json())).toEqual(suffix ? [2, 4] : [2, 4, 8])
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
    const schema = buildSchema('type Page { id: Int! } type Pages { list(limit: Int, offset: Int): [Page!]! } type Query { pages: Pages! }')
    const result = await graphql({ schema, source: '{ pages { list(limit: 2, offset: 1) { id } } }', contextValue: { req: { user: reader } }, rootValue: { pages: { list: (args, context) => resolvers.PageQuery.list({}, args, context) } } })
    expect(result.errors).toBeUndefined()
    expect(ids(result.data.pages.list)).toEqual([4, 8])
  })

  it('does not let an unwritable hidden sentinel affect versioned nextOffset', async () => {
    // The global writer passes the outer versioned gate, but cannot write these paths.
    requester = writer
    await db('pages').insert([row(1, { path: 'denied/write', isPublished: false }), row(2), row(3), row(4, { path: 'denied/write', isPublished: false })])
    for (const [offset, expectedIds, nextOffset] of [[0, [2], 1], [1, [3], null], [2, [], null]]) {
      const response = await fetch(`${baseUrl}/api/v1/pages?limit=1&offset=${offset}`)
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(ids(payload.items)).toEqual(expectedIds)
      expect(payload.pagination).toEqual({ limit: 1, offset, nextOffset })
    }
  })
})
