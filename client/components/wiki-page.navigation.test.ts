import fs from 'node:fs'
import path from 'node:path'
import { document } from '../test/browser-dom.mts'

import { describe, expect, test, vi } from '../../server/test/bun-test.mts'
import { parseWikiNavigationDocument, type WikiPagePayload } from '../helpers/wiki-navigation'
import { focusDiscussionThread } from '../helpers/discussion-annotation-events'

// Vue must capture the singleton document installed by browser-dom.
const Vue = await import('vue')

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
  focusHashThread: () => void
  feedbackDiscussionEnabled: boolean
  selectPageView: (view: 'article' | 'talk' | 'links') => Promise<void>
  $refs: { comments?: { prepareFeedbackDraft: (content: string) => Promise<void> } }
}

type WikiPageComponentOptions = {
  computed: {
    pageTransitions: (this: NavigationVm) => boolean
    showPageProgress: (this: NavigationVm) => boolean
    linksVisible: (this: NavigationVm) => boolean
    ratingsVisible: (this: NavigationVm) => boolean
    feedbackDiscussionEnabled: (this: NavigationVm) => boolean
    lastEditorVisible: (this: NavigationVm) => boolean
  }
  methods: {
    navigate: (this: NavigationVm, destination: URL, options?: NavigationOptions) => Promise<void>
    handleHashChange: (this: NavigationVm) => void
    focusHashThread: (this: NavigationVm) => void
    prepareFeedbackDraft: (this: NavigationVm, content: string) => Promise<void>
    selectPageView: (this: NavigationVm, view: 'article' | 'talk' | 'links') => Promise<void>
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

const loadComponent = (
  fetchResponse: Response,
  site = { pageTransitions: true, showPageProgress: false },
  authority = {
    user: { id: 7, authVersion: 3 },
    offlineIdentityEpoch: 1,
    page: { id: 42, effectivePermissions: { comments: { read: true, write: true } } }
  },
  nextTick = () => Promise.resolve()
) => {
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
    'focusDiscussionThread',
    'requestAnimationFrame',
    `${executableScript}\nreturn wikiPageComponent`
  ) as (...dependencies: unknown[]) => WikiPageComponentOptions

  const component = evaluate(
    (options: WikiPageComponentOptions) => options,
    Vue.markRaw,
    nextTick,
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
    // Retain the live authority object: spreading it snapshots scalar identity
    // epochs while nested user and ACL mutations still appear to work.
    Object.assign(authority, { site }),
    fetch,
    focusDiscussionThread,
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

const navigationVm = (component = loadComponent(new Response()).component): NavigationVm => ({
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
  restoreScroll: vi.fn(),
  focusHashThread() {
    component.methods.focusHashThread.call(this)
  },
  feedbackDiscussionEnabled: false,
  selectPageView(view) {
    return component.methods.selectPageView.call(this, view)
  },
  $refs: {}
})

const navigate = async (fetchResponse: Response): Promise<NavigationVm> => {
  const { component } = loadComponent(fetchResponse)
  const vm = navigationVm()
  await component.methods.navigate.call(vm, new URL('/en/requested', window.location.href), { popState: true })
  return vm
}

describe('wiki page feature visibility', () => {
  test('passes independent runtime theme settings to the page reader', () => {
    const site = { pageTransitions: true, showPageProgress: false }
    const { component } = loadComponent(new Response(), site)
    const vm = navigationVm()
    for (const pageTransitions of [false, true]) {
      for (const showPageProgress of [false, true]) {
        Object.assign(site, { pageTransitions, showPageProgress })
        expect(component.computed.pageTransitions.call(vm)).toBe(pageTransitions)
        expect(component.computed.showPageProgress.call(vm)).toBe(showPageProgress)
      }
    }
  })
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

describe('contextual feedback discussion handoff', () => {
  const draft = 'Task: configure a service\nExpected: a working setup\nMissing: a final command'
  const setup = (nextTick = () => Promise.resolve()) => {
    const authority = {
      user: { id: 7, authVersion: 3 },
      offlineIdentityEpoch: 1,
      page: { id: 42, effectivePermissions: { comments: { read: true, write: true } } }
    }
    const { component } = loadComponent(new Response(), undefined, authority, nextTick)
    const vm = navigationVm(component)
    vm.currentPage.props.commentsEnabled = true
    const receiveDraft = vi.fn(async (_content: string) => {})
    vm.$refs.comments = { prepareFeedbackDraft: receiveDraft }
    Object.defineProperty(vm, 'feedbackDiscussionEnabled', { get: () => component.computed.feedbackDiscussionEnabled.call(vm) })
    return { component, vm, authority, receiveDraft }
  }

  test('opens the current native discussion and passes the editable feedback to its composer', async () => {
    const { component, vm, receiveDraft } = setup()
    const previousUrl = window.location.href
    try {
      await component.methods.prepareFeedbackDraft.call(vm, draft)
      expect(vm.activePageView).toBe('talk')
      expect(new URL(vm.currentUrl).hash).toBe('#discussion')
      expect(receiveDraft).toHaveBeenCalledWith(draft)
      expect(receiveDraft).toHaveBeenCalledTimes(1)
      expect(vm.restoreScroll).toHaveBeenCalledWith(new URL(vm.currentUrl))
    } finally {
      window.history.replaceState(null, '', previousUrl)
    }
  })

  for (const denied of ['external', 'disabled', 'wrong-page', 'read-denied', 'write-denied', 'empty']) {
    test(`does not leave the article or hand a feedback draft to ${denied} discussion`, async () => {
      const { component, vm, authority, receiveDraft } = setup()
      if (denied === 'external') vm.currentPage.props.commentsExternal = true
      if (denied === 'disabled') vm.currentPage.props.commentsEnabled = false
      if (denied === 'wrong-page') authority.page.id = 99
      if (denied === 'read-denied') authority.page.effectivePermissions.comments.read = false
      if (denied === 'write-denied') authority.page.effectivePermissions.comments.write = false
      await component.methods.prepareFeedbackDraft.call(vm, denied === 'empty' ? '  ' : draft)
      expect(vm.activePageView).toBe('article')
      expect(receiveDraft).not.toHaveBeenCalled()
    })
  }

  for (const changed of ['owner', 'auth-version', 'identity-epoch', 'page', 'acl']) {
    test(`drops a queued feedback handoff after ${changed} changes`, async () => {
      const mounted = Promise.withResolvers<void>()
      const { component, vm, authority, receiveDraft } = setup(() => mounted.promise)
      const previousUrl = window.location.href
      try {
        const preparing = component.methods.prepareFeedbackDraft.call(vm, draft)
        expect(vm.activePageView).toBe('talk')
        if (changed === 'owner') authority.user.id = 8
        if (changed === 'auth-version') authority.user.authVersion++
        if (changed === 'identity-epoch') authority.offlineIdentityEpoch++
        if (changed === 'page') vm.currentPage = { ...payload(), props: { ...payload().props, pageId: 99, commentsEnabled: true } }
        if (changed === 'acl') authority.page.effectivePermissions.comments.write = false
        mounted.resolve()
        await preparing
        expect(receiveDraft).not.toHaveBeenCalled()
      } finally {
        window.history.replaceState(null, '', previousUrl)
      }
    })
  }
})

describe('wiki page navigation response boundary', () => {
  test('keeps navigation pending until the page body is ready and clears it on completion', async () => {
    const destination = new URL('/en/pending-page', window.location.origin)
    const { value, readBody } = response({ url: destination.href })
    const body = Promise.withResolvers<string>()
    readBody.mockImplementationOnce(() => body.promise)
    const { component } = loadComponent(value)
    const vm = navigationVm(component)
    const navigation = component.methods.navigate.call(vm, destination, { popState: true })
    expect(vm.navigationPending).toBe(true)
    await Promise.resolve()
    expect(readBody).toHaveBeenCalledTimes(1)
    expect(vm.navigationPending).toBe(true)
    expect(vm.navigationKey).toBe(0)
    body.resolve(pageDocument())
    await navigation
    expect(vm.navigationPending).toBe(false)
    expect(vm.navigationAbortController).toBeNull()
    expect(vm.navigationKey).toBe(1)
  })

  test('does not let an obsolete navigation hide the cue for its replacement', async () => {
    const destination = new URL('/en/replacement-page', window.location.origin)
    const { value } = response({ url: destination.href })
    const { component, fetch } = loadComponent(value)
    const firstResponse = Promise.withResolvers<Response>()
    const secondResponse = Promise.withResolvers<Response>()
    fetch.mockImplementationOnce(() => firstResponse.promise)
    fetch.mockImplementationOnce(() => secondResponse.promise)
    const vm = navigationVm(component)
    const first = component.methods.navigate.call(vm, new URL('/en/obsolete-page', window.location.origin), { popState: true })
    const previous = vm.navigationAbortController!
    const second = component.methods.navigate.call(vm, destination, { popState: true })
    expect(previous.signal.aborted).toBe(true)
    firstResponse.resolve(value)
    await first
    expect(vm.navigationPending).toBe(true)
    expect(vm.navigationKey).toBe(0)
    secondResponse.resolve(value)
    await second
    expect(vm.navigationPending).toBe(false)
    expect(vm.navigationKey).toBe(1)
  })

  test('clears pending navigation after a failed request without replacing readable content', async () => {
    const { component, fetch } = loadComponent(new Response())
    fetch.mockRejectedValueOnce(new Error('Connection interrupted'))
    const vm = navigationVm(component)
    const navigation = component.methods.navigate.call(vm, new URL('/en/failed-page', window.location.origin), { popState: true })
    expect(vm.navigationPending).toBe(true)
    await navigation
    expect(vm.navigationPending).toBe(false)
    expect(vm.navigationKey).toBe(0)
    expect(vm.hardNavigate).toHaveBeenCalledTimes(1)
  })

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

    expect(readBody).toHaveBeenCalledTimes(1)
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
    expect(vm.hardNavigate).toHaveBeenCalledTimes(1)
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
