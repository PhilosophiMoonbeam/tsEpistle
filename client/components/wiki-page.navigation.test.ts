import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, test, vi } from '../../server/test/bun-test.mts'
import { parseWikiNavigationDocument, type WikiPagePayload } from '../helpers/wiki-navigation'

type NavigationOptions = {
  popState?: boolean
  scrollY?: number
}

type NavigationVm = {
  currentUrl: string
  navigationSequence: number
  activePageView: 'article' | 'talk' | 'links'
  navigationAbortController: AbortController | null
  navigationPending: boolean
  currentPage: WikiPagePayload
  contentHtml: string
  commentsHtml: string
  navigationKey: number
  saveCurrentHistoryScroll: () => void
  hardNavigate: (destination: URL, popState?: boolean) => void
  updateDocumentMetadata: (title: string, description: string, url: URL) => void
  restoreScroll: (destination: URL, savedScrollY?: number) => void
}

type WikiPageComponentOptions = {
  computed: {
    linksVisible: (this: NavigationVm) => boolean
    ratingsVisible: (this: NavigationVm) => boolean
    lastEditorVisible: (this: NavigationVm) => boolean
  }
  methods: {
    navigate: (this: NavigationVm, destination: URL, options?: NavigationOptions) => Promise<void>
    handleHashChange: (this: NavigationVm) => void
  }
}

const componentPath = path.join(process.cwd(), 'client/components/wiki-page.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('wiki-page.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[\s\S]*?from\s+["'][^"']+["']\s*$/gm, '').replace('export default defineComponent({', 'const wikiPageComponent = defineComponent({')
)

const payload = (): WikiPagePayload => ({
  version: 1,
  spaNavigation: true,
  pageFeatures: { schemaVersion: 1, linksVisible: false, ratingsAllowed: true, lastEditorVisible: false },
  ratingsSiteEnabled: false,
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
    filename: 'guides/routing.md',
    branding: null
  }
})

const pageDocument = (): string => `<!doctype html>
<html lang="${document.documentElement.lang}">
  <head>
    <title>Routing guide | Test Wiki</title>
    <meta name="description" content="Persistent navigation">
  </head>
  <body>
    <wiki-page data-wiki-page-shell payload="${window.btoa(JSON.stringify(payload()))}">
      <template data-wiki-page-contents><div data-forged-content>New page</div></template>
      <template data-wiki-page-comments><div data-forged-comments>Discussion</div></template>
    </wiki-page>
  </body>
</html>`

const loadComponent = (fetchResponse: Response) => {
  const fetch = vi.fn(async () => fetchResponse)
  const evaluate = new Function(
    'defineComponent',
    'markRaw',
    'nextTick',
    'Comments',
    'Page',
    'WikiPageLinks',
    'WikiPageRatings',
    'loadingStart',
    'loadingStop',
    'decodeWikiPagePayload',
    'installWikiNavigationHandler',
    'isWikiNavigationClick',
    'parseWikiNavigationDocument',
    'wikiStore',
    'fetch',
    'requestAnimationFrame',
    `${executableScript}\nreturn wikiPageComponent`
  ) as (...dependencies: unknown[]) => WikiPageComponentOptions

  const component = evaluate(
    (options: WikiPageComponentOptions) => options,
    <Value>(value: Value): Value => value,
    () => Promise.resolve(),
    {},
    {},
    {},
    {},
    () => undefined,
    () => undefined,
    () => payload(),
    () => () => undefined,
    () => false,
    parseWikiNavigationDocument,
    {},
    fetch,
    (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }
  )
  return { component, fetch }
}

const response = (options: { url: string; headers?: HeadersInit; body?: string }) => {
  const readBody = vi.fn(async () => options.body ?? pageDocument())
  return {
    value: {
      ok: true,
      url: options.url,
      headers: new Headers(
        options.headers ?? {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Wiki-Page': '1'
        }
      ),
      text: readBody
    } as unknown as Response,
    readBody
  }
}

const navigationVm = (): NavigationVm => ({
  currentUrl: window.location.href,
  navigationSequence: 0,
  navigationAbortController: null,
  navigationPending: false,
  activePageView: 'article',
  currentPage: payload(),
  contentHtml: '',
  commentsHtml: '',
  navigationKey: 0,
  saveCurrentHistoryScroll: vi.fn(),
  hardNavigate: vi.fn(),
  updateDocumentMetadata: vi.fn(),
  restoreScroll: vi.fn()
})

const navigate = async (fetchResponse: Response): Promise<NavigationVm> => {
  const { component } = loadComponent(fetchResponse)
  const vm = navigationVm()
  await component.methods.navigate.call(vm, new URL('/en/requested', window.location.href), { popState: true })
  return vm
}

describe('wiki page feature visibility', () => {
  test('visibility flags respect page policy and the rating site gate as pages change', () => {
    const { component } = loadComponent(new Response())
    const vm = navigationVm()
    const enabledFeatures: WikiPagePayload['pageFeatures'] = {
      schemaVersion: 1,
      linksVisible: true,
      ratingsAllowed: true,
      lastEditorVisible: true
    }
    vm.currentPage = { ...payload(), pageFeatures: enabledFeatures, ratingsSiteEnabled: true }

    expect(component.computed.linksVisible.call(vm)).toBe(true)
    expect(component.computed.ratingsVisible.call(vm)).toBe(true)
    expect(component.computed.lastEditorVisible.call(vm)).toBe(true)

    vm.currentPage = {
      ...vm.currentPage,
      pageFeatures: { ...enabledFeatures, linksVisible: false, ratingsAllowed: false, lastEditorVisible: false }
    }
    expect(component.computed.linksVisible.call(vm)).toBe(false)
    expect(component.computed.ratingsVisible.call(vm)).toBe(false)
    expect(component.computed.lastEditorVisible.call(vm)).toBe(false)

    vm.currentPage = { ...vm.currentPage, pageFeatures: enabledFeatures, ratingsSiteEnabled: false }
    expect(component.computed.ratingsVisible.call(vm)).toBe(false)
  })
})

describe('wiki page navigation response boundary', () => {
  test('keeps a marked same-origin HTML page in SPA navigation', async () => {
    const finalUrl = new URL('/en/redirected-page', window.location.origin).href
    const { value, readBody } = response({
      url: finalUrl,
      headers: {
        'Content-Disposition': 'inline',
        'Content-Type': 'Text/HTML; charset=UTF-8',
        'X-Wiki-Page': '1'
      }
    })

    const vm = await navigate(value)

    expect(readBody).toHaveBeenCalledOnce()
    expect(vm.hardNavigate).not.toHaveBeenCalled()
    expect(vm.contentHtml).toContain('data-forged-content')
    expect(vm.commentsHtml).toContain('data-forged-comments')
    expect(vm.navigationKey).toBe(1)
    expect(vm.currentUrl).toBe(finalUrl)
  })

  test('switches Article and Talk through same-page history without fetching', async () => {
    const original = window.location.href
    const originalState = window.history.state
    const articleUrl = new URL(original)
    articleUrl.hash = ''
    try {
      window.history.replaceState({}, '', articleUrl)
      const { value, readBody } = response({ url: articleUrl.href })
      const { component, fetch } = loadComponent(value)
      const vm = navigationVm()
      const destination = new URL(vm.currentUrl)
      destination.hash = 'discussion'

      await component.methods.navigate.call(vm, destination)

      expect(fetch).not.toHaveBeenCalled()
      expect(readBody).not.toHaveBeenCalled()
      expect(vm.activePageView).toBe('talk')
      expect(vm.currentUrl).toBe(destination.href)
      expect(vm.restoreScroll).toHaveBeenCalledWith(destination, undefined)
    } finally {
      window.history.replaceState(originalState, '', original)
    }
  })

  test('opens the Links view when an article fragment changes without a network request', async () => {
    const original = window.location.href
    const originalState = window.history.state
    const articleUrl = new URL(original)
    articleUrl.hash = ''
    window.history.replaceState({}, '', articleUrl)
    const { value, readBody } = response({ url: articleUrl.href })
    const { component, fetch } = loadComponent(value)
    const vm = navigationVm() as NavigationVm & { navigate: WikiPageComponentOptions['methods']['navigate'] }
    vm.navigate = (destination, options) => component.methods.navigate.call(vm, destination, options)
    vm.currentPage.pageFeatures.linksVisible = true
    Object.defineProperty(vm, 'linksVisible', { get: () => component.computed.linksVisible.call(vm) })
    try {
      window.history.replaceState({}, '', '#page-links')
      component.methods.handleHashChange.call(vm)
      await vi.waitFor(() => expect(vm.activePageView).toBe('links'))
      expect(vm.currentUrl).toBe(window.location.href)
      expect(readBody).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()

      window.history.replaceState({}, '', articleUrl)
      component.methods.handleHashChange.call(vm)
      await vi.waitFor(() => expect(vm.activePageView).toBe('article'))
      expect(fetch).not.toHaveBeenCalled()
      expect(readBody).not.toHaveBeenCalled()
    } finally {
      window.history.replaceState(originalState, '', original)
    }
  })

  const rejectedResponses: Array<[string, string, HeadersInit]> = [
    [
      'a cross-origin final response',
      'https://assets.example.test/forged.html',
      {
        'Content-Type': 'text/html',
        'X-Wiki-Page': '1'
      }
    ],
    [
      'a response without the page marker',
      new URL('/assets/forged.html', window.location.origin).href,
      {
        'Content-Type': 'text/html'
      }
    ],
    [
      'a response with a non-exact page marker',
      new URL('/assets/forged.html', window.location.origin).href,
      {
        'Content-Type': 'text/html',
        'X-Wiki-Page': '01'
      }
    ],
    [
      'a non-HTML response',
      new URL('/assets/forged.svg', window.location.origin).href,
      {
        'Content-Type': 'image/svg+xml',
        'X-Wiki-Page': '1'
      }
    ]
  ]

  test.each(rejectedResponses)('hard-navigates before reading %s', async (_label, finalUrl, headers) => {
    const { value, readBody } = response({ url: finalUrl, headers, body: pageDocument() })

    const vm = await navigate(value)

    expect(readBody).not.toHaveBeenCalled()
    expect(vm.hardNavigate).toHaveBeenCalledOnce()
    expect(vm.contentHtml).toBe('')
    expect(vm.commentsHtml).toBe('')
    expect(vm.navigationKey).toBe(0)
  })

  test('does not parse a forged wiki shell delivered as an attachment', async () => {
    const finalUrl = new URL('/assets/export.html', window.location.origin).href
    const { value, readBody } = response({
      url: finalUrl,
      headers: {
        'Content-Disposition': 'ATTACHMENT; filename="export.html"',
        'Content-Type': 'text/html',
        'X-Wiki-Page': '1'
      },
      body: pageDocument()
    })

    const vm = await navigate(value)

    expect(readBody).not.toHaveBeenCalled()
    expect(vm.hardNavigate).toHaveBeenCalledWith(new URL(finalUrl), true)
    expect(vm.contentHtml).toBe('')
    expect(vm.commentsHtml).toBe('')
    expect(vm.navigationKey).toBe(0)
  })
})
