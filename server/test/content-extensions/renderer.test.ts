import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { parseContentExtensionEnvelope, serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
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
      'qr', 'gallery', 'index', 'tabs', 'spoiler', 'infobox', 'pdf', 'media', 'youtube', 'diagram', 'kroki', 'plantuml', 'map'
    ].map(key => ({ key, isEnabled: true, version: 1 })))
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

    const document = new DOMParser().parseFromString(rendered, 'text/html')
    const secondImage = document.querySelector('img[src="/_assets/svg/icon-image.svg"]')
    expect(secondImage?.getAttribute('alt')).toBe('Image placeholder')
    expect(secondImage?.closest('a')?.getAttribute('href')).toBe('/_assets/svg/icon-image.svg')
    expect(secondImage?.closest('figure')?.querySelector('figcaption')).toBeNull()
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
    const document = new DOMParser().parseFromString(rendered, 'text/html')
    const index = document.querySelector('.content-extension--index')
    expect(index?.getAttribute('aria-busy')).toBe('true')
    expect(index?.getAttribute('aria-live')).toBe('polite')
    expect(index?.querySelector('p.content-extension-index__status')).not.toBeNull()
    expect(rendered).not.toContain('<a')
  })

  it('renders the remaining extensions as sanitized static, local, or consent-gated output', async () => {
    const render = async (input: unknown): Promise<string> => renderMarkdown(
      serializeContentExtensionFence(parseContentExtensionEnvelope(input))
    )
    const [tabs, spoiler, infobox, pdf, media, youtube, diagram, kroki, plantuml, map] = await Promise.all([
      render({ key: 'tabs', version: 1, props: { tabs: [{ label: 'A', content: '<b>Alpha</b>', headingLevel: 2 }, { label: 'B', content: 'Beta' }] } }),
      render({ key: 'spoiler', version: 1, props: { content: '<img src=x onerror=alert(1)>' } }),
      render({ key: 'infobox', version: 1, props: { title: 'City', facts: [{ label: 'Metro', value: true }] } }),
      render({ key: 'pdf', version: 1, props: { src: '/uploads/guide.pdf', title: 'Guide' } }),
      render({ key: 'media', version: 1, props: { kind: 'video', src: '/uploads/demo.mp4', poster: '/uploads/poster.jpg' } }),
      render({ key: 'youtube', version: 1, props: { videoId: 'abc123_DEF', title: 'Demo' } }),
      render({ key: 'diagram', version: 1, props: { source: 'flowchart LR\nA-->B', caption: 'Flow' } }),
      render({ key: 'kroki', version: 1, props: { type: 'graphviz', source: 'digraph{a->b}' } }),
      render({ key: 'plantuml', version: 1, props: { source: '@startuml\nA->B\n@enduml' } }),
      render({ key: 'map', version: 1, props: { latitude: 45.5, longitude: -73.5, label: 'Montreal' } })
    ])

    expect(tabs).toContain('content-extension--tabs')
    expect(tabs).toContain('&lt;b&gt;Alpha&lt;/b&gt;')
    expect(tabs).toContain('role="tab"')
    expect(tabs).toMatch(/<h2[^>]*class="content-extension-tabs__fallback-label"[^>]*>A<\/h2>/)
    const tabsDocument = new DOMParser().parseFromString(tabs, 'text/html')
    const secondPanel = tabsDocument.querySelector('[role="tabpanel"][data-tab-index="1"]')
    expect(secondPanel?.querySelector('p.content-extension-tabs__fallback-label')?.textContent).toBe('B')
    expect(secondPanel?.querySelector('.content-extension-tabs__content')?.textContent).toBe('Beta')
    expect(spoiler).toContain('data-spoiler=""')
    expect(spoiler).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(infobox).toContain('<aside class="content-extension content-extension--infobox"')
    const infoboxDocument = new DOMParser().parseFromString(infobox, 'text/html')
    const factLabel = infoboxDocument.querySelector('dl dt')
    expect(factLabel?.textContent).toBe('Metro')
    const factValue = factLabel?.nextElementSibling
    expect(factValue?.tagName).toBe('DD')
    expect(factValue?.textContent).toBe('Yes')
    expect(factValue?.querySelector('span')?.getAttribute('aria-label')).toBe('Yes')
    expect(pdf).toContain('data-pdf-src="/uploads/guide.pdf"')
    expect(pdf).toContain('href="/uploads/guide.pdf"')
    expect(media).toContain('src="/uploads/demo.mp4"')
    expect(media).toContain('poster="/uploads/poster.jpg"')
    const youtubeDocument = new DOMParser().parseFromString(youtube, 'text/html')
    const youtubeFigure = youtubeDocument.querySelector('figure.content-extension--youtube')
    expect(youtubeFigure?.getAttribute('data-youtube-id')).toBe('abc123_DEF')
    expect(youtubeFigure?.querySelector('.content-extension-remote__consent button.content-extension-remote__load')?.getAttribute('type')).toBe('button')
    expect(youtube).not.toContain('youtube-nocookie.com')
    expect(diagram).toContain('<code>flowchart LR\nA--&gt;B</code>')
    expect(kroki).toContain('data-kroki-type="graphviz"')
    expect(plantuml).toContain('data-plantuml-format="svg"')
    expect(map).toContain('data-map-latitude="45.5"')

    for (const rendered of [tabs, spoiler, infobox, pdf, media, youtube, diagram, kroki, plantuml, map]) {
      expect(rendered).not.toMatch(/<(?:script|iframe|object|style)\b/i)
      expect(rendered).not.toMatch(/<[^>]+\son\w+=|<[^>]+\sstyle=/i)
    }
  })

  it('keeps disabled, incompatible, and invalid extension source visibly escaped', async () => {
    const valid = serializeContentExtensionFence({
      key: 'qr',
      version: 1,
      props: { value: '<unsafe>', size: 256, errorCorrection: 'M' }
    })
    await db('contentExtensions').where({ key: 'qr' }).update({ isEnabled: false })
    const disabled = await renderMarkdown(valid)
    expect(disabled).toContain('&lt;unsafe&gt;')

    await db('contentExtensions').where({ key: 'qr' }).update({ isEnabled: true, version: 2 })
    const incompatible = await renderMarkdown(valid)
    expect(incompatible).toContain('&lt;unsafe&gt;')

    await db('contentExtensions').where({ key: 'qr' }).update({ isEnabled: true, version: 1 })
    const invalid = '```wiki-extension\n{"key":"qr","version":1,"props":{"value":"ok","size":256,"errorCorrection":"M","unknown":true}}\n```\n'
    const invalidRendered = await renderMarkdown(invalid)
    expect(invalidRendered).toContain('&quot;unknown&quot;')

    for (const [source, rendered] of [[valid, disabled], [valid, incompatible], [invalid, invalidRendered]] as const) {
      const document = new DOMParser().parseFromString(rendered, 'text/html')
      expect(document.querySelector('pre code')?.textContent).toBe(`${source.split('\n')[1]}\n`)
      expect(document.querySelector('figure.content-extension--qr, svg')).toBeNull()
    }
  })

  it('leaves ordinary fenced code rendering unchanged', async () => {
    const rendered = await renderMarkdown('```js\nif (a < b) return "x"\n```')
    const document = new DOMParser().parseFromString(rendered, 'text/html')
    const pre = document.querySelector('pre.prismjs.language-js')
    expect(pre?.querySelector('code.language-js')?.textContent).toBe('if (a < b) return "x"\n')
    expect(pre?.querySelector('code')?.children.length).toBe(0)
  })
})
