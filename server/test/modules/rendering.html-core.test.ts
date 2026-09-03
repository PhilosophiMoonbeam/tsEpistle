import * as cheerio from 'cheerio'

import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import { buildTocFromHtml } from '../../jobs/render-page-toc.ts'

interface RendererModule {
  default: {
    render: (this: RendererContext) => Promise<string>
  }
}

interface RendererContext {
  children: []
  config: {
    absoluteLinks: boolean
    openExternalLinkNewTab: boolean
    relAttributeExternalLink: string
  }
  input: string
  page: {
    id: number
    localeCode: string
    path: string
    visibility: 'public'
    ownerId: null
  }
}

const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')

afterEach(() => {
  if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
  else Reflect.deleteProperty(globalThis, 'WIKI')
})

const rendererHarness = async () => {
  const pageQuery: Record<string, unknown> & PromiseLike<Array<{ localeCode: string; path: string }>> = {
    column: vi.fn(() => pageQuery),
    where: vi.fn((...args: unknown[]) => {
      if (typeof args[0] === 'function') Reflect.apply(args[0], undefined, [pageQuery])
      return pageQuery
    }),
    orWhere: vi.fn(() => pageQuery),
    then: (onFulfilled, onRejected) => Promise.resolve([{ localeCode: 'en', path: 'target' }]).then(onFulfilled, onRejected)
  }
  const pageLinksQuery = vi.fn(() => {
    throw new Error('Rendering must not persist page links')
  })
  Reflect.set(globalThis, 'WIKI', {
    config: {
      db: { type: 'postgres' },
      host: 'https://wiki.example.test',
      lang: { code: 'en', namespaces: [], namespacing: false }
    },
    data: { reservedPaths: [] },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    models: {
      pages: { query: () => pageQuery },
      pageLinks: { query: pageLinksQuery }
    }
  })
  const renderer = (await vi.importFresh<RendererModule>('../../modules/rendering/html-core/renderer.ts', import.meta.url)).default
  const page: RendererContext['page'] = { id: 42, localeCode: 'en', path: 'home', visibility: 'public', ownerId: null }
  const render = (input: string) =>
    renderer.render.call({
      children: [],
      config: { absoluteLinks: true, openExternalLinkNewTab: false, relAttributeExternalLink: '' },
      input,
      page
    })
  return { pageLinksQuery, render }
}

describe('HTML core page-link projection boundary', () => {
  it('renders duplicate internal anchors without mutating durable link state', async () => {
    const harness = await rendererHarness()
    const output = await harness.render('<a href="/target">first</a><a href="/target">second</a>')

    expect(output.match(/is-valid-page/g) ?? []).toHaveLength(2)
    expect(harness.pageLinksQuery).not.toHaveBeenCalled()
  })

  it('can render concurrently because link persistence is owned by the fenced outbox consumer', async () => {
    const harness = await rendererHarness()
    const outputs = await Promise.all([harness.render('<a href="/target">first render</a>'), harness.render('<a href="/target">second render</a>')])

    expect(outputs).toHaveLength(2)
    expect(harness.pageLinksQuery).not.toHaveBeenCalled()
  })
})

describe('HTML core authored ID namespace reservation', () => {
  it('rewrites a custom heading ID that matches the published-page shell title ID', async () => {
    const harness = await rendererHarness()
    const output = await harness.render('<h2 id="wiki-page-shell-42-title">Authored title</h2>')

    expect(output).toContain('id="content-wiki-page-shell-42-title"')
    expect(output).toContain('href="#content-wiki-page-shell-42-title"')
    expect(output).not.toContain('id="wiki-page-shell-42-title"')
    expect(output).not.toContain('href="#wiki-page-shell-42-title"')
  })

  it('rewrites reserved IDs on non-heading elements and preserves same-document link integrity', async () => {
    const harness = await rendererHarness()
    const output = await harness.render(
      '<section id="wiki-page-shell-42-tools">Authored tools</section><a href="#wiki-page-shell-42-tools">Jump to tools</a><div id="unrelated-target">Unrelated target</div><a href="#unrelated-target">Jump to unrelated target</a>'
    )
    const $ = cheerio.load(output)

    expect($('[id^="wiki-page-shell-"]')).toHaveLength(0)
    expect($('section').attr('id')).toBe('content-wiki-page-shell-42-tools')
    expect($('a').eq(0).attr('href')).toBe('#content-wiki-page-shell-42-tools')
    expect($('div').attr('id')).toBe('unrelated-target')
    expect($('a').eq(1).attr('href')).toBe('#unrelated-target')
  })

  it('keeps an encoded quote and event-attribute payload inert in a rewritten custom heading ID', async () => {
    const harness = await rendererHarness()
    const output = await harness.render('<h2 id="wiki-page-shell-42-title&#x22; onclick=&#x22;alert(1)">Attribute payload heading</h2>')
    const $ = cheerio.load(output)
    const headingId = 'content-wiki-page-shell-42-title" onclick="alert(1)'
    const anchor = $('h2 > a.toc-anchor')

    expect($('h2').attr('id')).toBe(headingId)
    expect(anchor).toHaveLength(1)
    expect(anchor.attr('href')).toBe(`#${headingId}`)
    expect($('.toc-anchor')).toHaveLength(1)
    expect(anchor.attr('onclick')).toBeUndefined()
    expect(anchor.text()).toBe('¶')
    expect($('h2').text()).toBe('¶ Attribute payload heading')
    expect($('[onclick], [onerror], img')).toHaveLength(0)
    expect($('[id^="wiki-page-shell-"]')).toHaveLength(0)
    expect(output).toContain('id="content-wiki-page-shell-42-title&quot; onclick=&quot;alert(1)"')
    expect(output).toContain('href="#content-wiki-page-shell-42-title&quot; onclick=&quot;alert(1)"')
    expect(buildTocFromHtml(output)).toEqual([{ title: 'Attribute payload heading', anchor: `#${headingId}`, children: [] }])
  })

  it('keeps encoded tag-like text inert and out of the published-page shell namespace', async () => {
    const harness = await rendererHarness()
    const output = await harness.render('<h2 id="tag-like&#x22;&#x3E;&#x3C;img id=wiki-page-shell-42-title src=x onerror=alert(1)&#x3E;">Tag-like heading</h2>')
    const $ = cheerio.load(output)
    const headingId = 'tag-like"><img id=wiki-page-shell-42-title src=x onerror=alert(1)>'
    const anchor = $('h2 > a.toc-anchor')

    expect($('h2').attr('id')).toBe(headingId)
    expect(anchor).toHaveLength(1)
    expect(anchor.attr('href')).toBe(`#${headingId}`)
    expect(anchor.text()).toBe('¶')
    expect($('.toc-anchor')).toHaveLength(1)
    expect($('h2').text()).toBe('¶ Tag-like heading')
    expect($('[onclick], [onerror], img')).toHaveLength(0)
    expect($('[id^="wiki-page-shell-"]')).toHaveLength(0)
    expect(output).toContain('id="tag-like&quot;><img id=wiki-page-shell-42-title src=x onerror=alert(1)>"')
    expect(output).toContain('href="#tag-like&quot;><img id=wiki-page-shell-42-title src=x onerror=alert(1)>"')
    expect(buildTocFromHtml(output)).toEqual([{ title: 'Tag-like heading', anchor: `#${headingId}`, children: [] }])
  })

  it('resolves a rewritten reserved ID collision with an authored content-prefixed ID deterministically', async () => {
    const harness = await rendererHarness()
    const output = await harness.render(
      '<h2 id="wiki-page-shell-collision">Reserved heading</h2><h2 id="content-wiki-page-shell-collision">Authored content heading</h2>'
    )
    const $ = cheerio.load(output)

    expect(
      $('h2')
        .map((_index, heading) => $(heading).attr('id'))
        .get()
    ).toEqual(['content-wiki-page-shell-collision', 'content-wiki-page-shell-collision-1'])
    expect(
      $('h2 > a.toc-anchor')
        .map((_index, anchor) => $(anchor).attr('href'))
        .get()
    ).toEqual(['#content-wiki-page-shell-collision', '#content-wiki-page-shell-collision-1'])
    expect($('h2 > a.toc-anchor')).toHaveLength(2)
    expect($('[id^="wiki-page-shell-"]')).toHaveLength(0)
    expect(buildTocFromHtml(output)).toEqual([
      { title: 'Reserved heading', anchor: '#content-wiki-page-shell-collision', children: [] },
      { title: 'Authored content heading', anchor: '#content-wiki-page-shell-collision-1', children: [] }
    ])
  })

  it('rewrites an automatic reserved heading slug while leaving unrelated slugs unchanged', async () => {
    const harness = await rendererHarness()
    const output = await harness.render('<h2>Wiki Page Shell Overview</h2><h2>Unrelated Heading</h2>')

    expect(output).toContain('id="content-wiki-page-shell-overview"')
    expect(output).toContain('href="#content-wiki-page-shell-overview"')
    expect(output).not.toContain('id="wiki-page-shell-overview"')
    expect(output).not.toContain('href="#wiki-page-shell-overview"')
    expect(output).toContain('id="unrelated-heading"')
    expect(output).toContain('href="#unrelated-heading"')
  })
})
