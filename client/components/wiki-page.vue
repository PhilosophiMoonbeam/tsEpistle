<template lang="pug">
  Page(
    v-bind='currentPage.props'
    :navigation-key='navigationKey'
    :navigation-pending='navigationPending'
    :active-view='activePageView'
    :links-visible='linksVisible'
    :ratings-visible='ratingsVisible'
    :last-editor-visible='lastEditorVisible'
    @update:active-view='selectPageView'
    @focus-thread='openDiscussionThread'
  )
    template(v-slot:contents)
      slot(v-if='navigationKey === 0' name='contents')
      .wiki-page-rendered-contents(v-else v-html='contentHtml')
    template(v-slot:comments)
      slot(v-if='navigationKey === 0' name='comments')
      Comments(v-else-if='currentPage.props.commentsEnabled && !currentPage.props.commentsExternal')
      .wiki-page-rendered-comments(v-else-if='commentsHtml' v-html='commentsHtml')
    template(v-slot:links='slotProps')
      WikiPageLinks(v-bind='slotProps')
    template(v-slot:ratings='slotProps')
      WikiPageRatings(v-bind='slotProps')
</template>

<script lang="ts">
import { defineComponent, markRaw, nextTick } from 'vue'
import Comments from './comments.vue'
import WikiPageLinks from './wiki-page-links.vue'
import WikiPageRatings from './wiki-page-ratings.vue'
import Page from '../themes/default/components/page.vue'
import { loadingStart, loadingStop } from '../helpers/root-ui-store'
import { focusDiscussionThread } from '../helpers/discussion-annotation-events'
import {
  decodeWikiPagePayload,
  installWikiNavigationHandler,
  isWikiNavigationClick,
  parseWikiNavigationDocument
} from '../helpers/wiki-navigation'
import { wikiStore } from '../store/index.ts'

interface NavigationOptions {
  popState?: boolean
  scrollY?: number
}

type PageView = 'article' | 'talk' | 'links'
const pageViewForUrl = (url: string | URL, linksVisible = false): PageView => {
  const hash = new URL(url, window.location.href).hash
  if (linksVisible && hash === '#page-links') return 'links'
  return hash === '#discussion' || hash.startsWith('#comment-post-id-') ? 'talk' : 'article'
}
const pageQueryWithoutGlossary = (url: URL): string => {
  const query = new URLSearchParams(url.search)
  query.delete('glossary')
  return query.toString()
}
const NAVIGATION_STATE_KEY = '__wikiPageNavigation'
const NAVIGATION_LOADING_KEY = 'wiki-page-navigation'

const hasAttachmentDisposition = (value: string | null): boolean =>
  value !== null && /(?:^|,)\s*attachment\s*(?:;|,|$)/i.test(value)

const isTrustedWikiPageResponse = (response: Response, responseUrl: URL): boolean => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return response.ok &&
    responseUrl.origin === window.location.origin &&
    response.headers.get('X-Wiki-Page') === '1' &&
    contentType === 'text/html' &&
    !hasAttachmentDisposition(response.headers.get('content-disposition'))
}

export default defineComponent({
  name: 'WikiPage',
  components: { Comments, Page, WikiPageLinks, WikiPageRatings },
  props: {
    payload: {
      type: String,
      required: true
    }
  },
  data() {
    const currentPage = markRaw(decodeWikiPagePayload(this.payload))
    return {
      currentPage,
      contentHtml: '',
      commentsHtml: '',
      navigationKey: 0,
      navigationPending: false,
      currentUrl: window.location.href,
      activePageView: pageViewForUrl(window.location.href, currentPage.pageFeatures.linksVisible),
      previousScrollRestoration: null as History['scrollRestoration'] | null,
      navigationSequence: 0,
      navigationAbortController: null as AbortController | null,
      removeNavigationHandler: null as (() => void) | null
    }
  },
  computed: {
    linksVisible(): boolean {
      return this.currentPage.pageFeatures.linksVisible
    },
    ratingsVisible(): boolean {
      return this.currentPage.pageFeatures.ratingsAllowed && this.currentPage.ratingsSiteEnabled
    },
    lastEditorVisible(): boolean {
      return this.currentPage.pageFeatures.lastEditorVisible
    }
  },
  mounted() {
    window.addEventListener('hashchange', this.handleHashChange)
    window.addEventListener('wiki:navigation', this.handleReaderLocation)
    void nextTick().then(() => {
      if (this.activePageView === 'talk') this.restoreScroll(new URL(this.currentUrl))
      this.focusHashThread()
    })
    if (!this.currentPage.spaNavigation) return

    this.removeNavigationHandler = installWikiNavigationHandler(this.navigate)
    document.addEventListener('click', this.handleDocumentClick)
    window.addEventListener('popstate', this.handlePopState)
    if ('scrollRestoration' in window.history) {
      this.previousScrollRestoration = window.history.scrollRestoration
      window.history.scrollRestoration = 'manual'
    }
    this.saveCurrentHistoryScroll()
  },
  beforeUnmount() {
    this.navigationAbortController?.abort()
    this.removeNavigationHandler?.()
    document.removeEventListener('click', this.handleDocumentClick)
    window.removeEventListener('hashchange', this.handleHashChange)
    window.removeEventListener('wiki:navigation', this.handleReaderLocation)
    window.removeEventListener('popstate', this.handlePopState)
    if (this.previousScrollRestoration !== null && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = this.previousScrollRestoration
    }
  },
  methods: {
    async selectPageView(view: PageView): Promise<void> {
      if (view === this.activePageView || (view === 'links' && !this.linksVisible)) return
      this.saveCurrentHistoryScroll()
      const destination = new URL(this.currentUrl)
      if (view === 'talk') destination.hash = 'discussion'
      else if (view === 'links') destination.hash = 'page-links'
      else if (destination.hash === '#discussion' || destination.hash.startsWith('#comment-post-id-') || destination.hash === '#page-links') destination.hash = ''
      window.history.pushState({ ...window.history.state, [NAVIGATION_STATE_KEY]: true, scrollY: window.scrollY }, '', destination)
      this.currentUrl = destination.href
      this.activePageView = view
      await nextTick()
      if (view === 'talk' || view === 'links') this.restoreScroll(destination)
      else document.querySelector<HTMLElement>('.contents')?.focus({ preventScroll: true })
    },
    async openDiscussionThread(commentId: number): Promise<void> {
      if (!Number.isSafeInteger(commentId) || commentId < 1) return
      const destination = new URL(window.location.href)
      destination.hash = `comment-post-id-${commentId}`
      if (destination.href === this.currentUrl) {
        this.activePageView = 'talk'
        await nextTick()
        this.focusHashThread()
      } else await this.navigate(destination)
    },
    focusHashThread(): void {
      if (this.activePageView !== 'talk' || !this.currentPage.props.commentsEnabled || this.currentPage.props.commentsExternal) return
      const match = /^#comment-post-id-([1-9][0-9]*)$/u.exec(new URL(this.currentUrl).hash)
      const commentId = match ? Number(match[1]) : 0
      if (Number.isSafeInteger(commentId) && commentId > 0) focusDiscussionThread(this.currentPage.props.pageId, commentId)
    },
    handleReaderLocation(): void {
      const destination = new URL(window.location.href)
      const current = new URL(this.currentUrl)
      if (destination.pathname === current.pathname && destination.hash === current.hash && pageQueryWithoutGlossary(destination) === pageQueryWithoutGlossary(current)) {
        this.currentUrl = destination.href
      }
    },
    saveCurrentHistoryScroll(): void {
      const currentState = typeof window.history.state === 'object' && window.history.state !== null
        ? window.history.state as Record<string, unknown>
        : {}
      window.history.replaceState({
        ...currentState,
        [NAVIGATION_STATE_KEY]: true,
        scrollY: window.scrollY
      }, '', window.location.href)
    },
    handleDocumentClick(event: MouseEvent): void {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || !isWikiNavigationClick(event, anchor)) return
      event.preventDefault()
      void this.navigate(new URL(anchor.href, window.location.href))
    },
    handleHashChange(): void {
      const destination = new URL(window.location.href)
      const current = new URL(this.currentUrl)
      if (destination.pathname !== current.pathname || destination.search !== current.search) return
      void this.navigate(destination, { popState: true, scrollY: window.scrollY })
    },
    handlePopState(event: PopStateEvent): void {
      const state = typeof event.state === 'object' && event.state !== null
        ? event.state as Record<string, unknown>
        : {}
      void this.navigate(new URL(window.location.href), {
        popState: true,
        scrollY: typeof state.scrollY === 'number' ? state.scrollY : 0
      })
    },
    hardNavigate(destination: URL, popState = false): void {
      if (popState) window.location.reload()
      else window.location.assign(destination.href)
    },
    async navigate(destination: URL, options: NavigationOptions = {}): Promise<void> {
      if (destination.href === this.currentUrl) return

      const current = new URL(this.currentUrl)
      if (destination.pathname === current.pathname && pageQueryWithoutGlossary(destination) === pageQueryWithoutGlossary(current)) {
        const glossaryOnly = destination.hash === current.hash && destination.search !== current.search
        this.activePageView = pageViewForUrl(destination, this.linksVisible)
        if (!options.popState) {
          this.saveCurrentHistoryScroll()
          window.history.pushState({ ...window.history.state, [NAVIGATION_STATE_KEY]: true, scrollY: window.scrollY }, '', destination)
        }
        this.currentUrl = destination.href
        await nextTick()
        if (!glossaryOnly) this.restoreScroll(destination, options.scrollY)
        if (!glossaryOnly) this.focusHashThread()
        window.dispatchEvent(new CustomEvent('wiki:navigation', {
          detail: { url: destination.href, title: this.currentPage.props.title }
        }))
        return
      }

      const sequence = ++this.navigationSequence
      this.navigationAbortController?.abort()
      const controller = new AbortController()
      this.navigationAbortController = markRaw(controller)
      this.navigationPending = true
      loadingStart(wikiStore, NAVIGATION_LOADING_KEY)

      try {
        const response = await fetch(destination, {
          credentials: 'same-origin',
          headers: {
            Accept: 'text/html',
            'X-Wiki-Navigation': '1'
          },
          signal: controller.signal
        })
        if (sequence !== this.navigationSequence) return

        const responseUrl = new URL(response.url)
        if (!isTrustedWikiPageResponse(response, responseUrl)) {
          this.hardNavigate(responseUrl, options.popState)
          return
        }

        const parsed = parseWikiNavigationDocument(await response.text(), responseUrl)
        if (parsed && destination.hash && !parsed.url.hash) parsed.url.hash = destination.hash
        if (sequence !== this.navigationSequence) return
        if (!parsed || parsed.language !== document.documentElement.lang) {
          this.hardNavigate(responseUrl, options.popState)
          return
        }

        if (!options.popState) {
          this.saveCurrentHistoryScroll()
          window.history.pushState({ ...window.history.state, [NAVIGATION_STATE_KEY]: true, scrollY: 0 }, '', parsed.url)
        }
        this.currentPage = markRaw(parsed.payload)
        this.contentHtml = parsed.contentHtml
        this.commentsHtml = parsed.commentsHtml
        this.currentUrl = parsed.url.href
        this.activePageView = pageViewForUrl(parsed.url, this.linksVisible)
        this.navigationKey += 1
        this.updateDocumentMetadata(parsed.documentTitle, parsed.description, parsed.url)

        await nextTick()
        if (controller.signal.aborted || sequence !== this.navigationSequence) return
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (controller.signal.aborted || sequence !== this.navigationSequence) return
        this.restoreScroll(parsed.url, options.scrollY)
        this.focusHashThread()
        window.dispatchEvent(new CustomEvent('wiki:navigation', {
          detail: { url: parsed.url.href, title: parsed.payload.props.title }
        }))
      } catch (error) {
        if (controller.signal.aborted || sequence !== this.navigationSequence) return
        this.hardNavigate(destination, options.popState)
      } finally {
        loadingStop(wikiStore, NAVIGATION_LOADING_KEY)
        if (sequence === this.navigationSequence) {
          this.navigationPending = false
          this.navigationAbortController = null
        }
      }
    },
    updateDocumentMetadata(title: string, description: string, url: URL): void {
      document.title = title
      const metadata = [
        ['meta[name="description"]', description],
        ['meta[property="og:title"]', this.currentPage.props.title],
        ['meta[property="og:description"]', description],
        ['meta[property="og:url"]', url.href]
      ] as const
      for (const [selector, content] of metadata) {
        const element = document.querySelector<HTMLMetaElement>(selector)
        if (element) element.content = content
      }
    },
    restoreScroll(destination: URL, savedScrollY = 0): void {
      // Comments resolves and focuses authorized root/reply targets after lazy loading.
      if (/^#comment-post-id-[1-9][0-9]*$/u.test(destination.hash)) return
      if (destination.hash) {
        const encodedId = destination.hash.slice(1)
        let targetId = encodedId
        try {
          targetId = decodeURIComponent(encodedId)
        } catch {
          // Keep the literal fragment when it is not valid percent-encoding.
        }
        const target = document.getElementById(targetId)
        if (target) {
          target.scrollIntoView()
          target.setAttribute('tabindex', '-1')
          target.focus({ preventScroll: true })
          return
        }
      }
      window.scrollTo(0, savedScrollY)
      const title = document.querySelector<HTMLElement>('.page-title')
      title?.setAttribute('tabindex', '-1')
      title?.focus({ preventScroll: true })
    }
  }
})
</script>
