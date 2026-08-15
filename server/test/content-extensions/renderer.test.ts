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
    await db('contentExtensions').insert([
      { key: 'qr', isEnabled: true, version: 1 },
      { key: 'gallery', isEnabled: true, version: 1 },
      { key: 'index', isEnabled: true, version: 1 }
    ])
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

  it('renders a same-origin gallery with captions, accessible fallbacks, and natural image ratios', async () => {
    const markdown = serializeContentExtensionFence({
      key: 'gallery',
      version: 1,
      props: {
        images: [
          { src: '/uploads/launch.jpg', alt: 'Rocket launch', caption: 'First flight' },
          { src: '/_assets/svg/icon-image.svg', alt: 'Image placeholder' }
        ],
        columns: 4,
        fit: 'contain',
        aspectRatio: 'natural'
      }
    })

    const rendered = await renderMarkdown(markdown)

    expect(rendered).toContain('content-extension-gallery--columns-4')
    expect(rendered).toContain('content-extension-gallery--contain')
    expect(rendered).toContain('content-extension-gallery--natural')
    expect(rendered).toContain('href="/uploads/launch.jpg"')
    expect(rendered).toContain('src="/uploads/launch.jpg" alt="Rocket launch" loading="lazy" decoding="async"')
    expect(rendered).toContain('aria-label="View Rocket launch full size"')
    expect(rendered).toContain('<figcaption class="content-extension-gallery__caption">First flight</figcaption>')
    expect(rendered).not.toMatch(/<(?:script|dialog|iframe|style)\b/i)
    expect(rendered).not.toMatch(/\son\w+=|\sstyle=/i)
  })

  it('renders an inert page-index placeholder without leaking page titles into stored HTML', async () => {
    const markdown = serializeContentExtensionFence({
      key: 'index',
      version: 1,
      props: {
        path: 'guide',
        locale: 'en',
        depth: 2,
        columns: 3,
        showIcons: true,
        order: 'title',
        limit: 40,
        emptyLabel: 'Nothing readable here.'
      }
    })

    const rendered = await renderMarkdown(markdown)

    expect(rendered).toContain('content-extension--index content-extension-index--columns-3')
    expect(rendered).toContain('aria-busy="true"')
    expect(rendered).toContain('data-index-path="guide"')
    expect(rendered).toContain('data-index-depth="2"')
    expect(rendered).toContain('data-index-show-icons="true"')
    expect(rendered).toContain('data-index-order="title"')
    expect(rendered).toContain('data-index-empty-label="Nothing readable here."')
    expect(rendered).toContain('Loading page index…')
    expect(rendered).not.toContain('<a')
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
