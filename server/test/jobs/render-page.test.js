import { createHash } from 'node:crypto'
import createKnex from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { claimPageMutationEffects, enqueuePageMutationEffects } from '../../core/page-mutation-outbox.ts'

const { databaseInit } = vi.hoisted(() => ({ databaseInit: vi.fn() }))
vi.mockModule('../../core/db.ts', import.meta.url, () => ({ default: { init: databaseInit } }))
vi.mockModule('../../modules/rendering/html-core/renderer.ts', import.meta.url, () => ({
  default: {
    async render () {
      if (this.config.pause) {
        this.config.pause.entered.resolve()
        await this.config.pause.resume.promise
      }
      return this.config.output ?? this.input
    }
  }
}))

const deferred = () => {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const wiki = {
  config: { db: { type: 'postgres' } },
  configSvc: {
    applyFlags: vi.fn().mockResolvedValue(undefined),
    loadFromDb: vi.fn().mockResolvedValue(undefined)
  },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  models: {}
}
global.WIKI = wiki
const { default: renderPage } = await import('../../jobs/render-page.ts')

let db
let destroyDatabase
let models
let transactionActive

beforeEach(async () => {
  db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.bigInteger('sourceRevision').notNullable()
    table.bigInteger('renderedSourceRevision').nullable()
    table.text('content').notNullable()
    table.string('contentType').notNullable()
    table.text('render').notNullable().defaultTo('')
    table.text('toc').notNullable().defaultTo('[]')
    table.string('path').notNullable().defaultTo('docs/revisions')
    table.string('localeCode').notNullable().defaultTo('en')
    table.string('visibility').notNullable().defaultTo('public')
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable().defaultTo(true)
    table.boolean('isSearchable').notNullable().defaultTo(true)
    table.dateTime('publishStartDate').nullable()
    table.dateTime('publishEndDate').nullable()
    table.string('updatedAt').notNullable().defaultTo('before-render')
  })
  await db.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable().defaultTo('pending')
    table.integer('attempts').notNullable().defaultTo(0)
    table.string('leaseOwner').nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable()
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
  await db.schema.createTable('pageAccessPasswords', table => {
    table.integer('pageId').primary()
  })
  transactionActive = false
  db.on('query', query => {
    if (/^BEGIN\b/i.test(query.sql)) transactionActive = true
    if (/^(?:COMMIT|ROLLBACK)\b/i.test(query.sql)) transactionActive = false
  })
  // Both jobs use the same real in-memory store. A job closes its worker handle,
  // not this fixture's shared database; teardown retains the actual close method.
  destroyDatabase = db.destroy.bind(db)
  vi.spyOn(db, 'destroy').mockResolvedValue(undefined)
  models = {
    knex: db,
    pages: {
      getPageFromDb: vi.fn(async pageId => {
        if (transactionActive) throw new Error('Cannot hydrate uncommitted render bytes through the global database handle')
        return await db('pages').where({ id: pageId }).first() ?? null
      }),
      query: vi.fn(() => { throw new Error('Derived render writes must not invoke editorial model hooks') }),
      savePageToCache: vi.fn().mockResolvedValue(undefined)
    },
    renderers: {
      fetchDefinitions: vi.fn().mockResolvedValue(undefined),
      getRenderingPipeline: vi.fn().mockResolvedValue([{ key: 'htmlCore', config: {}, children: [] }])
    }
  }
  databaseInit.mockResolvedValue(models)
})

afterEach(async () => {
  vi.useRealTimers()
  await destroyDatabase()
})

describe('render-page revision fence', () => {
  it('does not let an older overlapping render overwrite the current database row or cache', async () => {
    await db('pages').insert({ id: 42, sourceRevision: 1, content: '<p>revision 1</p>', contentType: 'html' })
    const entered = deferred()
    const resume = deferred()
    models.renderers.getRenderingPipeline.mockResolvedValueOnce([
      { key: 'htmlCore', config: { pause: { entered, resume } }, children: [] }
    ])
    const staleRender = renderPage(42)
    await Promise.race([entered.promise, staleRender.then(() => { throw new Error('Older rendering pipeline did not start') })])
    try {
      await db('pages').where({ id: 42 }).update({ sourceRevision: 2, content: '<p>revision 2</p>' })
      await renderPage(42)
      expect(await db('pages').where({ id: 42 }).first('sourceRevision', 'render', 'updatedAt')).toEqual({
        sourceRevision: 2, render: '<p>revision 2</p>', updatedAt: 'before-render'
      })
      expect(models.pages.savePageToCache).toHaveBeenCalledOnce()
      expect(models.pages.savePageToCache).toHaveBeenCalledWith(expect.objectContaining({
        sourceRevision: 2, content: '<p>revision 2</p>', render: '<p>revision 2</p>', updatedAt: 'before-render'
      }))
    } finally {
      resume.resolve()
      await staleRender
    }
    expect(await db('pages').where({ id: 42 }).first('render', 'renderedSourceRevision')).toEqual({
      render: '<p>revision 2</p>', renderedSourceRevision: 2
    })
    expect(models.pages.savePageToCache).toHaveBeenCalledOnce()
  })

  it('updates derived rendering without changing editorial time or source', async () => {
    await db('pages').insert({
      id: 44, sourceRevision: 7, renderedSourceRevision: null, content: '<h1>Current source</h1>',
      contentType: 'markdown', render: '<p>Old render</p>', updatedAt: '2026-09-01T09:00:00.000Z'
    })
    await renderPage(44)
    expect(await db('pages').where({ id: 44 }).first()).toMatchObject({
      sourceRevision: 7, renderedSourceRevision: 7, content: '<h1>Current source</h1>',
      render: '<h1>Current source</h1>', updatedAt: '2026-09-01T09:00:00.000Z'
    })
    expect(models.pages.savePageToCache).toHaveBeenCalledWith(expect.objectContaining({
      renderedSourceRevision: 7, updatedAt: '2026-09-01T09:00:00.000Z'
    }))
    expect(models.pages.query).not.toHaveBeenCalled()
  })

  it('preserves stored output when no parser can transform the source', async () => {
    await db('pages').insert({
      id: 43, sourceRevision: 1, renderedSourceRevision: 1, content: '<script>unsafe()</script>',
      contentType: 'markdown', render: '<p>Existing output</p>', updatedAt: '2026-09-01T09:00:00.000Z'
    })
    const storedPage = await db('pages').where({ id: 43 }).first()
    models.renderers.getRenderingPipeline.mockResolvedValueOnce([])
    await expect(renderPage(43)).rejects.toThrow('No enabled rendering pipeline')
    expect(await db('pages').where({ id: 43 }).first()).toEqual(storedPage)
    expect(models.pages.query).not.toHaveBeenCalled()
    expect(models.pages.savePageToCache).not.toHaveBeenCalled()
    expect(db.destroy).toHaveBeenCalledOnce()
  })

  it('rejects an expired reclaimed same-revision renderer before it can overwrite certified body, TOC, or cache', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2100-01-01T00:00:00.000Z'))
    const source = '<p>Unchanged editorial source</p>'
    await db('pages').insert({ id: 42, sourceRevision: 8, renderedSourceRevision: null, content: source, contentType: 'html' })
    await enqueuePageMutationEffects(db, {
      pageId: 42, sourceRevision: 8, desiredState: 'present', action: 'update', source,
      location: { locale: 'en', path: 'docs/revisions', visibility: 'public', ownerId: null }, effects: ['render']
    })
    const [oldClaim] = await claimPageMutationEffects(db, { leaseOwner: 'old-render-worker', effects: ['render'], leaseMs: 1_000 })
    if (!oldClaim) throw new Error('Old render claim missing')
    const immutable = await db('pageMutationOutbox').where({ id: oldClaim.id }).first('id', 'payload', 'payloadSha256', 'effectKey')
    const entered = deferred()
    const resume = deferred()
    const oldOutput = '<h1><a class="toc-anchor" href="#old-heading"></a>oldtokenbody</h1>'
    const replacement = '<h1><a class="toc-anchor" href="#new-heading"></a>newtokenbody</h1>'
    models.renderers.getRenderingPipeline.mockResolvedValueOnce([
      { key: 'htmlCore', config: { pause: { entered, resume }, output: oldOutput }, children: [] }
    ])
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    const staleRender = renderPage({ pageId: 42, effectId: oldClaim.id, leaseToken: oldClaim.leaseToken, sourceRevision: '8', sourceSha256 })
    await Promise.race([entered.promise, staleRender.then(() => { throw new Error('Old-token rendering pipeline did not start') })])
    let newClaim
    const cacheSnapshots = []
    const cacheTransactionStates = []
    try {
      vi.setSystemTime(new Date('2100-01-01T00:00:01.001Z'))
      const reclaimed = await claimPageMutationEffects(db, { leaseOwner: 'new-render-worker', effects: ['render'], leaseMs: 60_000 })
      newClaim = reclaimed[0]
      if (!newClaim) throw new Error('Reclaimed render claim missing')
      expect(newClaim.id).toBe(oldClaim.id)
      expect(newClaim.leaseToken).not.toBe(oldClaim.leaseToken)
      expect(newClaim.attempts).toBe(2)
      models.renderers.getRenderingPipeline.mockResolvedValueOnce([
        { key: 'htmlCore', config: { output: replacement }, children: [] }
      ])
      models.pages.savePageToCache.mockImplementation(async cachedPage => {
        cacheSnapshots.push(structuredClone(cachedPage))
        cacheTransactionStates.push(transactionActive)
      })
      await renderPage({ pageId: 42, effectId: newClaim.id, leaseToken: newClaim.leaseToken, sourceRevision: '8', sourceSha256 })
      expect(await db('pages').where({ id: 42 }).first('render', 'renderedSourceRevision', 'sourceRevision', 'content', 'updatedAt')).toEqual({
        render: replacement, renderedSourceRevision: 8, sourceRevision: 8, content: source, updatedAt: 'before-render'
      })
      expect(JSON.parse((await db('pages').where({ id: 42 }).first('toc')).toc)).toEqual([
        { title: 'newtokenbody', anchor: '#new-heading', children: [] }
      ])
      expect(cacheSnapshots).toHaveLength(1)
      expect(cacheSnapshots[0]).toMatchObject({ render: replacement, renderedSourceRevision: 8, sourceRevision: 8, content: source })
      expect(JSON.parse(cacheSnapshots[0].toc)).toEqual([
        { title: 'newtokenbody', anchor: '#new-heading', children: [] }
      ])
      expect(cacheTransactionStates).toEqual([true])
    } finally {
      resume.resolve()
      await staleRender
    }
    expect(await db('pages').where({ id: 42 }).first('render', 'renderedSourceRevision', 'content', 'updatedAt')).toEqual({
      render: replacement, renderedSourceRevision: 8, content: source, updatedAt: 'before-render'
    })
    expect(JSON.parse((await db('pages').where({ id: 42 }).first('toc')).toc)).toEqual([
      { title: 'newtokenbody', anchor: '#new-heading', children: [] }
    ])
    expect(cacheSnapshots).toHaveLength(1)
    expect(models.pages.savePageToCache).toHaveBeenCalledOnce()
    expect(await db('pageMutationOutbox').where({ id: oldClaim.id }).first('id', 'payload', 'payloadSha256', 'effectKey')).toEqual(immutable)
    expect(await db('pageMutationOutbox').where({ id: oldClaim.id }).first('status', 'attempts', 'leaseToken')).toEqual({
      status: 'running', attempts: 2, leaseToken: newClaim.leaseToken
    })
  })
})
