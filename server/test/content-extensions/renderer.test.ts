import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
import markdownRenderer from '../../modules/rendering/markdown-core/renderer.ts'

const baseConfig = {
  allowHTML: false,
  linebreaks: false,
  linkify: false,
  typographer: false,
  quotes: 'English',
  underline: false
}

const renderMarkdown = (input: string) => markdownRenderer.render.call({
  input,
  config: baseConfig,
  children: []
})

describe('content extension Markdown rendering', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { max: 1, min: 1 },
      useNullAsDefault: true
    })
    await db.schema.createTable('contentExtensions', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.integer('version').notNullable()
    })
    await db('contentExtensions').insert({ key: 'qr', isEnabled: true, version: 1 })
    global.WIKI = { models: { knex: db } }
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('renders an enabled QR fence as deterministic accessible sanitized inline SVG', async () => {
    const markdown = serializeContentExtensionFence({
      key: 'qr',
      version: 1,
      props: {
        value: 'https://example.test/docs',
        label: 'Documentation QR',
        size: 256,
        errorCorrection: 'M'
      }
    })

    const first = await renderMarkdown(markdown)
    const second = await renderMarkdown(markdown)

    expect(second).toBe(first)
    expect(first).toContain('<figure class="content-extension content-extension--qr">')
    expect(first).toContain('<svg role="img" aria-label="Documentation QR"')
    expect(first).toContain('<title>')
    expect(first).toContain('href="https://example.test/docs"')
    expect(first).toMatch(/<path[^>]+d="M[^"]+"/)
    expect(first).not.toContain('data:')
    expect(first).not.toMatch(/<(?:script|foreignObject|image|style|use)\b/i)
    expect(first).not.toMatch(/\son\w+=|\sstyle=/i)
  })

  it('does not turn arbitrary encoded values into clickable links', async () => {
    const markdown = serializeContentExtensionFence({
      key: 'qr',
      version: 1,
      props: {
        value: 'javascript:alert(1)',
        size: 256,
        errorCorrection: 'M'
      }
    })

    const rendered = await renderMarkdown(markdown)

    expect(rendered).toContain('<span class="content-extension-qr__value">javascript:alert(1)</span>')
    expect(rendered).not.toContain('href="javascript:')
  })

  it('keeps disabled, incompatible, and invalid extension source visibly escaped', async () => {
    const valid = serializeContentExtensionFence({
      key: 'qr',
      version: 1,
      props: { value: '<unsafe>', size: 256, errorCorrection: 'M' }
    })
    await db('contentExtensions').where({ key: 'qr' }).update({ isEnabled: false })
    await expect(renderMarkdown(valid)).resolves.toContain('&lt;unsafe&gt;')

    await db('contentExtensions').where({ key: 'qr' }).update({ isEnabled: true, version: 2 })
    await expect(renderMarkdown(valid)).resolves.toContain('&lt;unsafe&gt;')

    const invalid = '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"ok","unknown":true}}\n```\n'
    await expect(renderMarkdown(invalid)).resolves.toContain('&quot;unknown&quot;')
  })

  it('leaves ordinary fenced code rendering unchanged', async () => {
    await expect(renderMarkdown('```js\nif (a < b) return "x"\n```')).resolves.toBe(
      '<pre><code class="language-js">if (a &lt; b) return &quot;x&quot;\n</code></pre>\n'
    )
  })
})
