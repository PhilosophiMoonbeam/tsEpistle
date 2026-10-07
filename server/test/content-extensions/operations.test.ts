import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { runDurableJobBatch } from '../../core/durable-jobs.ts'
import { claimPageMutationEffects, type PageRenderPublicationFence } from '../../core/page-mutation-outbox.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as createPageProtection } from '../../db/migrations/2.5.134.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { createContentExtensionRerenderHandler } from '../../jobs/content-extension-rerender.ts'
import markdownRenderer from '../../modules/rendering/markdown-core/renderer.ts'
import type * as RenderPageModule from '../../jobs/render-page.ts'

import { listContentExtensions, setContentExtensionEnabled } from '../../content-extensions/operations.ts'

const databaseInit = vi.fn()
vi.mockModule('../../core/db.ts', import.meta.url, () => ({ default: { init: databaseInit } }))

const qrBody = '{"key":"qr","version":1,"props":{"value":"cached","size":256,"errorCorrection":"M"}}\n'
const qrFence = `\`\`\`wiki-extension\n${qrBody}\`\`\`\n`
const baseConfig = {
  allowHTML: false,
  linebreaks: false,
  linkify: false,
  typographer: false,
  quotes: 'English',
  underline: false
}

describe('content extension operations', () => {
  let db: Knex
  let destroyDatabase: () => Promise<void>
  let renderWorker: typeof RenderPageModule.default
  let events: string[]
  let cachedHashes: Set<string>
  const cacheDelete = vi.fn()
  const renderPage = vi.fn()
  const savePageToCache = vi.fn()

  const renderQueuedPage = async () => {
    const claims = await claimPageMutationEffects(db, { leaseOwner: 'page-render-worker', effects: ['render'] })
    expect(claims).toHaveLength(1)
    const claim = claims[0]
    if (!claim || claim.payload.sourceSha256 === null) throw new Error('Admitted render intent is missing')
    await renderPage(claim.payload.pageId, {
      effectId: claim.id,
      leaseToken: claim.leaseToken,
      sourceRevision: claim.payload.sourceRevision,
      sourceSha256: claim.payload.sourceSha256
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    events = []
    cachedHashes = new Set(['qr-hash', 'plain-hash'])
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { max: 1, min: 1 },
      useNullAsDefault: true
    })
    destroyDatabase = db.destroy.bind(db)
    await createDurableJobs(db)
    await addDurableJobLeaseToken(db)
    await db.schema.createTable('contentExtensions', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.integer('version').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.integer('updatedBy').nullable()
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.bigInteger('sourceRevision').notNullable()
      table.bigInteger('renderedSourceRevision').nullable()
      table.string('hash').notNullable()
      table.text('content').notNullable()
      table.string('contentType').notNullable().defaultTo('markdown')
      table.text('render').notNullable()
      table.text('toc').notNullable().defaultTo('[]')
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.boolean('isPublished').notNullable()
      table.boolean('isSearchable').notNullable().defaultTo(true)
      table.dateTime('publishStartDate').nullable()
      table.dateTime('publishEndDate').nullable()
    })
    await createPageProtection(db)
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
    await db.schema.createTable('pageLinks', table => {
      table.increments('id').primary()
      table.integer('pageId').notNullable()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.unique(['pageId', 'localeCode', 'path'])
    })
    await db.schema.createTable('pagesVector', table => {
      table.integer('pageId').primary()
      table.bigInteger('sourceRevision').notNullable()
    })
    await db.schema.createTable('pagesWords', table => {
      table.integer('pageId').notNullable()
      table.string('word').notNullable()
      table.primary(['pageId', 'word'])
    })
    await db('contentExtensions').insert(
      ['qr', 'gallery', 'index', 'tabs', 'spoiler', 'infobox', 'pdf', 'media', 'youtube', 'diagram', 'kroki', 'plantuml', 'map'].map(key => ({
        key,
        isEnabled: key === 'qr',
        version: 1,
        updatedAt: new Date(),
        updatedBy: null
      }))
    )
    await db('pages').insert([
      {
        id: 1,
        sourceRevision: 7,
        renderedSourceRevision: 7,
        hash: 'qr-hash',
        content: qrFence,
        render: '',
        localeCode: 'en',
        path: 'docs/qr',
        visibility: 'public',
        ownerId: null,
        isPublished: true
      },
      {
        id: 2,
        sourceRevision: 3,
        renderedSourceRevision: 3,
        hash: 'plain-hash',
        content: '```js\nconst wikiExtension = true\n```',
        render: '<pre>plain</pre>',
        localeCode: 'en',
        path: 'docs/plain',
        visibility: 'public',
        ownerId: null,
        isPublished: true
      }
    ])

    cacheDelete.mockImplementation(async (hash: string) => {
      events.push(`cache:${hash}`)
      cachedHashes.delete(hash)
    })
    savePageToCache.mockImplementation(async (page: { hash: string }) => {
      cachedHashes.add(page.hash)
    })
    renderPage.mockImplementation(async (pageId: number, fence: PageRenderPublicationFence) => {
      events.push(`render:${pageId}`)
      await renderWorker({ pageId, ...fence })
    })
    const models = {
      knex: db,
      pages: {
        deletePageFromCache: cacheDelete,
        getPageFromDb: async (pageId: number) => (await db('pages').where({ id: pageId }).first()) ?? null,
        savePageToCache
      },
      renderers: {
        fetchDefinitions: async () => undefined,
        getRenderingPipeline: async () => [{ key: 'markdownCore', config: baseConfig, children: [] }]
      }
    }
    vi.stubGlobal('WIKI', {
      config: { db: { type: 'postgres' } },
      configSvc: { loadFromDb: async () => undefined, applyFlags: async () => undefined },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      events: { outbound: { emit: (_event: string, hash: string) => events.push(`event:${hash}`) } },
      models
    })
    databaseInit.mockResolvedValue(models)
    // Worker bootstrap reuses this isolated store, but only fixture teardown owns its lifetime.
    vi.spyOn(db, 'destroy').mockResolvedValue(undefined)
    renderWorker = (await vi.importFresh<typeof RenderPageModule>('../../jobs/render-page.ts', import.meta.url)).default
    const render = await markdownRenderer.render.call({ input: qrFence, config: baseConfig, children: [] })
    await db('pages').where({ id: 1 }).update({ render })
  })

  afterEach(async () => {
    try {
      await destroyDatabase()
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('persists a toggle and queues a durable rerender without blocking the request', async () => {
    const sourceBefore = await db('pages').where({ id: 1 }).first('content', 'render')
    const plainBefore = await db('pages').where({ id: 2 }).first()
    expect(sourceBefore.render).toContain('content-extension--qr')
    const enabled = load(sourceBefore.render)
    expect(enabled('svg[role="img"] path').length).toBeGreaterThan(0)
    expect(enabled('.content-extension-qr__value').text()).toBe('cached')
    const status = await setContentExtensionEnabled('qr', false, 42)

    expect(status).toMatchObject({ key: 'qr', isEnabled: false, compatible: true, diagnostic: null })
    expect(await db('contentExtensions').where({ key: 'qr' }).first('isEnabled', 'updatedBy')).toMatchObject({
      isEnabled: 0,
      updatedBy: 42
    })
    expect(await db('pages').where({ id: 1 }).first('render')).toMatchObject({ render: sourceBefore.render })
    expect(await db('durableJobs').where({ type: 'rerender-content-extension' }).first()).toMatchObject({
      state: 'pending',
      attempts: 0,
      payload: JSON.stringify({ key: 'qr' })
    })
    expect(renderPage).not.toHaveBeenCalled()
    expect(await db('pageMutationOutbox')).toEqual([])

    await runDurableJobBatch(db, {
      workerId: 'extension-worker',
      handlers: { 'rerender-content-extension@1': createContentExtensionRerenderHandler(global.WIKI) }
    })

    expect(await db('durableJobs').where({ type: 'rerender-content-extension' }).first('state', 'attempts')).toMatchObject({
      state: 'succeeded',
      attempts: 1
    })
    expect(await db('pages').where({ id: 1 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')).toEqual({
      content: sourceBefore.content,
      render: '',
      sourceRevision: 7,
      renderedSourceRevision: null
    })
    expect(await db('pages').where({ id: 2 }).first()).toEqual(plainBefore)
    const intents = await db('pageMutationOutbox').orderBy('effectKind')
    expect(intents.map(intent => intent.effectKind)).toEqual(['links', 'render', 'search'])
    for (const intent of intents) {
      expect(intent).toMatchObject({ pageId: 1, sourceRevision: 7, desiredState: 'present', status: 'pending', attempts: 0 })
      expect(JSON.parse(intent.payload)).toMatchObject({
        pageId: 1,
        sourceRevision: '7',
        sourceSha256: createHash('sha256').update(sourceBefore.content).digest('hex'),
        location: { locale: 'en', path: 'docs/qr', visibility: 'public', ownerId: null }
      })
    }
    expect(renderPage).not.toHaveBeenCalled()
    expect(cachedHashes.has('qr-hash')).toBe(false)
    expect(cachedHashes.has('plain-hash')).toBe(true)

    await renderQueuedPage()
    const rerendered = await db('pages').where({ id: 1 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')
    expect(rerendered.content).toBe(sourceBefore.content)
    expect(rerendered.sourceRevision).toBe(7)
    expect(rerendered.renderedSourceRevision).toBe(7)
    expect(load(rerendered.render)('pre > code.language-wiki-extension').text()).toBe(qrBody)
    expect(rerendered.render).not.toContain('content-extension--qr')
    expect(cachedHashes.has('qr-hash')).toBe(true)
    expect(await db('pages').where({ id: 2 }).first()).toEqual(plainBefore)
    expect(events.filter(event => event.startsWith('cache:'))).toEqual(['cache:qr-hash'])
    expect(events.filter(event => event.startsWith('event:'))).toEqual(['event:qr-hash'])
    expect(events.filter(event => event.startsWith('render:'))).toEqual(['render:1'])
    expect(events.indexOf('cache:qr-hash')).toBeLessThan(events.indexOf('render:1'))
    expect(events.indexOf('event:qr-hash')).toBeLessThan(events.indexOf('render:1'))
    expect(renderPage).toHaveBeenCalledTimes(1)
    expect(savePageToCache).toHaveBeenCalledTimes(1)
    expect(savePageToCache).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: 'qr-hash',
        content: sourceBefore.content,
        render: rerendered.render,
        renderedSourceRevision: 7
      })
    )
  })

  it('retries interrupted rerender admission without changing stored extension bytes or immutable projection intent', async () => {
    const sourceBefore = await db('pages').where({ id: 1 }).first('content', 'render')
    expect(sourceBefore.render).toContain('content-extension--qr')
    cacheDelete.mockRejectedValueOnce(new Error('worker interrupted'))
    await setContentExtensionEnabled('qr', false, 42)
    const handlers = { 'rerender-content-extension@1': createContentExtensionRerenderHandler(global.WIKI) }

    await runDurableJobBatch(db, {
      workerId: 'extension-worker-a',
      handlers,
      retryDelay: () => 0
    })
    expect(await db('durableJobs').where({ type: 'rerender-content-extension' }).first('state', 'attempts', 'lastError')).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastError: expect.stringContaining('worker interrupted')
    })
    expect(await db('pages').where({ id: 1 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')).toEqual({
      content: sourceBefore.content,
      render: '',
      sourceRevision: 7,
      renderedSourceRevision: null
    })
    expect(cachedHashes.has('qr-hash')).toBe(true)
    expect(renderPage).not.toHaveBeenCalled()
    const immutableIntent = await db('pageMutationOutbox')
      .select('id', 'pageId', 'sourceRevision', 'effectKind', 'effectKey', 'payload', 'payloadSha256')
      .orderBy('effectKind')
    expect(immutableIntent.map(intent => intent.effectKind)).toEqual(['links', 'render', 'search'])

    await runDurableJobBatch(db, {
      workerId: 'extension-worker-b',
      handlers,
      retryDelay: () => 0
    })
    expect(await db('durableJobs').where({ type: 'rerender-content-extension' }).first('state', 'attempts')).toMatchObject({
      state: 'succeeded',
      attempts: 2
    })
    expect(
      await db('pageMutationOutbox').select('id', 'pageId', 'sourceRevision', 'effectKind', 'effectKey', 'payload', 'payloadSha256').orderBy('effectKind')
    ).toEqual(immutableIntent)
    expect(cachedHashes.has('qr-hash')).toBe(false)
    expect(events.filter(event => event.startsWith('cache:'))).toEqual(['cache:qr-hash'])
    expect(events.filter(event => event.startsWith('event:'))).toEqual(['event:qr-hash'])
    await renderQueuedPage()
    const retried = await db('pages').where({ id: 1 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')
    expect(retried.content).toBe(sourceBefore.content)
    expect(retried.sourceRevision).toBe(7)
    expect(retried.renderedSourceRevision).toBe(7)
    expect(load(retried.render)('pre > code.language-wiki-extension').text()).toBe(qrBody)
    expect(retried.render).not.toContain('content-extension--qr')
    expect(renderPage).toHaveBeenCalledTimes(1)
    expect(savePageToCache).toHaveBeenCalledTimes(1)
  })

  it('reports persisted version mismatches as editor-usable incompatibility diagnostics', async () => {
    await db('contentExtensions').where({ key: 'qr' }).update({ version: 2 })

    const status = await listContentExtensions()
    expect(status.hostVersion).toBe(1)
    expect(status.extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'qr',
          isEnabled: true,
          compatible: false,
          diagnostic: expect.any(String)
        }),
        expect.objectContaining({ key: 'gallery', isEnabled: false, compatible: true, diagnostic: null }),
        expect.objectContaining({ key: 'index', isEnabled: false, compatible: true, diagnostic: null }),
        expect.objectContaining({ key: 'plantuml', isEnabled: false, compatible: true, diagnostic: null })
      ])
    )
  })
})
