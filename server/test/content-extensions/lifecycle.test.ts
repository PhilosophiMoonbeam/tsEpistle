import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createKnex from 'knex'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

import { parseContentExtensionEnvelope, parseContentExtensionFence, serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
import { up as createRegistry } from '../../db/migrations/2.5.135.ts'
import { up as installRichExtensions } from '../../db/migrations/2.5.137.ts'
import { up as installVisibleExtensions } from '../../db/migrations/2.5.138.ts'
import markdownRenderer from '../../modules/rendering/markdown-core/renderer.ts'
import { rerenderPagesForContentExtension } from '../../content-extensions/rerender.ts'
import type { ContentExtensionRerenderContext } from '../../content-extensions/rerender.ts'
import { PageProjectionLifecycle } from '../../core/page-mutation-outbox.ts'
import type { PageRenderPublicationFence } from '../../core/page-mutation-outbox.ts'
import type Page from '../../models/pages.ts'
import type renderPageWorker from '../../jobs/render-page.ts'
import type postgresSearchEngine from '../../modules/search/postgres/engine.ts'

const databaseInit = vi.fn()
vi.mockModule('../../core/db.ts', import.meta.url, () => ({ default: { init: databaseInit } }))

const connection = getPostgresTestConnection('_extension_render_test', import.meta.path)
const nativeSuite = connection ? describe : describe.skip

const baseConfig = {
  allowHTML: false,
  linebreaks: false,
  linkify: false,
  typographer: false,
  quotes: 'English',
  underline: false
}
const fixtures: unknown[] = [
  { key: 'qr', version: 1, props: { value: 'https://example.test' } },
  { key: 'gallery', version: 1, props: { images: [{ src: '/uploads/a.jpg', alt: 'A' }] } },
  { key: 'index', version: 1, props: { path: 'guide', locale: 'en' } },
  {
    key: 'tabs',
    version: 1,
    props: {
      tabs: [
        { label: 'A', content: 'Alpha' },
        { label: 'B', content: 'Beta' }
      ]
    }
  },
  { key: 'spoiler', version: 1, props: { content: 'Secret' } },
  { key: 'infobox', version: 1, props: { title: 'City', facts: [{ label: 'Metro', value: true }] } },
  { key: 'pdf', version: 1, props: { src: '/uploads/guide.pdf' } },
  { key: 'media', version: 1, props: { kind: 'video', src: '/uploads/demo.mp4' } },
  { key: 'youtube', version: 1, props: { videoId: 'abc123_DEF' } },
  { key: 'diagram', version: 1, props: { source: 'flowchart LR\nA-->B' } },
  { key: 'kroki', version: 1, props: { type: 'graphviz', source: 'digraph{a->b}' } },
  { key: 'plantuml', version: 1, props: { source: '@startuml\nA->B\n@enduml' } },
  { key: 'map', version: 1, props: { latitude: 45.5, longitude: -73.5 } }
]

const renderMarkdown = (input: string) => markdownRenderer.render.call({ input, config: baseConfig, children: [] })

describe('content extension rendering and rerender lifecycle', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await createRegistry(db)
    await installRichExtensions(db)
    await installVisibleExtensions(db)
    await db('contentExtensions').update({ isEnabled: true })
    global.WIKI = { models: { knex: db } }
  })

  afterEach(async () => {
    await db.destroy()
  })

  it.each(fixtures)('roundtrips canonical $key bytes and renders enabled or escaped disabled output', async input => {
    const envelope = parseContentExtensionEnvelope(input)
    const authored = serializeContentExtensionFence(envelope)
    const parsed = parseContentExtensionFence(authored.split('\n')[1] ?? '')
    const edited = serializeContentExtensionFence(parsed)
    expect(edited).toBe(authored)

    const rendered = await renderMarkdown(authored)
    expect(rendered).toContain(`content-extension--${envelope.key}`)

    await db('contentExtensions').where({ key: envelope.key }).update({ isEnabled: false })
    const fallback = await renderMarkdown(authored)
    expect(fallback).toContain('&quot;key&quot;')
    expect(fallback).not.toContain(`content-extension--${envelope.key}`)
  })
})

type NativeSearchEngine = typeof postgresSearchEngine & ThisParameterType<typeof postgresSearchEngine.init>

nativeSuite('PostgreSQL content extension durable render lifecycle', () => {
  let db: Knex
  let destroyDatabase: () => Promise<void>
  let destroySpy: { mockRestore(): void }
  let originalWiki: unknown
  let cacheDirectory: string
  let wiki: ContentExtensionRerenderContext
  let engine: NativeSearchEngine
  let lifecycle: PageProjectionLifecycle

  const settleProjections = async (pageIds: readonly number[], signal: AbortSignal): Promise<void> => {
    for (let tick = 0; tick < 10; tick += 1) {
      await lifecycle.runOnce(signal)
      const receipts = await db('pageMutationOutbox').whereIn('pageId', pageIds).orderBy('pageId').orderBy('effectKind')
      if (receipts.length >= pageIds.length && receipts.every(receipt => receipt.status === 'succeeded')) return
    }
    const receipts = await db('pageMutationOutbox').whereIn('pageId', pageIds).orderBy('pageId').orderBy('effectKind')
    expect(receipts.length).toBeGreaterThanOrEqual(pageIds.length)
    expect(
      receipts.map(receipt => ({
        pageId: receipt.pageId,
        effectKind: receipt.effectKind,
        status: receipt.status,
        result: receipt.result,
        postcondition: receipt.postcondition
      }))
    ).toMatchObject(receipts.map(() => ({ status: 'succeeded' })))
  }

  beforeAll(async () => {
    db = createKnex({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      CREATE TABLE users (
        id integer PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL
      );
      CREATE TABLE pages (
        id integer PRIMARY KEY,
        "sourceRevision" bigint NOT NULL,
        "renderedSourceRevision" bigint,
        path text NOT NULL,
        hash text NOT NULL,
        "localeCode" varchar(35) NOT NULL,
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        content text NOT NULL,
        render text NOT NULL DEFAULT '',
        toc text NOT NULL DEFAULT '[]',
        "contentType" text NOT NULL DEFAULT 'markdown',
        "createdAt" varchar(255) NOT NULL DEFAULT '2026-09-01T09:00:00.000Z',
        "updatedAt" varchar(255) NOT NULL DEFAULT '2026-09-01T09:00:00.000Z',
        "editorKey" text NOT NULL DEFAULT 'markdown',
        "authorId" integer NOT NULL DEFAULT 1,
        "creatorId" integer NOT NULL DEFAULT 1,
        "ownerId" integer,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        visibility text NOT NULL DEFAULT 'public',
        "isPublished" boolean NOT NULL DEFAULT true,
        "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" varchar(255) NOT NULL DEFAULT '',
        "publishEndDate" varchar(255) NOT NULL DEFAULT ''
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY,
        tag text NOT NULL UNIQUE,
        title text NOT NULL
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY ("pageId", "tagId")
      );
      CREATE TABLE "pageLinks" (
        id serial PRIMARY KEY,
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "localeCode" varchar(35) NOT NULL,
        path text NOT NULL,
        UNIQUE ("pageId", "localeCode", path)
      );
      CREATE TABLE "pageAccessPasswords" (
        "pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
      );
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY,
        "pageId" integer NOT NULL,
        "sourceRevision" bigint NOT NULL,
        "effectKind" text NOT NULL,
        "effectKey" text NOT NULL,
        "desiredState" text NOT NULL,
        "payloadSha256" text NOT NULL,
        payload text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        "leaseOwner" text,
        "leaseToken" uuid,
        "leaseExpiresAt" timestamptz,
        "availableAt" timestamptz NOT NULL,
        result text,
        postcondition text,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
    `)
    await db('users').insert({ id: 1, name: 'Extension author', email: 'extension@example.test' })
    await createRegistry(db)
    await installRichExtensions(db)
    await installVisibleExtensions(db)
    await db('contentExtensions').where({ key: 'index' }).update({ isEnabled: true })

    cacheDirectory = await mkdtemp(join(tmpdir(), 'tsepistle-extension-render-'))
    originalWiki = Reflect.get(globalThis, 'WIKI')
    let renderWorker: typeof renderPageWorker
    const runtime = {
      ROOTPATH: cacheDirectory,
      config: { db: { type: 'postgres' }, dataPath: '.', search: { maxHits: 100 }, lang: { code: 'en' } },
      configSvc: {
        async loadFromDb() {},
        async applyFlags() {}
      },
      data: { searchEngine: undefined as unknown as NativeSearchEngine },
      events: { outbound: { emit() {} } },
      logger: { info() {}, warn() {}, error() {} },
      scheduler: {
        async registerJob(_definition: unknown, data: { pageId: number } & PageRenderPublicationFence) {
          return { finished: renderWorker(data) }
        }
      },
      models: {
        knex: db,
        pages: undefined as unknown as typeof Page,
        renderers: {
          async fetchDefinitions() {},
          async getRenderingPipeline() {
            return [{ key: 'markdownCore', config: baseConfig, children: [] }]
          }
        }
      }
    }
    Reflect.set(globalThis, 'WIKI', runtime)
    // Keep the real Page.renderPage second-argument guard and real worker publication
    // transaction. Only worker bootstrap/process transport reuse this fixture's handle.
    const PageModel = (await vi.importFresh<{ default: typeof Page }>('../../models/pages.ts', import.meta.url)).default
    PageModel.knex(db)
    runtime.models.pages = PageModel
    databaseInit.mockResolvedValue(runtime.models)
    destroyDatabase = db.destroy.bind(db)
    destroySpy = vi.spyOn(db, 'destroy').mockResolvedValue(undefined)
    renderWorker = (await vi.importFresh<{ default: typeof renderWorker }>('../../jobs/render-page.ts', import.meta.url)).default
    const engineModule = await vi.importFresh<{ default: NativeSearchEngine }>('../../modules/search/postgres/engine.ts', import.meta.url)
    engine = Object.assign(engineModule.default, { config: { dictLanguage: 'english' }, client: undefined })
    runtime.data.searchEngine = engine
    await engine.init()
    wiki = runtime as unknown as ContentExtensionRerenderContext
    lifecycle = new PageProjectionLifecycle(db, 'extension-render-worker', {
      async renderPage(pageId, fence) {
        await PageModel.renderPage({ id: pageId }, fence)
      },
      async evictLocation() {},
      reconcileSearchPage: pageId => engine.reconcilePage(pageId),
      removeSearchPage: pageId => engine.removePage(pageId)
    })
  })

  beforeEach(async () => {
    await db('pageMutationOutbox').delete()
    await db('pageLinks').delete()
    await db('pagesWords').delete()
    await db('pagesVector').delete()
    await db('pages').delete()
    await db('contentExtensions').update({ isEnabled: true })
  })

  afterAll(async () => {
    Reflect.set(globalThis, 'WIKI', originalWiki)
    destroySpy?.mockRestore()
    if (destroyDatabase) await destroyDatabase()
    else await db?.destroy()
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true })
  })

  it('admits and retains current-source receipts across repeated disable/enable, then publishes fenced render and native search', async () => {
    const authored = serializeContentExtensionFence({ key: 'index', version: 1, props: { path: 'guide', locale: 'en' } })
    const pages = [
      { id: 100, sourceRevision: '7', path: 'extensions/index-one', hash: 'extension-index-one' },
      { id: 102, sourceRevision: '11', path: 'extensions/index-two', hash: 'extension-index-two' }
    ]
    await db('pages').insert(pages.map(page => ({ ...page, localeCode: 'en', title: 'Extension lifecycle', content: authored })))
    const sourceRows = await db('pages').select('id', 'sourceRevision', 'content', 'updatedAt').orderBy('id')
    const signal = new AbortController().signal
    // Let normal maintenance establish real healthy projections before testing
    // extension re-admission independently of initial page recovery.
    await settleProjections(
      pages.map(page => page.id),
      signal
    )
    const immutableReceipts = () =>
      db('pageMutationOutbox')
        .select('id', 'pageId', 'sourceRevision', 'effectKind', 'effectKey', 'desiredState', 'payload', 'payloadSha256')
        .orderBy('pageId')
        .orderBy('effectKind')

    expect(await rerenderPagesForContentExtension(db, wiki, 'index', signal)).toBe(2)
    const admitted = await immutableReceipts()
    expect(admitted).toHaveLength(6)
    for (const page of pages) {
      const receipts = admitted.filter(receipt => receipt.pageId === page.id)
      expect(receipts.map(receipt => receipt.effectKind)).toEqual(['links', 'render', 'search'])
      for (const receipt of receipts) {
        expect(receipt).toMatchObject({ sourceRevision: page.sourceRevision, desiredState: 'present' })
        expect(JSON.parse(receipt.payload)).toMatchObject({
          pageId: page.id,
          sourceRevision: page.sourceRevision,
          effectKind: receipt.effectKind,
          sourceSha256: createHash('sha256').update(authored).digest('hex'),
          location: { locale: 'en', path: page.path, visibility: 'public', ownerId: null }
        })
        expect(receipt.payloadSha256).toBe(createHash('sha256').update(receipt.payload).digest('hex'))
      }
    }

    for (const enabled of [true, false, true]) {
      await db('contentExtensions').where({ key: 'index' }).update({ isEnabled: enabled })
      expect(await rerenderPagesForContentExtension(db, wiki, 'index', signal)).toBe(2)
      const pending = await db('pageMutationOutbox').orderBy('pageId').orderBy('effectKind')
      expect(pending).toHaveLength(6)
      expect(pending.every(receipt => ['pending', 'retry'].includes(receipt.status) && receipt.attempts === 0 && receipt.leaseToken === null)).toBe(true)
      expect(await db('pages').select('render', 'renderedSourceRevision').orderBy('id')).toEqual([
        { render: '', renderedSourceRevision: null },
        { render: '', renderedSourceRevision: null }
      ])
      expect(await db('pagesVector')).toEqual([])
      expect(await db('pagesWords')).toEqual([])
      expect(await immutableReceipts()).toEqual(admitted)

      // Duplicate delivery before a claim coalesces without rewriting any receipt.
      expect(await rerenderPagesForContentExtension(db, wiki, 'index', signal)).toBe(2)
      expect(await db('pageMutationOutbox').orderBy('pageId').orderBy('effectKind')).toEqual(pending)

      await settleProjections(
        pages.map(page => page.id),
        signal
      )
      const settled = await db('pageMutationOutbox').orderBy('pageId').orderBy('effectKind')
      for (const receipt of settled) {
        expect({
          pageId: receipt.pageId,
          effectKind: receipt.effectKind,
          status: receipt.status,
          attempts: receipt.attempts,
          leaseToken: receipt.leaseToken,
          result: receipt.result,
          postcondition: receipt.postcondition
        }).toMatchObject({ status: 'succeeded', attempts: 1, leaseToken: null })
        expect(JSON.parse(receipt.postcondition)).toMatchObject({ satisfied: true, observedSourceRevision: receipt.sourceRevision })
      }
      const rendered = await db('pages').select('id', 'sourceRevision', 'renderedSourceRevision', 'render').orderBy('id')
      for (const page of rendered) {
        expect(page.renderedSourceRevision).toBe(page.sourceRevision)
        if (enabled) expect(page.render).toContain('content-extension--index')
        else {
          expect(page.render).not.toContain('content-extension--index')
          expect(page.render).toContain('&quot;key&quot;')
        }
      }
      const search = await engine.query('loading', { limit: 10 })
      expect(search.results.map(page => page.id).sort((left, right) => left - right)).toEqual(enabled ? [100, 102] : [])
      expect(await db('pagesVector').select('pageId', 'sourceRevision').orderBy('pageId')).toEqual([
        { pageId: 100, sourceRevision: '7' },
        { pageId: 102, sourceRevision: '11' }
      ])
      expect(await immutableReceipts()).toEqual(admitted)
      expect(await db('pages').select('id', 'sourceRevision', 'content', 'updatedAt').orderBy('id')).toEqual(sourceRows)
    }
  })

  it('admits renderer-compatible fences but not ordinary code or extension lookalikes', async () => {
    const envelope = JSON.stringify({ key: 'spoiler', version: 1, props: { content: 'Secret' } })
    const contents = [
      `   \`\`\` wiki-extension \n${envelope}\n   \`\`\``,
      `\`\`\`\`wiki-extension\n${envelope}\n\`\`\`\``,
      `~~~wiki-extension\n${envelope}\n~~~`,
      `\`\`\`json\n${envelope}\n\`\`\``,
      '```wiki-extension\n{"key":"spoiler!","version":1,"props":{}}\n```',
      `    \`\`\`wiki-extension\n${envelope}\n    \`\`\``,
      `\`\`\`wiki-extension\n${envelope}\n`
    ]
    await db('pages').insert(
      contents.map((content, index) => ({
        id: 300 + index,
        sourceRevision: '1',
        path: `extensions/parser-${index}`,
        hash: `parser-${index}`,
        localeCode: 'en',
        title: 'Fence parser',
        content
      }))
    )
    const signal = new AbortController().signal
    await settleProjections(
      contents.map((_content, index) => 300 + index),
      signal
    )
    const untouched = await db('pages').select('id', 'render', 'renderedSourceRevision').whereIn('id', [303, 304, 305]).orderBy('id')
    await rerenderPagesForContentExtension(db, wiki, 'spoiler', signal)
    expect((await db('pageMutationOutbox').where({ effectKind: 'render' }).whereNot('status', 'succeeded').orderBy('pageId')).map(row => row.pageId)).toEqual([
      300, 301, 302, 306
    ])
    await settleProjections([300, 301, 302, 306], signal)
    const rendered = await db('pages').select('id', 'render', 'renderedSourceRevision').orderBy('id')
    expect(
      rendered.filter(page => [300, 301, 302, 306].includes(page.id)).map(page => ({ id: page.id, renderedSourceRevision: page.renderedSourceRevision }))
    ).toEqual([300, 301, 302, 306].map(id => ({ id, renderedSourceRevision: '1' })))
    expect(rendered.filter(page => [303, 304, 305].includes(page.id))).toEqual(untouched)
  })

  it('commits only admitted work before abort and never exposes private extension output to native search', async () => {
    const authored = serializeContentExtensionFence({ key: 'spoiler', version: 1, props: { content: 'privatelifecyclecanary' } })
    await db('pages').insert(
      [200, 201].map(id => ({
        id,
        sourceRevision: '3',
        path: `extensions/private-${id}`,
        hash: `private-${id}`,
        localeCode: 'en',
        title: 'Private extension',
        visibility: 'private',
        ownerId: 1,
        content: authored
      }))
    )
    const original = await db('pages').select('id', 'content', 'sourceRevision', 'updatedAt').orderBy('id')
    const controller = new AbortController()
    const reason = new Error('rerender lease replaced')
    const abortingWiki: ContentExtensionRerenderContext = {
      ...wiki,
      models: {
        pages: {
          async deletePageFromCache(hash) {
            await wiki.models.pages.deletePageFromCache(hash)
            controller.abort(reason)
          }
        }
      }
    }
    await expect(rerenderPagesForContentExtension(db, abortingWiki, 'spoiler', controller.signal)).rejects.toBe(reason)
    expect((await db('pageMutationOutbox').where({ effectKind: 'render' })).map(row => row.pageId)).toEqual([200])
    expect(await db('pages').where({ id: 201 }).first('renderedSourceRevision')).toEqual({ renderedSourceRevision: null })
    const signal = new AbortController().signal
    await rerenderPagesForContentExtension(db, wiki, 'spoiler', signal)
    await settleProjections([200, 201], signal)
    const rendered = await db('pages').select('render', 'renderedSourceRevision').orderBy('id')
    expect(rendered.every(page => page.renderedSourceRevision === '3' && page.render.includes('privatelifecyclecanary'))).toBe(true)
    expect((await engine.query('privatelifecyclecanary', { limit: 10 })).results).toEqual([])
    expect(await db('pagesVector')).toEqual([])
    expect(await db('pagesWords')).toEqual([])
    expect(await db('pages').select('id', 'content', 'sourceRevision', 'updatedAt').orderBy('id')).toEqual(original)
  })
})
