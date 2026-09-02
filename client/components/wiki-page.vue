<template lang="pug">
  Page(
    v-bind='currentPage.props'
    :navigation-key='navigationKey'
    :navigation-pending='navigationPending'
  )
    template(v-slot:contents)
      slot(v-if='navigationKey === 0' name='contents')
      component(v-else :is='contentComponent')
    template(v-slot:comments)
      slot(v-if='navigationKey === 0' name='comments')
      Comments(v-else-if='currentPage.props.commentsEnabled && !currentPage.props.commentsExternal')
      .wiki-page-rendered-comments(v-else-if='commentsHtml' v-html='commentsHtml')
</template>

<script lang="ts">
import { defineComponent, markRaw, nextTick, type Component } from 'vue'
import Comments from './comments.vue'
import Page from '../themes/default/components/page.vue'
import { loadingStart, loadingStop } from '../helpers/root-ui-store'
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

const NAVIGATION_STATE_KEY = '__wikiPageNavigation'
const NAVIGATION_LOADING_KEY = 'wiki-page-navigation'

export default defineComponent({
  name: 'WikiPage',
  components: { Comments, Page },
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
      contentComponent: null as Component | null,
      commentsHtml: '',
      navigationKey: 0,
      navigationPending: false,
      currentUrl: window.location.href,
      previousScrollRestoration: null as History['scrollRestoration'] | null,
      navigationSequence: 0,
      navigationAbortController: null as AbortController | null,
      removeNavigationHandler: null as (() => void) | null
    }
  },
  mounted() {
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
    window.removeEventListener('popstate', this.handlePopState)
    if (this.previousScrollRestoration !== null && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = this.previousScrollRestoration
    }
  },
  methods: {
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
      if (destination.pathname === current.pathname && destination.search === current.search && destination.hash) {
        if (!options.popState) {
          this.saveCurrentHistoryScroll()
          window.history.pushState({ [NAVIGATION_STATE_KEY]: true, scrollY: window.scrollY }, '', destination)
        }
        this.currentUrl = destination.href
        this.restoreScroll(destination, options.scrollY)
        return
      }

      const sequence = ++this.navigationSequence
      this.navigationAbortController?.abort()
      const controller = new AbortController()
      this.navigationAbortController = controller
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
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          this.hardNavigate(destination, options.popState)
          return
        }

        const parsed = parseWikiNavigationDocument(await response.text(), response.url)
        if (sequence !== this.navigationSequence) return
        if (!parsed || parsed.language !== document.documentElement.lang) {
          this.hardNavigate(new URL(response.url), options.popState)
          return
        }

        if (!options.popState) {
          this.saveCurrentHistoryScroll()
          window.history.pushState({ [NAVIGATION_STATE_KEY]: true, scrollY: 0 }, '', parsed.url)
        }
        this.currentPage = markRaw(parsed.payload)
        this.contentComponent = markRaw(defineComponent({
          name: 'WikiPageRouteContent',
          template: parsed.contentHtml
        }))
        this.commentsHtml = parsed.commentsHtml
        this.currentUrl = parsed.url.href
        this.navigationKey += 1
        this.updateDocumentMetadata(parsed.documentTitle, parsed.description, parsed.url)

        await nextTick()
        if (controller.signal.aborted || sequence !== this.navigationSequence) return
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (controller.signal.aborted || sequence !== this.navigationSequence) return
        this.restoreScroll(parsed.url, options.scrollY)
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
