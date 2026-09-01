import { describe, expect, test, vi } from '../../server/test/bun-test.mts'
import {
  decodeWikiPagePayload,
  installWikiNavigationHandler,
  isWikiNavigationClick,
  navigateToWikiPage,
  parseWikiNavigationDocument,
  type WikiPagePayload
} from './wiki-navigation'

const payload = (spaNavigation = true): WikiPagePayload => ({
  version: 1,
  spaNavigation,
  props: {
    pageId: 42,
    locale: 'en',
    path: 'guides/routing',
    title: 'Routing guide',
    description: 'Persistent navigation',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    sourceRevision: '7',
    tags: [{ tag: 'guide', title: 'Guide' }],
    authorName: 'Editor',
    authorId: 7,
    editor: 'markdown',
    isPublished: true,
    visibility: 'public',
    toc: 'W10=',
    sidebar: 'W10=',
    navMode: 'MIXED',
    navExpandParent: true,
    commentsEnabled: false,
    effectivePermissions: 'e30=',
    commentsExternal: false,
    editShortcuts: 'e30=',
    filename: 'guides/routing.md'
  }
})

const encodePayload = (value: WikiPagePayload): string => window.btoa(JSON.stringify(value))

const pageDocument = (value: WikiPagePayload): string => `<!doctype html>
<html lang="en">
  <head>
    <title>${value.props.title} | Test Wiki</title>
    <meta name="description" content="${value.props.description}">
  </head>
  <body>
    <wiki-page data-wiki-page-shell payload="${encodePayload(value)}">
      <template data-wiki-page-contents><div><h2>New page</h2></div></template>
      <template data-wiki-page-comments><div>Discussion</div></template>
    </wiki-page>
  </body>
</html>`

describe('wiki page navigation payloads', () => {
  test('validates and decodes the server payload', () => {
    expect(decodeWikiPagePayload(encodePayload(payload())).props.path).toBe('guides/routing')
  })

  test('rejects malformed payloads at the document boundary', () => {
    const malformed = window.btoa(JSON.stringify({ version: 1, spaNavigation: true, props: { pageId: '42' } }))
    expect(() => decodeWikiPagePayload(malformed)).toThrow()
  })

  test('extracts page content, metadata, and comments from a full HTML response', () => {
    const parsed = parseWikiNavigationDocument(pageDocument(payload()), 'https://wiki.test/en/guides/routing')

    expect(parsed).not.toBeNull()
    expect(parsed?.payload.props.title).toBe('Routing guide')
    expect(parsed?.contentHtml).toContain('<h2>New page</h2>')
    expect(parsed?.commentsHtml).toContain('Discussion')
    expect(parsed?.documentTitle).toBe('Routing guide | Test Wiki')
    expect(parsed?.description).toBe('Persistent navigation')
    expect(parsed?.url.href).toBe('https://wiki.test/en/guides/routing')
  })

  test('declines documents that require a full page lifecycle', () => {
    expect(parseWikiNavigationDocument(pageDocument(payload(false)), 'https://wiki.test/en/guides/routing')).toBeNull()
    expect(parseWikiNavigationDocument('<html><body>Login</body></html>', 'https://wiki.test/login')).toBeNull()
  })
})

describe('wiki navigation routing', () => {
  test('accepts an unmodified same-origin link', () => {
    const anchor = document.createElement('a')
    anchor.href = '/en/next-page'
    const event = new MouseEvent('click', { button: 0 })

    expect(isWikiNavigationClick(event, anchor)).toBe(true)
  })

  const ignoredClicks: Array<[string, MouseEvent, string]> = [
    ['modified click', new MouseEvent('click', { button: 0, ctrlKey: true }), '/en/next-page'],
    ['external origin', new MouseEvent('click', { button: 0 }), 'https://example.com/page'],
    ['same-page anchor', new MouseEvent('click', { button: 0 }), `${window.location.pathname}#section`]
  ]

  test.each(ignoredClicks)('ignores %s', (_label, event, href) => {
    const anchor = document.createElement('a')
    anchor.href = href
    expect(isWikiNavigationClick(event, anchor)).toBe(false)
  })

  test('routes programmatic navigation through the mounted shell and removes it cleanly', async () => {
    const handler = vi.fn()
    const remove = installWikiNavigationHandler(handler)

    navigateToWikiPage('/en/next-page')
    await Promise.resolve()

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(URL)
    expect(handler.mock.calls[0]?.[0].pathname).toBe('/en/next-page')
    remove()
  })

  test('preserves a locale-aware Home route through the mounted shell', async () => {
    const handler = vi.fn()
    const remove = installWikiNavigationHandler(handler)

    try {
      navigateToWikiPage('/fr/home')
      await Promise.resolve()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(URL)
      expect(handler.mock.calls[0]?.[0].pathname).toBe('/fr/home')
    } finally {
      remove()
    }
  })
})
