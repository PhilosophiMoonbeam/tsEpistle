<template lang="pug">
  .nav-sidebar
    .nav-sidebar-heading
      v-icon(icon='mdi-bookshelf', size='20', aria-hidden='true')
      h2 {{ $t('common:sidebar.library', { defaultValue: 'Library' }) }}
      span.nav-sidebar-locale {{ locale.toUpperCase() }}
    offline-navigation(v-if='connectionUnavailable', :active-path='`/${locale}/${path}`', @navigate='$emit(`navigate`)')
    template(v-else)
      .nav-sidebar-switcher.d-flex(
        v-if='navMode === `MIXED` || navMode === `STATIC`'
        :class='{ "nav-sidebar-switcher--static": navMode === `STATIC` }'
      )
        v-btn.nav-sidebar-home(
          :class='{ "nav-sidebar-home--static": navMode === `STATIC` }'
          :variant='path === `home` ? `tonal` : `text`'
          color='primary'
          @click='goHome'
          :aria-label='$t(`common:header.home`)'
          :aria-current='path === `home` ? `page` : undefined'
          )
          v-icon(:start='navMode === `STATIC`', size='20') mdi-home
          span.nav-sidebar-home-label.text-body-medium.text-none(v-if='navMode === `STATIC`') {{$t('common:header.home')}}
        .nav-sidebar-modes(v-if='navMode === `MIXED`', role='group', :aria-label='$t(`common:sidebar.navigationMode`)')
          v-btn.nav-sidebar-mode(
            variant="text"
            :aria-pressed='currentMode === `custom`'
            @click='switchMode(`custom`)'
            )
            span {{$t('common:sidebar.mainMenu')}}
          v-btn.nav-sidebar-mode(
            variant="text"
            :aria-pressed='currentMode === `browse`'
            @click='switchMode(`browse`)'
            )
            span {{$t('common:sidebar.browse')}}
      .nav-sidebar-directory-heading(v-if='navMode === `TREE`')
        span {{$t('common:sidebar.browse')}}
      .nav-sidebar-context(v-if='currentMode === `browse`')
        v-btn.nav-sidebar-root(
          variant='text'
          prepend-icon='mdi-folder-home-outline'
          :aria-current='currentParent.id === 0 ? `location` : undefined'
          :disabled='navLoading'
          @click='fetchBrowseItems({ id: 0, title: $t(`common:sidebar.root`) })'
        ) {{$t('common:sidebar.root')}}
        p.nav-sidebar-directory-path {{ currentParent.path ? `/${locale}/${currentParent.path}` : `/${locale}` }}
      .nav-sidebar-filter
        v-text-field(
          v-model='navigationFilter'
          :label='currentMode === `browse` ? $t(`common:sidebar.filterDirectory`, { defaultValue: `Filter loaded directory` }) : $t(`common:sidebar.filterMenu`, { defaultValue: `Filter main menu` })'
          prepend-inner-icon='mdi-magnify'
          variant='outlined'
          density='compact'
          clearable
          hide-details
        )
        p.nav-sidebar-filter-count(v-if='navigationFilter', role='status', aria-live='polite') {{ $t('common:sidebar.filterCount', { count: visibleNavigationCount, total: loadedNavigationCount, defaultValue: `${visibleNavigationCount} of ${loadedNavigationCount} loaded items` }) }}
      v-divider.nav-sidebar-edge
      //-> Custom Navigation
      v-list.nav-sidebar-list.py-2(v-if='currentMode === `custom`', density="compact", nav, role='group', tabindex='-1')
        async-state(
          v-if='customItems.length === 0 && !connectionUnavailable'
          state='empty'
          :title='$t(`common:sidebar.noNavigationItems`)'
          :message='navMode === `MIXED` ? $t(`common:sidebar.emptyNavigationHint`) : undefined'
        )
        async-state(v-else-if='navigationFilter && visibleNavigationCount === 0', state='empty', :title='$t(`common:sidebar.noFilterMatches`, { defaultValue: `No matching menu items` })')
        template(v-else)
          template(v-for='(item, idx) of filteredCustomItems', :key='item.k === `link` ? `link-${item.t}-${item.l}` : item.k === `header` ? `header-${item.l}-${idx}` : `divider-${idx}`')
            v-list-item(
              v-if='item.k === `link`'
              :href='item.t'
              :target='item.y === `externalblank` ? `_blank` : `_self`'
              :rel='item.y === `externalblank` ? `noopener` : ``'
              :active='isCurrentCustomLink(item)'
              :aria-current='isCurrentCustomLink(item) ? `page` : undefined'
              @click='sidebarLinkClicked'
            )
              template(v-slot:prepend)
                v-avatar(size='24', rounded='0', variant='text')
                  v-icon(v-if='item.c?.match(/fa[a-z] fa-/)', size='19') {{ item.c }}
                  v-icon(v-else) {{ item.c }}
              v-list-item-title {{ item.l }}
            v-divider.nav-sidebar-section-divider.my-2(v-else-if='item.k === `divider`')
            v-list-subheader.nav-sidebar-subheader(v-else-if='item.k === `header`') {{ item.l }}
      //-> Browse
      v-list.nav-sidebar-list.py-2(
        v-else-if='currentMode === `browse`'
        density="compact"
        nav
        :aria-busy='navLoading'
        role='group'
        tabindex='-1'
      )
        .nav-sidebar-loading-status(
          v-if='navLoading'
          role='status'
          aria-live='polite'
          aria-atomic='true'
        ) {{$t('common:sidebar.loadingNavigation')}}
        template(v-if='navLoading && currentItems.length === 0')
          v-skeleton-loader.nav-sidebar-loading-row(
            v-for='index in 4'
            :key='`browse-skeleton-` + index'
            type='list-item-avatar'
            aria-hidden='true'
          )
        v-progress-linear.nav-sidebar-progress(
          v-else-if='navLoading'
          indeterminate
          color='primary'
          height='2'
          :aria-label='$t(`common:sidebar.loadingNavigation`)'
        )
        async-state(
          v-else-if='navError && !connectionUnavailable'
          state='error'
          :title='$t(`common:sidebar.navigationLoadError`)'
          :message='navError'
          :retry-label='$t(`common:page.tryAgain`)'
          @retry='retryBrowse'
        )
        async-state(
          v-else-if='currentItems.length === 0 && !connectionUnavailable'
          state='empty'
          :title='$t(`common:sidebar.noPagesInDirectory`)'
        )
        async-state(v-else-if='navigationFilter && visibleNavigationCount === 0', state='empty', :title='$t(`common:sidebar.noDirectoryMatches`, { defaultValue: `No matches in this loaded directory` })')
        template(v-if='currentParent.id > 0')
          .nav-sidebar-ancestor-trail
            v-list-item.nav-sidebar-ancestor(
              v-for='(item, idx) of parents'
              :key='`parent-` + item.id'
              :class='{ "nav-sidebar-ancestor--current": item.id === currentParent.id }'
              :link='item.id !== currentParent.id'
              :role='item.id === currentParent.id ? undefined : `button`'
              :tabindex='item.id === currentParent.id ? undefined : 0'
              :aria-current='item.id === currentParent.id ? `location` : undefined'
              @click='item.id !== currentParent.id && fetchBrowseItems(item)'
            )
              template(v-slot:prepend)
                v-avatar.nav-sidebar-ancestor-icon(size='20', variant='text', :style='{ "--nav-depth": idx }')
                  v-icon(size="small") mdi-folder-open
              v-list-item-title(:title='item.title') {{ item.title }}
              template(v-slot:append, v-if='item.id !== currentParent.id')
                v-icon.nav-sidebar-folder-chevron(size='16', aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
          v-divider.nav-sidebar-section-divider.mt-2
          .nav-sidebar-current.d-flex.align-center.mt-2(v-if='typeof currentParent.pageId === "number" && currentParent.pageId > 0')
            v-list-item.nav-sidebar-current-page(
              :href='pagePath(currentParent)'
              :key='`directorypage-` + currentParent.id'
              :active='path === currentParent.path'
              :aria-current='path === currentParent.path ? `page` : undefined'
              @click='sidebarLinkClicked'
            )
              template(v-slot:prepend)
                v-avatar(size='24', variant='text')
                  v-icon mdi-text-box
              v-list-item-title(:title='currentParent.title') {{ currentParent.title }}
            v-btn.nav-sidebar-edit-parent.me-2(
              v-if='canEditCurrentParent'
              icon
              size="small"
              :href='editPath(currentParent)'
              :aria-label='$t(`common:sidebar.editParentPage`, { title: currentParent.title })'
            )
              v-icon(size="small") mdi-pencil
        template(v-for='item of filteredBrowseItems', :key='item.id')
          v-list-item.nav-sidebar-folder(v-if='item.isFolder', link, role='button', tabindex='0', @click='fetchBrowseItems(item)')
            template(v-slot:prepend)
              v-avatar(size='24', variant='text')
                v-icon mdi-folder
            v-list-item-title(:title='item.title') {{ item.title }}
            template(v-slot:append)
              v-icon.nav-sidebar-folder-chevron(size='16', aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-chevron-left' : 'mdi-chevron-right' }}
          v-list-item.nav-sidebar-page(v-else, :href='(item.visibility === `private` ? `/_private` : ``) + `/` + item.locale + `/` + item.path', :active='path === item.path', :aria-current='path === item.path ? `page` : undefined', @click='sidebarLinkClicked')
            template(v-slot:prepend)
              v-avatar(size='24', variant='text')
                v-icon mdi-text-box
            v-list-item-title(:title='item.title') {{ item.title }}
</template>

<script lang='ts'>
import * as _ from 'lodash-es'
import { observeBrowserConnection, pwaState, reportServerConnectionFailure, retryServerConnection } from '../../../helpers/pwa.ts'
import OfflineNavigation from '@/components/pwa/offline-navigation.vue'
import AsyncState from '@/components/common/async-state.vue'
import { defineComponent, markRaw, type PropType } from 'vue'
import { fetchPageTree, type PageTreeRow } from '../../../helpers/pages-api'
import { isWikiNavigationClick, navigateToWikiPage } from '../../../helpers/wiki-navigation'
import { wikiStore } from '@/store/index.ts'
import { loadingStart, loadingStop } from '../../../helpers/root-ui-store'

/* global siteLangs */
type NavigationMode = 'custom' | 'browse'

type NavigationTreeItem = {
  id: number
  title: string
  path?: string
  locale?: string
  pageId?: number | null
  visibility?: 'public' | 'private'
  canEdit?: boolean
}

export type SidebarItem =
  | { k: 'link', t: string, y: string, c: string, l: string }
  | { k: 'divider' }
  | { k: 'header', l: string }


export default defineComponent({
  components: { AsyncState, OfflineNavigation },
  emits: ['navigate'],
  props: {
    color: {
      type: String,
      default: 'bg-primary'
    },
    dark: {
      type: Boolean,
      default: true
    },
    items: {
      type: Array as PropType<SidebarItem[]>,
      default: () => []
    },
    navMode: {
      type: String,
      default: 'MIXED'
    },
    expandParentByDefault: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {
      currentMode: 'custom' as NavigationMode,
      navigationFilter: '' as string | null,
      currentItems: [] as PageTreeRow[],
      navLoading: false,
      navError: '',
      currentParent: {
        id: 0,
        title: `/ ${this.$t('common:sidebar.root')}`
      } as NavigationTreeItem,
      parents: [] as NavigationTreeItem[],
      loadedCache: [] as number[],
      browseRequestSequence: 0,
      browseRequestController: null as AbortController | null
    }
  },
  computed: {
    connectionState () { return pwaState.connectionState },
    connectionUnavailable () { return this.connectionState !== 'online' && pwaState.mode !== 'retirement' },
    path () {
      return wikiStore.page.path
    },
    locale () {
      return wikiStore.page.locale
    },
    canEditCurrentParent () {
      return this.currentParent.canEdit === true && this.currentParent.pageId !== wikiStore.page.id
    },
    customItems (): SidebarItem[] {
      return this.items.filter(item => item.k !== 'link' || item.y !== 'home')
    },
    filteredCustomItems (): SidebarItem[] {
      const query = (this.navigationFilter ?? '').trim().toLocaleLowerCase()
      if (!query) return this.customItems
      return this.customItems.filter(item => item.k !== 'link' || `${item.l} ${item.t}`.toLocaleLowerCase().includes(query))
    },
    filteredBrowseItems (): PageTreeRow[] {
      const query = (this.navigationFilter ?? '').trim().toLocaleLowerCase()
      if (!query) return this.currentItems
      return this.currentItems.filter(item => `${item.title} ${item.path ?? ''}`.toLocaleLowerCase().includes(query))
    },
    loadedNavigationCount (): number {
      return this.currentMode === 'browse' ? this.currentItems.length : this.customItems.filter(item => item.k === 'link').length
    },
    visibleNavigationCount (): number {
      return this.currentMode === 'browse' ? this.filteredBrowseItems.length : this.filteredCustomItems.filter(item => item.k === 'link').length
    },
    pageLocationKey (): string {
      return `${wikiStore.page.visibility}:${wikiStore.page.id}:${this.locale}:${this.path}`
    }
  },
  watch: {
    connectionState (state: string) {
      if (this.connectionUnavailable) {
        this.browseRequestSequence += 1
        this.browseRequestController?.abort()
        this.navLoading = false
      } else if (state === 'online' && this.currentMode === 'browse') {
        this.retryBrowse()
      }
    },
    pageLocationKey (value: string, previous: string) {
      if (value === previous || this.currentMode !== 'browse') return
      if (this.expandParentByDefault) void this.loadFromCurrentPath()
      else void this.fetchBrowseItems({ id: 0, title: `/ ${this.$t('common:sidebar.root')}` })
    }
  },
  methods: {
    resetBrowseRoot () {
      this.currentParent = {
        id: 0,
        title: `/ ${this.$t('common:sidebar.root')}`
      }
      this.parents = []
      this.currentItems = []
      this.loadedCache = []
    },
    sidebarLinkClicked (event: MouseEvent | KeyboardEvent) {
      const target = event.currentTarget
      if ('button' in event && target instanceof HTMLAnchorElement && isWikiNavigationClick(event, target)) this.$emit('navigate')
    },
    switchMode (mode: NavigationMode) {
      observeBrowserConnection()
      if (this.connectionUnavailable) return
      if (mode === 'browse') void retryServerConnection({ quiet: true, reusePending: true })
      this.currentMode = mode
      this.navigationFilter = ''
      try {
        window.localStorage.setItem('navPref', mode)
      } catch {
        // Navigation remains usable when browser storage is unavailable.
      }
      if (mode === 'browse' && this.loadedCache.length < 1) {
        if (this.expandParentByDefault) this.loadFromCurrentPath()
        else this.fetchBrowseItems()
      }
    },
    async fetchBrowseItems (requestedItem?: NavigationTreeItem) {
      observeBrowserConnection()
      if (this.connectionUnavailable) return
      const requestSequence = ++this.browseRequestSequence
      this.browseRequestController?.abort()
      const requestController = markRaw(new AbortController())
      this.browseRequestController = requestController
      const locale = this.locale
      loadingStart(wikiStore, 'browse-load')
      this.navLoading = true
      this.navError = ''
      const item = requestedItem || this.currentParent
      try {
        let parents: NavigationTreeItem[]
        if (item.id === 0) {
          parents = []
        } else {
          const flushRightIndex = _.findIndex(this.parents, ['id', item.id])
          parents = flushRightIndex >= 0
            ? _.take(this.parents, flushRightIndex + 1)
            : [...(this.parents.length > 0 ? this.parents : [this.currentParent]), item]
        }
        const items = await fetchPageTree(
          (url, init) => window.fetch(url, { ...init, signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(5_000)]) }),
          {
            parent: item.id,
            locale,
            mode: 'ALL'
          }
        )
        if (requestSequence !== this.browseRequestSequence) return
        this.parents = parents
        this.currentParent = item
        this.navigationFilter = ''
        this.currentItems = items
        this.loadedCache = _.union(this.loadedCache, [item.id])
      } catch (error) {
        if (!requestController.signal.aborted && requestSequence === this.browseRequestSequence) {
          if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) reportServerConnectionFailure()
          else this.navError = error instanceof Error ? error.message : this.$t('common:sidebar.navigationLoadError')
        }
      } finally {
        if (this.browseRequestController === requestController) this.browseRequestController = null
        if (requestSequence === this.browseRequestSequence) this.navLoading = false
        loadingStop(wikiStore, 'browse-load')
      }
    },
    async loadFromCurrentPath() {
      observeBrowserConnection()
      if (this.connectionUnavailable) return
      const requestSequence = ++this.browseRequestSequence
      this.browseRequestController?.abort()
      const requestController = markRaw(new AbortController())
      this.browseRequestController = requestController
      const locale = this.locale
      const path = this.path
      const pageId = wikiStore.page.id
      loadingStart(wikiStore, 'browse-load')
      this.navLoading = true
      this.navError = ''
      try {
        const items = await fetchPageTree(
          (url, init) => window.fetch(url, { ...init, signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(5_000)]) }),
          {
            path,
            locale,
            mode: 'ALL',
            includeAncestors: true,
            visibility: wikiStore.page.visibility
          }
        )
        if (requestSequence !== this.browseRequestSequence) return
        const curPage = _.find(items, ['pageId', pageId])
        if (!curPage) throw new Error(this.$t('common:sidebar.currentPageNotFound'))
        let curParentId = curPage.parent
        const invertedAncestors: PageTreeRow[] = []
        while (curParentId) {
          const curParent = _.find(items, ['id', curParentId])
          if (!curParent) break
          invertedAncestors.push(curParent)
          curParentId = curParent.parent
        }
        const parents: NavigationTreeItem[] = [
          { id: 0, title: `/ ${this.$t('common:sidebar.root')}` },
          ...invertedAncestors.reverse()
        ]
        const currentParent = parents[parents.length - 1]
        this.parents = parents
        this.currentParent = currentParent
        this.loadedCache = [curPage.parent]
        this.currentItems = _.filter(items, ['parent', curPage.parent])
      } catch (error) {
        if (!requestController.signal.aborted && requestSequence === this.browseRequestSequence) {
          if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) reportServerConnectionFailure()
          else this.navError = error instanceof Error ? error.message : this.$t('common:sidebar.navigationLoadError')
        }
      } finally {
        if (this.browseRequestController === requestController) this.browseRequestController = null
        if (requestSequence === this.browseRequestSequence) this.navLoading = false
        loadingStop(wikiStore, 'browse-load')
      }
    },
    retryBrowse () {
      if (this.currentParent.id === 0 && this.expandParentByDefault && this.loadedCache.length < 1) {
        void this.loadFromCurrentPath()
      } else {
        void this.fetchBrowseItems(this.currentParent)
      }
    },
    isCurrentCustomLink (item: Extract<SidebarItem, { k: 'link' }>) {
      if (!item.t || (item.y !== 'home' && item.y !== 'page')) return false
      try {
        const targetPath = new URL(item.t, window.location.href).pathname.replace(/\/+$/, '') || '/'
        const currentPath = window.location.pathname.replace(/\/+$/, '') || '/'
        return targetPath === currentPath
      } catch {
        return false
      }
    },
    pagePath (item: NavigationTreeItem) {
      return `${item.visibility === 'private' ? '/_private' : ''}/${item.locale}/${item.path}`
    },
    editPath (item: NavigationTreeItem) {
      return `/e${item.visibility === 'private' ? '/_private' : ''}/${item.locale}/${item.path}`
    },
    goHome () {
      this.$emit('navigate')
      navigateToWikiPage(siteLangs.length > 0 ? `/${this.locale}/home` : '/')
    }
  },
  mounted () {
    observeBrowserConnection()
    this.resetBrowseRoot()
    if (this.navMode === 'TREE') {
      this.currentMode = 'browse'
    } else if (this.navMode === 'STATIC') {
      this.currentMode = 'custom'
    } else {
      try {
        const storedPreference = window.localStorage.getItem('navPref')
        this.currentMode = storedPreference === 'browse' || storedPreference === 'custom'
          ? storedPreference
          : this.customItems.some(item => item.k === 'link') ? 'custom' : 'browse'
      } catch {
        this.currentMode = this.customItems.some(item => item.k === 'link') ? 'custom' : 'browse'
      }
    }
    if (this.currentMode === 'browse' && !this.connectionUnavailable) {
      if (this.expandParentByDefault) this.loadFromCurrentPath()
      else this.fetchBrowseItems()
    }
  },
  beforeUnmount () {
    this.browseRequestSequence += 1
    this.browseRequestController?.abort()
    this.browseRequestController = null
  }
})
</script>

<style lang="scss">
.nav-sidebar {
  min-width: 0;
  min-height: 100%;
  padding-block-end: calc(1.5rem + env(safe-area-inset-bottom));
  background: var(--wiki-chrome-surface);
  color: rgb(var(--v-theme-on-surface));

  .nav-sidebar-heading {
    display: flex;
    align-items: center;
    gap: .625rem;
    padding: 1rem;
    h2 { margin: 0; font-size: 1rem; font-weight: 700; }
  }
  .nav-sidebar-locale { margin-inline-start: auto; color: var(--wiki-text-muted); font-size: .75rem; }
  .nav-sidebar-switcher {
    align-items: center;
    gap: .375rem;
    padding: 0 .75rem .75rem;
  }
  .nav-sidebar-home {
    flex: 0 0 44px;
    width: 44px;
    min-width: 44px;
    height: 44px;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
  }
  .nav-sidebar-home--static { flex: 1 1 auto; width: auto; }
  .nav-sidebar-modes {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken);
  }
  .nav-sidebar-mode {
    flex: 1 1 0;
    min-width: 0;
    min-height: 44px;
    height: auto;
    padding: .375rem;
    border-radius: var(--wiki-control-radius);
    font-size: .8125rem;
    letter-spacing: 0;
    color: var(--wiki-text-muted);
    .v-btn__content { white-space: normal; line-height: 1.3; }
    &[aria-pressed='true'] {
      background: var(--wiki-surface-raised);
      color: var(--wiki-primary-ink);
      font-weight: 700;
      box-shadow: inset 0 -2px var(--wiki-primary-ink);
    }
  }
  .nav-sidebar-directory-heading { padding: 0 1rem .625rem; font-size: .8125rem; font-weight: 650; }
  .nav-sidebar-context { padding: 0 .75rem .5rem; }
  .nav-sidebar-root { min-height: 44px; max-width: 100%; padding-inline: .5rem; letter-spacing: 0; }
  .nav-sidebar-directory-path { margin: .25rem .5rem; color: var(--wiki-text-muted); font-size: .75rem; overflow-wrap: anywhere; }
  .nav-sidebar-filter { padding: .25rem .75rem .75rem; }
  .nav-sidebar-filter-count { margin: .375rem 0 0; color: var(--wiki-text-muted); font-size: .75rem; }
  .nav-sidebar-edge,
  .nav-sidebar-section-divider { border-color: var(--wiki-surface-border); opacity: 1; }
  .nav-sidebar-list { padding-inline: .5rem; background: transparent; }
  .nav-sidebar-subheader { min-height: 36px; padding-inline: .75rem; font-size: .75rem; font-weight: 700; color: var(--wiki-text-muted); }
  .v-list-item {
    min-height: 44px;
    min-width: 0;
    margin-block: .125rem;
    padding: .5rem .75rem;
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius);
    color: rgb(var(--v-theme-on-surface));
    .v-list-item__content { min-width: 0; }
    .v-list-item-title { overflow: visible; white-space: normal; overflow-wrap: anywhere; font-size: .875rem; line-height: 1.45; }
    .v-list-item__prepend { margin-inline-end: .625rem; color: var(--wiki-text-muted); }
    &:hover { background: var(--wiki-surface-sunken); }
    &.v-list-item--active,
    &[aria-current='page'] {
      border-color: var(--wiki-surface-border-strong);
      background: var(--wiki-surface-sunken);
      color: var(--wiki-primary-ink);
      box-shadow: inset 3px 0 var(--wiki-primary-ink);
      font-weight: 650;
    }
  }
  .nav-sidebar-ancestor-trail {
    max-height: 12rem;
    overflow-y: auto;
    padding-inline: .25rem;
    border-inline-start: 1px solid var(--wiki-surface-border);
  }
  .nav-sidebar-ancestor-icon { padding-inline-start: calc(var(--nav-depth) * .375rem); width: auto !important; }
  .nav-sidebar-ancestor .v-list-item-title { font-size: .8125rem; }
  .nav-sidebar-ancestor--current { background: var(--wiki-surface-sunken); font-weight: 650; }
  .nav-sidebar-current { min-width: 0; }
  .nav-sidebar-current-page { flex: 1 1 auto; min-width: 0; }
  .nav-sidebar-edit-parent { flex: 0 0 44px; width: 44px; min-width: 44px; height: 44px; }
  .nav-sidebar-folder-chevron { color: var(--wiki-text-muted); }
  .nav-sidebar-loading-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .nav-sidebar-loading-row { height: 44px; border-radius: var(--wiki-control-radius); background: var(--wiki-surface-sunken); }
  .nav-sidebar-progress { margin-block-end: .5rem; }
  .async-state { min-height: 8rem; margin: .5rem; background: var(--wiki-surface-raised); }
}
.v-locale--is-rtl .nav-sidebar .v-list-item[aria-current='page'] { box-shadow: inset -3px 0 var(--wiki-primary-ink); }
@media (forced-colors: active) {
  .nav-sidebar .v-list-item,
  .nav-sidebar .nav-sidebar-modes { border-color: CanvasText; }
  .nav-sidebar .nav-sidebar-mode[aria-pressed='true'] { outline: 2px solid Highlight; outline-offset: -2px; }
}
</style>
