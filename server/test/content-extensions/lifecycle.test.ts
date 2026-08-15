import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  parseContentExtensionEnvelope,
  parseContentExtensionFence,
  serializeContentExtensionFence
} from '../../../shared/content-extensions.ts'
import { up as createRegistry } from '../../db/migrations/2.5.135.ts'
import { up as installRichExtensions } from '../../db/migrations/2.5.137.ts'
import { up as installVisibleExtensions } from '../../db/migrations/2.5.138.ts'
import markdownRenderer from '../../modules/rendering/markdown-core/renderer.ts'

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
  { key: 'tabs', version: 1, props: { tabs: [{ label: 'A', content: 'Alpha' }, { label: 'B', content: 'Beta' }] } },
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

describe('content extension byte lifecycle', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('users', table => { table.integer('id').primary() })
    await createRegistry(db)
    await installRichExtensions(db)
    await installVisibleExtensions(db)
    await db('contentExtensions').update({ isEnabled: true })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('extensionKey').notNullable()
      table.text('content').notNullable()
    })
    global.WIKI = { models: { knex: db } }
  })

  afterEach(async () => { await db.destroy() })

  it.each(fixtures)('preserves $key bytes across migration, parse, render, edit, save, and reload', async input => {
    const envelope = parseContentExtensionEnvelope(input)
    const authored = serializeContentExtensionFence(envelope)
    const parsed = parseContentExtensionFence(authored.split('\n')[1] ?? '')
    const edited = serializeContentExtensionFence(parsed)
    expect(edited).toBe(authored)

    await db('pages').insert({ id: fixtures.indexOf(input) + 1, extensionKey: envelope.key, content: edited })
    const saved = await db('pages').where({ extensionKey: envelope.key }).first('content')
    expect(saved?.content).toBe(authored)

    const rendered = await renderMarkdown(saved?.content ?? '')
    expect(rendered).toContain(`content-extension--${envelope.key}`)
    expect(await db('pages').where({ extensionKey: envelope.key }).first('content')).toEqual({ content: authored })

    await db('contentExtensions').where({ key: envelope.key }).update({ isEnabled: false })
    const fallback = await renderMarkdown(authored)
    expect(fallback).toContain('&quot;key&quot;')
    expect(fallback).not.toContain(`content-extension--${envelope.key}`)
    expect(await db('pages').where({ extensionKey: envelope.key }).first('content')).toEqual({ content: authored })
  })
})
