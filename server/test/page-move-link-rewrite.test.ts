import { describe, expect, it } from './bun-test.mts'
import { rewriteMovedPageLinks, type PageMoveLinkRewriteInput } from '../helpers/page-move-link-rewrite.ts'

const input = (overrides: Partial<PageMoveLinkRewriteInput> = {}): PageMoveLinkRewriteInput => ({
  source: '',
  editor: 'markdown',
  oldTarget: { locale: 'en', path: 'old' },
  newTarget: { locale: 'en', path: 'new' },
  sourcePage: { locale: 'en', path: 'guide' },
  defaultLocale: 'en',
  namespaced: true,
  absoluteLinks: false,
  markdownAllowHTML: true,
  wikiLinksEnabled: false,
  ...overrides
})

describe('page move source-link rewrite', () => {
  it('rewrites an active inline link destination while preserving titles, suffixes, Unicode, and surrounding source', () => {
    const source = '🧭 [Old](</en/old?view=full&mode=raw#Part> "Title") — keep `[/en/old](/en/old)` literal.'
    const route = '/en/%E6%96%B0%E3%81%97%E3%81%84%E3%83%9A%E3%83%BC%E3%82%B8?view=full&mode=raw#Part'
    const result = rewriteMovedPageLinks(input({
      source,
      newTarget: { locale: 'en', path: '新しいページ' }
    }))

    expect(result.source).toBe('🧭 [Old](<' + route + '> "Title") — keep `[/en/old](/en/old)` literal.')
    expect(result.changes).toEqual([{ before: '/en/old?view=full&mode=raw#Part', after: route }])
    expect(result.unsupported).toBe(0)
  })

  it('rewrites the active anchor rather than a preceding image with the same destination', () => {
    const source = '![badge](/old) [open](/old)'
    const result = rewriteMovedPageLinks(input({ source }))

    expect(result.source).toBe('![badge](/old) [open](/en/new)')
    expect(result.changes).toEqual([{ before: '/old', after: '/en/new' }])
  })

  it('binds duplicate destinations to active nested links and leaves literal code and images untouched', () => {
    const source = '`[literal](/old)` ![badge](/old) [open](/old) [nested ![icon](/old)](/old) [last](/old)'
    const result = rewriteMovedPageLinks(input({ source }))

    expect(result.source).toBe('`[literal](/old)` ![badge](/old) [open](/en/new) [nested ![icon](/old)](/en/new) [last](/en/new)')
    expect(result.changes).toEqual([
      { before: '/old', after: '/en/new' },
      { before: '/old', after: '/en/new' },
      { before: '/old', after: '/en/new' }
    ])
  })

  it('classifies dotted query and fragment suffixes by the destination path only', () => {
    const source = '[version](/en/old?version=1.2) [section](/en/old#section.1)'
    const result = rewriteMovedPageLinks(input({ source }))

    expect(result.source).toBe('[version](/en/new?version=1.2) [section](/en/new#section.1)')
    expect(result.changes).toEqual([
      { before: '/en/old?version=1.2', after: '/en/new?version=1.2' },
      { before: '/en/old#section.1', after: '/en/new#section.1' }
    ])
    expect(result.unsupported).toBe(0)
  })

  it('uses page-relative resolution when absolute links are disabled and emits a canonical root route', () => {
    const result = rewriteMovedPageLinks(input({
      source: '[Old](old)',
      oldTarget: { locale: 'en', path: 'docs/old' },
      newTarget: { locale: 'en', path: 'docs/new' },
      sourcePage: { locale: 'en', path: 'docs' },
      namespaced: false
    }))

    expect(result.source).toBe('[Old](/docs/new)')
    expect(result.changes).toEqual([{ before: 'old', after: '/docs/new' }])
  })

  it('uses root-relative resolution when absoluteLinks is enabled', () => {
    const result = rewriteMovedPageLinks(input({
      source: '[Old](old)',
      newTarget: { locale: 'en', path: 'new' },
      sourcePage: { locale: 'en', path: 'docs/reference' },
      namespaced: false,
      absoluteLinks: true
    }))

    expect(result.source).toBe('[Old](/new)')
  })

  it('keeps non-default locale identity in rooted Markdown, HTML, and wikilink repairs', () => {
    const route = {
      oldTarget: { locale: 'fr', path: 'old' },
      newTarget: { locale: 'fr', path: 'new' },
      sourcePage: { locale: 'fr', path: 'guide' },
      namespaced: false
    }
    const markdown = rewriteMovedPageLinks(input({ ...route, source: '[Old](/fr/old)' }))
    expect(markdown.source).toBe('[Old](/fr/new)')

    const html = rewriteMovedPageLinks(input({ ...route, editor: 'ckeditor', source: '<a href="/fr/old">Old</a>' }))
    expect(html.source).toBe('<a href="/fr/new">Old</a>')

    const wiki = rewriteMovedPageLinks(input({
      ...route,
      source: '[[/fr/old|Old]]',
      wikiLinksEnabled: true
    }))
    expect(wiki.source).toBe('[Old](</fr/new>)')
  })

  it('matches rendered Markdown links inside HTML-looking blocks when HTML is disabled', () => {
    const source = '<div>\n[old](/en/old)\n</div>'
    expect(rewriteMovedPageLinks(input({ source, markdownAllowHTML: false })).source)
      .toBe('<div>\n[old](/en/new)\n</div>')
    expect(rewriteMovedPageLinks(input({ source, markdownAllowHTML: true })).source).toBe(source)
  })

  it('keeps code, images, raw HTML, external links, prose, and fenced examples unchanged', () => {
    const source = [
      'Literal /en/old prose and `[code](/en/old)`.',
      '![image](/en/old)',
      '[external](https://example.test/en/old)',
      '\\[escaped](/en/old)',
      '<!-- [comment](/en/old) -->',
      '<span data-example="[attribute](/en/old)">example</span>',
      '<a href="/en/old">HTML in Markdown is not a source link target here</a>',
      '```markdown',
      '[example](/en/old)',
      '```'
    ].join('\n')
    const result = rewriteMovedPageLinks(input({ source }))

    expect(result.source).toBe(source)
    expect(result.changes).toEqual([])
    expect(result.unsupported).toBe(1)
  })

  it('reports a reference-style link as unsupported when no exact inline destination span exists', () => {
    const source = '[Old][destination]\n\n[destination]: /en/old'
    const result = rewriteMovedPageLinks(input({ source }))

    expect(result.source).toBe(source)
    expect(result.changes).toEqual([])
    expect(result.unsupported).toBe(1)
  })

  it('does not rewrite a route that only reaches the old page after decoding an encoded slash', () => {
    const source = '[Old](/en/old%2Fchild)'
    const result = rewriteMovedPageLinks(input({
      source,
      oldTarget: { locale: 'en', path: 'old/child' }
    }))

    expect(result.source).toBe(source)
    expect(result.changes).toEqual([])
    expect(result.unsupported).toBe(1)
  })

  it('rewrites enabled wikilinks and preserves unlabelled displayed text', () => {
    const result = rewriteMovedPageLinks(input({
      source: '[[/old#section|Old label]] and [[/old]]',
      wikiLinksEnabled: true
    }))

    expect(result.source).toBe('[[/new#section|Old label]] and [[/new|/old]]')
    expect(result.changes).toEqual([
      { before: '/old#section', after: '/new#section' },
      { before: '[[/old]]', after: '[[/new|/old]]' }
    ])
  })

  it('re-resolves self-links from the moved page at its new identity', () => {
    const result = rewriteMovedPageLinks(input({
      source: '[[/old]]',
      sourcePage: { locale: 'en', path: 'old' },
      wikiLinksEnabled: true
    }))

    expect(result.source).toBe('[[/new|/old]]')
  })

  it('converts a cross-locale wikilink to Markdown without changing its visible label', () => {
    const result = rewriteMovedPageLinks(input({
      source: '[[/old#intro|See it *now*]]',
      newTarget: { locale: 'fr', path: 'nouvel-article' },
      wikiLinksEnabled: true
    }))

    expect(result.source).toBe('[See it \\*now\\*](</fr/nouvel-article#intro>)')
    expect(result.changes).toEqual([
      { before: '[[/old#intro|See it *now*]]', after: '[See it \\*now\\*](</fr/nouvel-article#intro>)' }
    ])
  })

  it('leaves wikilinks literal when the renderer has them disabled', () => {
    const source = '[[/old]]'
    const result = rewriteMovedPageLinks(input({ source }))

    expect(result.source).toBe(source)
    expect(result.changes).toEqual([])
    expect(result.unsupported).toBe(0)
  })

  it('rewrites only real quoted HTML anchor hrefs and skips comments, scripts, code, images, and ambiguous anchors', () => {
    const source = [
      '<!-- <a href="/en/old"> -->',
      '<a data-example="<a href=\'/en/old\'>" HREF=\'/en/old?tab=1&amp;show=2\' title="kept">Old</a>',
      '<script>const example = \'<a href="/en/old">\';</script>',
      '<pre><code><a href="/en/old">literal</a></code></pre>',
      '<img src="/en/old">',
      '<a href=/en/old>unquoted</a>',
      '<a href="/en/old" href="/en/old">duplicate</a>',
      '<a href="https://external.test/en/old">external</a>'
    ].join('\n')
    const result = rewriteMovedPageLinks(input({ source, editor: 'ckeditor' }))

    expect(result.source).toBe(source.replace("HREF='/en/old?tab=1&amp;show=2'", "HREF='/en/new?tab=1&amp;show=2'"))
    expect(result.changes).toEqual([{ before: '/en/old?tab=1&amp;show=2', after: '/en/new?tab=1&amp;show=2' }])
    expect(result.unsupported).toBe(2)
  })
})
