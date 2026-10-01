import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

import { parseContentExtensionEnvelope, parseContentExtensionFence, serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
import { up as createRegistry } from '../../db/migrations/2.5.135.ts'
import { up as installRichExtensions } from '../../db/migrations/2.5.137.ts'
import { up as installVisibleExtensions } from '../../db/migrations/2.5.138.ts'
import markdownRenderer from '../../modules/rendering/markdown-core/renderer.ts'
import { rerenderPagesForContentExtension, type ContentExtensionRerenderContext } from '../../content-extensions/rerender.ts'
import type Page from '../../models/pages.ts'

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
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('extensionKey').notNullable()
      table.string('hash')
      table.text('content').notNullable()
      table.text('render').notNullable().defaultTo('')
      table.string('visibility').notNullable().defaultTo('public')
      table.boolean('isPublished').notNullable().defaultTo(true)
      table.boolean('isSearchable').notNullable().defaultTo(true)
    })
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

  it('refreshes extension-visible search terms on disable and enable without a page edit or rebuild', async () => {
    const authored = serializeContentExtensionFence({ key: 'index', version: 1, props: { path: 'guide', locale: 'en' } })
    await db('pages').insert({ id: 100, extensionKey: 'index', hash: 'extension-page', content: authored })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId').primary()
    })
    const runtime = { models: { knex: db, pages: undefined as unknown as typeof Page } }
    Reflect.set(globalThis, 'WIKI', runtime)
    // Page and protection operations capture WIKI at evaluation; load them after installing this database runtime.
    const PageModel = (await vi.importFresh<{ default: typeof Page }>('../../models/pages.ts', import.meta.url)).default
    PageModel.knex(db)
    runtime.models.pages = PageModel
    const indexedTerms = new Set<string>()
    const wiki: ContentExtensionRerenderContext = {
      data: {
        searchEngine: {
          async deleted() {
            indexedTerms.clear()
          },
          async updated(searchPage) {
            for (const term of searchPage.safeContent.split(/\s+/u)) indexedTerms.add(term)
          }
        }
      },
      events: { outbound: { emit() {} } },
      models: {
        pages: {
          async deletePageFromCache() {},
          async getPageFromDb(pageId) {
            const page = await PageModel.query().findById(pageId)
            if (page) page.safeContent = ''
            return page
          },
          async prepareSearchDocument(searchPage) {
            const page = await PageModel.query().findById(searchPage.id)
            if (!page) throw new Error('Search page disappeared')
            return PageModel.prepareSearchDocument(page)
          },
          async renderPage(page) {
            const stored = await db('pages').where({ id: page.id }).first('content')
            await db('pages').where({ id: page.id }).update({ render: await renderMarkdown(stored.content) })
          }
        }
      }
    }
    const signal = new AbortController().signal

    expect(await rerenderPagesForContentExtension(db, wiki, 'index', signal)).toBe(1)
    expect(indexedTerms.has('loading')).toBe(true)

    await db('contentExtensions').where({ key: 'index' }).update({ isEnabled: false })
    expect(await rerenderPagesForContentExtension(db, wiki, 'index', signal)).toBe(1)
    expect(indexedTerms.has('loading')).toBe(false)

    await db('contentExtensions').where({ key: 'index' }).update({ isEnabled: true })
    expect(await rerenderPagesForContentExtension(db, wiki, 'index', signal)).toBe(1)
    expect(indexedTerms.has('loading')).toBe(true)
    expect(await db('pages').where({ id: 100 }).first('content')).toEqual({ content: authored })

    wiki.models.pages.renderPage = async () => {
      throw new Error('render failed')
    }
    await expect(rerenderPagesForContentExtension(db, wiki, 'index', signal)).rejects.toThrow('render failed')
    expect(indexedTerms.has('loading')).toBe(false)
  })

  it('rerenders every renderer-compatible extension fence and rejects lookalikes', async () => {
    const envelope = JSON.stringify({ key: 'spoiler', version: 1, props: { content: 'Secret' } })
    const pages = [
      {
        id: 300,
        extensionKey: 'spoiler',
        hash: 'indented-extension',
        content: `   \`\`\` wiki-extension \n${envelope}\n   \`\`\``
      },
      {
        id: 301,
        extensionKey: 'spoiler',
        hash: 'long-extension-fence',
        content: `\`\`\`\`wiki-extension\n${envelope}\n\`\`\`\``
      },
      {
        id: 302,
        extensionKey: 'spoiler',
        hash: 'tilde-extension-fence',
        content: `~~~wiki-extension\n${envelope}\n~~~`
      },
      {
        id: 303,
        extensionKey: 'spoiler',
        hash: 'ordinary-code',
        content: `\`\`\`json\n${envelope}\n\`\`\``
      },
      {
        id: 304,
        extensionKey: 'spoiler',
        hash: 'invalid-extension-key',
        content: '```wiki-extension\n{"key":"spoiler!","version":1,"props":{}}\n```'
      },
      {
        id: 305,
        extensionKey: 'spoiler',
        hash: 'indented-code-block',
        content: `    \`\`\`wiki-extension\n${envelope}\n    \`\`\``
      },
      {
        id: 306,
        extensionKey: 'spoiler',
        hash: 'unclosed-extension-fence',
        content: `\`\`\`wiki-extension\n${envelope}\n`
      }
    ]
    await db('pages').insert(pages)

    const rendered: number[] = []
    const wiki: ContentExtensionRerenderContext = {
      data: {
        searchEngine: {
          async deleted() {},
          async updated() {}
        }
      },
      events: { outbound: { emit() {} } },
      models: {
        pages: {
          async deletePageFromCache() {},
          async getPageFromDb(pageId) {
            const page = pages.find(candidate => candidate.id === pageId)
            return page ? { ...page, visibility: 'private', isPublished: false, isSearchable: true, safeContent: '' } : undefined
          },
          async prepareSearchDocument(page) {
            return page
          },
          async renderPage(page) {
            rendered.push(page.id)
          }
        }
      }
    }

    expect(await rerenderPagesForContentExtension(db, wiki, 'spoiler', new AbortController().signal)).toBe(4)
    expect(rendered).toEqual([300, 301, 302, 306])
  })

  it('stops a multi-page rerender at the next side effect when its lease signal aborts', async () => {
    const authored = serializeContentExtensionFence({ key: 'spoiler', version: 1, props: { content: 'Secret' } })
    await db('pages').insert([
      { id: 200, extensionKey: 'spoiler', hash: 'first-page', content: authored },
      { id: 201, extensionKey: 'spoiler', hash: 'second-page', content: authored }
    ])

    const controller = new AbortController()
    const reason = new Error('rerender lease replaced')
    const effects: string[] = []
    const wiki: ContentExtensionRerenderContext = {
      data: {
        searchEngine: {
          async deleted(page) {
            effects.push(`deleted:${page.id}`)
          },
          async updated(page) {
            effects.push(`updated:${page.id}`)
          }
        }
      },
      events: {
        outbound: {
          emit(_event, hash) {
            effects.push(`emit:${String(hash)}`)
          }
        }
      },
      models: {
        pages: {
          async deletePageFromCache(hash) {
            effects.push(`cache:${hash}`)
          },
          async getPageFromDb(pageId) {
            effects.push(`fetch:${pageId}`)
            return {
              id: pageId,
              hash: pageId === 200 ? 'first-page' : 'second-page',
              content: authored,
              visibility: 'public',
              isPublished: true,
              isSearchable: true,
              safeContent: ''
            }
          },
          async prepareSearchDocument(page) {
            effects.push(`prepare:${page.id}`)
            return page
          },
          async renderPage(page) {
            effects.push(`render:${page.id}`)
            if (page.id === 200) controller.abort(reason)
          }
        }
      }
    }

    await expect(rerenderPagesForContentExtension(db, wiki, 'spoiler', controller.signal)).rejects.toBe(reason)
    expect(effects).toEqual(['cache:first-page', 'emit:first-page', 'fetch:200', 'deleted:200', 'render:200'])
  })
})
