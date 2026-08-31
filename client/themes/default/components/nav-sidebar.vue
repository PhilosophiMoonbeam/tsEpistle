<template lang="pug">
  nav.nav-sidebar(:aria-label='currentMode === `browse` ? $t(`common:sidebar.browse`) : $t(`common:sidebar.mainMenu`)')
    .nav-sidebar-switcher.d-flex(v-if='navMode === `MIXED`')
      v-btn.nav-sidebar-home(
        variant="tonal"
        color='primary'
        @click='goHome'
        :aria-label='$t(`common:header.home`)'
        )
        v-icon(size='20') mdi-home
      v-btn.nav-sidebar-mode.ms-3(
        v-if='currentMode === `custom`'
        variant="tonal"
        @click='switchMode(`browse`)'
        )
        v-icon(start) mdi-file-tree
        .text-body-medium.text-none {{$t('common:sidebar.browse')}}
      v-btn.nav-sidebar-mode.ms-3(
        v-else-if='currentMode === `browse`'
        variant="tonal"
        color='primary'
        @click='switchMode(`custom`)'
        )
        v-icon(start) mdi-navigation
        .text-body-medium.text-none {{$t('common:sidebar.mainMenu')}}
    v-divider.nav-sidebar-edge
    //-> Custom Navigation
    v-list.nav-sidebar-list.py-2(v-if='currentMode === `custom`', density="compact", :class='color', nav, role='presentation')
      async-state(
        v-if='items.length === 0'
        state='empty'
        title='No navigation items'
      )
      template(v-else, v-for='(item, idx) of items', :key='`${item.k}-${item.id || item.t || item.l || idx}`')
        v-list-item(
          v-if='item.k === `link`'
          :href='item.t'
          :target='item.y === `externalblank` ? `_blank` : `_self`'
          :rel='item.y === `externalblank` ? `noopener` : ``'
          :active='isCurrentCustomLink(item)'
          :aria-current='isCurrentCustomLink(item) ? `page` : undefined'
        )
          template(v-slot:prepend)
            v-avatar(size='24', rounded='0', variant='text')
              v-icon(v-if='item.c.match(/fa[a-z] fa-/)', size='19') {{ item.c }}
              v-icon(v-else) {{ item.c }}
          v-list-item-title {{ item.l }}
        v-divider.nav-sidebar-section-divider.my-2(v-else-if='item.k === `divider`')
        v-list-subheader.nav-sidebar-subheader(v-else-if='item.k === `header`') {{ item.l }}
    //-> Browse
    v-list.nav-sidebar-list.py-2(
      v-else-if='currentMode === `browse`'
      density="compact"
      :class='color'
      nav
      role='presentation'
      :aria-busy='navLoading'
    )
      .nav-sidebar-loading-status(
        v-if='navLoading'
        role='status'
        aria-live='polite'
        aria-atomic='true'
      ) Loading navigation
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
        aria-label='Loading navigation'
      )
      async-state(
        v-else-if='navError'
        state='error'
        title='Navigation could not be loaded'
        :message='navError'
        retry-label='Try again'
        @retry='retryBrowse'
      )
      async-state(
        v-else-if='currentItems.length === 0'
        state='empty'
        title='No pages in this directory'
      )
      template(v-if='currentParent.id > 0')
        v-list-item.nav-sidebar-ancestor(v-for='(item, idx) of parents', :key='`parent-` + item.id', @click='fetchBrowseItems(item)')
          template(v-slot:prepend)
            v-avatar.nav-sidebar-ancestor-icon(size='20', variant='text', :style='{ "--nav-depth": idx }')
              v-icon(size="small") mdi-folder-open
          v-list-item-title {{ item.title }}
        v-divider.nav-sidebar-section-divider.mt-2
        .nav-sidebar-current.d-flex.align-center.mt-2(v-if='currentParent.pageId > 0')
          v-list-item.nav-sidebar-current-page(
            :href='pagePath(currentParent)'
            :key='`directorypage-` + currentParent.id'
            :active='path === currentParent.path'
            :aria-current='path === currentParent.path ? `page` : undefined'
          )
            template(v-slot:prepend)
              v-avatar(size='24', variant='text')
                v-icon mdi-text-box
            v-list-item-title {{ currentParent.title }}
          v-btn.nav-sidebar-edit-parent.me-2(
            v-if='canEditCurrentParent'
            icon
            size="small"
            :href='editPath(currentParent)'
            :aria-label='`Edit parent page ${currentParent.title}`'
          )
            v-icon(size="small") mdi-pencil
        v-list-subheader.nav-sidebar-subheader.nav-sidebar-directory-label {{$t('common:sidebar.currentDirectory')}}
      template(v-for='item of currentItems')
        v-list-item.nav-sidebar-folder(v-if='item.isFolder', :key='`childfolder-` + item.id', @click='fetchBrowseItems(item)')
          template(v-slot:prepend)
            v-avatar(size='24', variant='text')
              v-icon mdi-folder
          v-list-item-title {{ item.title }}
        v-list-item.nav-sidebar-page(v-else, :href='(item.visibility === `private` ? `/_private` : ``) + `/` + item.locale + `/` + item.path', :key='`childpage-` + item.id', :active='path === item.path', :aria-current='path === item.path ? `page` : undefined')
          template(v-slot:prepend)
            v-avatar(size='24', variant='text')
              v-icon mdi-text-box
          v-list-item-title {{ item.title }}</template>

<script lang='ts'>
import _ from 'lodash'
import AsyncState from '@/components/common/async-state.vue'
import { defineComponent, type PropType } from 'vue'
import { fetchPageTree, type PageTreeRow } from '../../../helpers/pages-api'
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
  components: { AsyncState },
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
      currentItems: [] as PageTreeRow[],
      navLoading: false,
      navError: '',
      currentParent: {
        id: 0,
        title: '/ (root)'
      } as NavigationTreeItem,
      parents: [] as NavigationTreeItem[],
      loadedCache: [] as number[]
    }
  },
  computed: {
    path () {
      return wikiStore.page.path
    },
    locale () {
      return wikiStore.page.locale
    },
    canEditCurrentParent () {
      return this.currentParent.canEdit === true && this.currentParent.pageId !== wikiStore.page.id
    }
  },
  methods: {
    switchMode (mode: NavigationMode) {
      this.currentMode = mode
      window.localStorage.setItem('navPref', mode)
      if (mode === 'browse' && this.loadedCache.length < 1) {
        if (this.expandParentByDefault) this.loadFromCurrentPath()
        else this.fetchBrowseItems()
      }
    },
    async fetchBrowseItems (requestedItem?: NavigationTreeItem) {
      loadingStart(wikiStore, 'browse-load')
      this.navLoading = true
      this.navError = ''
      const item = requestedItem || this.currentParent
      try {
        if (item.id === 0) {
          this.parents = []
        } else {
          const flushRightIndex = _.findIndex(this.parents, ['id', item.id])
          if (flushRightIndex >= 0) {
            this.parents = _.take(this.parents, flushRightIndex)
          }
          if (this.parents.length < 1) this.parents.push(this.currentParent)
          this.parents.push(item)
        }
        this.currentParent = item
        this.currentItems = await fetchPageTree(window.fetch.bind(window), {
          parent: item.id,
          locale: this.locale,
          mode: 'ALL'
        })
        this.loadedCache = _.union(this.loadedCache, [item.id])
      } catch (error) {
        this.navError = error instanceof Error ? error.message : 'Navigation could not be loaded.'
      } finally {
        this.navLoading = false
        loadingStop(wikiStore, 'browse-load')
      }
    },
    async loadFromCurrentPath() {
      loadingStart(wikiStore, 'browse-load')
      this.navLoading = true
      this.navError = ''
      try {
        const items = await fetchPageTree(window.fetch.bind(window), {
          path: this.path,
          locale: this.locale,
          mode: 'ALL',
          includeAncestors: true
        })
        const curPage = _.find(items, ['pageId', wikiStore.page.id])
        if (!curPage) throw new Error('Could not find the current page in navigation.')
        let curParentId = curPage.parent
        const invertedAncestors: PageTreeRow[] = []
        while (curParentId) {
          const curParent = _.find(items, ['id', curParentId])
          if (!curParent) break
          invertedAncestors.push(curParent)
          curParentId = curParent.parent
        }
        this.parents = [this.currentParent, ...invertedAncestors.reverse()]
        this.currentParent = this.parents[this.parents.length - 1]
        this.loadedCache = [curPage.parent]
        this.currentItems = _.filter(items, ['parent', curPage.parent])
      } catch (error) {
        this.navError = error instanceof Error ? error.message : 'Navigation could not be loaded.'
      } finally {
        this.navLoading = false
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
      window.location.assign(siteLangs.length > 0 ? `/${this.locale}/home` : '/')
    }
  },
  mounted () {
    this.currentParent.title = `/ ${this.$t('common:sidebar.root')}`
    if (this.navMode === 'TREE') {
      this.currentMode = 'browse'
    } else if (this.navMode === 'STATIC') {
      this.currentMode = 'custom'
    } else {
      this.currentMode = (window.localStorage.getItem('navPref') || 'custom') as NavigationMode
    }
    if (this.currentMode === 'browse') {
      if (this.expandParentByDefault) this.loadFromCurrentPath()
      else this.fetchBrowseItems()
    }
  }
})
</script>

<style lang="scss">
.nav-sidebar {
  --nav-active-direction: 90deg;
  display: block;
  min-height: 100%;
  padding-block-end: calc(var(--wiki-space-8) + env(safe-area-inset-bottom));
  color: rgb(var(--v-theme-on-surface));

  .nav-sidebar-edge,
  .nav-sidebar-section-divider {
    margin-inline: var(--wiki-space-3);
    border-color: var(--wiki-surface-border);
    opacity: 1;
  }

  .nav-sidebar-list {
    padding-inline: var(--wiki-space-3);
    background: transparent;
  }

  .async-state {
    min-height: 9rem;
    margin-block: var(--wiki-space-2);
    border-color: var(--wiki-surface-border);
    background: color-mix(in srgb, var(--wiki-surface-sunken) 76%, transparent);
  }
  .nav-sidebar-loading-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .nav-sidebar-loading-row {
    height: var(--wiki-control-height);
    min-height: var(--wiki-control-height);
    margin-block: var(--wiki-space-1);
    overflow: hidden;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-control-radius);
    background: var(--wiki-surface-sunken);

    .v-skeleton-loader__avatar {
      width: 24px;
      height: 24px;
    }

    .v-skeleton-loader__text {
      height: .7rem;
    }
  }

  .nav-sidebar-progress {
    margin-block: 0 var(--wiki-space-2);
    border-radius: var(--wiki-radius-pill);
  }


  .v-list-item {
    position: relative;
    min-height: var(--wiki-control-height);
    margin-block: var(--wiki-space-1);
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent);
    opacity: 1;
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease),
      box-shadow var(--wiki-motion-fast) var(--wiki-motion-ease);

    &::before {
      position: absolute;
      top: var(--wiki-space-2);
      bottom: var(--wiki-space-2);
      inset-inline-start: 0;
      width: var(--wiki-space-1);
      transform: scaleY(.35);
      border-radius: 0 var(--wiki-radius-pill) var(--wiki-radius-pill) 0;
      background: var(--wiki-ambient-accent);
      opacity: 0;
      transition:
        transform var(--wiki-motion-normal) var(--wiki-motion-ease-out),
        opacity var(--wiki-motion-fast) var(--wiki-motion-ease);
      content: '';
    }

    &:hover {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 16%, transparent);
      background: color-mix(in srgb, var(--wiki-ambient-accent) 7%, transparent);
      color: rgb(var(--v-theme-on-surface));
    }

    &:focus-visible {
      border-color: color-mix(in srgb, var(--wiki-focus-color) 48%, transparent);
      background: color-mix(in srgb, var(--wiki-focus-color) 7%, transparent);
    }

    &.v-list-item--active,
    &[aria-current='page'] {
      border-color: color-mix(in srgb, var(--wiki-accent-warm) 20%, transparent);
      background:
        linear-gradient(
          var(--nav-active-direction),
          color-mix(in srgb, var(--wiki-accent-warm) 12%, transparent),
          color-mix(in srgb, var(--wiki-accent-spectral) 7%, transparent)
        );
      color: var(--wiki-accent-warm);
      font-weight: 680;
      box-shadow: var(--wiki-shadow-xs);

      &::before {
        transform: scaleY(1);
        opacity: 1;
      }
    }

    &.v-list-item--disabled {
      background: transparent;
      color: rgb(var(--v-theme-on-surface));
      opacity: .4;
      box-shadow: none;
    }

    .v-list-item-title {
      overflow: hidden;
      font-size: .875rem;
      letter-spacing: .002em;
      line-height: 1.35;
      text-overflow: ellipsis;
    }

    .v-list-item__prepend {
      color: currentColor;

      > .v-avatar,
      > .v-icon {
        margin-inline-end: var(--wiki-space-3);
        color: currentColor;
        opacity: .74;
      }
    }
  }

  .nav-sidebar-folder .v-icon {
    color: var(--wiki-accent-spectral);
  }

  .nav-sidebar-page .v-icon,
  .nav-sidebar-current-page .v-icon {
    color: var(--wiki-accent-warm);
  }

  .nav-sidebar-ancestor {
    min-height: calc(var(--wiki-control-height) - var(--wiki-space-2));
    margin-block: 0;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 60%, transparent);

    .v-list-item-title {
      font-size: .8125rem;
      font-weight: 580;
    }
  }

  .nav-sidebar-ancestor-icon {
    width: auto !important;
    margin-inline: 0 var(--wiki-space-1) !important;
    padding-inline-start: calc(var(--nav-depth) * var(--wiki-space-2));
    color: var(--wiki-accent-spectral);
  }

  .nav-sidebar-current {
    min-width: 0;
    padding-inline-start: var(--wiki-space-1);
    border-inline-start: 1px solid var(--wiki-surface-border);

    .nav-sidebar-current-page {
      flex: 1 1 auto;
      min-width: 0;
    }
  }

  .nav-sidebar-edit-parent {
    flex: 0 0 auto;
    width: calc(var(--wiki-control-height) - var(--wiki-space-2));
    min-width: calc(var(--wiki-control-height) - var(--wiki-space-2));
    height: calc(var(--wiki-control-height) - var(--wiki-space-2));
    border: 1px solid transparent;
    border-radius: var(--wiki-control-radius);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, transparent);

    &:hover {
      border-color: color-mix(in srgb, var(--wiki-accent-warm) 20%, transparent);
      background: color-mix(in srgb, var(--wiki-accent-warm) 8%, transparent);
      color: var(--wiki-accent-warm);
    }
  }

  .nav-sidebar-subheader {
    min-height: var(--wiki-space-8);
    padding-inline: var(--wiki-space-4);
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 52%, transparent);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .085em;
    text-transform: uppercase;
  }

  .nav-sidebar-directory-label {
    margin-block-start: var(--wiki-space-2);
    color: color-mix(in srgb, var(--wiki-ambient-accent) 68%, rgb(var(--v-theme-on-surface)));
  }
}

.nav-sidebar-switcher {
  min-height: calc(var(--wiki-control-height) + (var(--wiki-space-3) * 2));
  align-items: center;
  padding: var(--wiki-space-3);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--wiki-accent-warm) 8%, var(--wiki-surface-raised)),
      color-mix(in srgb, var(--wiki-accent-spectral) 5%, var(--wiki-surface-raised))
    );

  .v-btn {
    min-height: var(--wiki-control-height);
    border: 1px solid color-mix(in srgb, var(--wiki-ambient-accent) 16%, transparent);
    border-radius: var(--wiki-control-radius);
    font-weight: 650;
    letter-spacing: .005em;
    box-shadow: var(--wiki-shadow-xs);
    transition:
      border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover {
      border-color: color-mix(in srgb, var(--wiki-ambient-accent) 36%, transparent);
      background: color-mix(in srgb, var(--wiki-ambient-accent) 12%, transparent);
    }

    &.v-btn--disabled {
      opacity: .4;
    }
  }

  .nav-sidebar-home {
    flex: 0 0 var(--wiki-control-height);
    width: var(--wiki-control-height);
    min-width: var(--wiki-control-height);
    padding: 0;
  }

  .nav-sidebar-mode {
    flex: 1 1 100%;
    min-width: 0;
  }
}

.v-locale--is-rtl .nav-sidebar {
  --nav-active-direction: 270deg;

  .v-list-item::before {
    border-radius: var(--wiki-radius-pill) 0 0 var(--wiki-radius-pill);
  }
}

.v-theme--dark .nav-sidebar {
  .v-list-item.v-list-item--active,
  .v-list-item[aria-current='page'] {
    border-color: color-mix(in srgb, var(--wiki-accent-spectral) 26%, transparent);
    background:
      linear-gradient(
        var(--nav-active-direction),
        color-mix(in srgb, var(--wiki-accent-warm) 15%, transparent),
        color-mix(in srgb, var(--wiki-accent-spectral) 10%, transparent)
      );
  }
}

@media (max-width: 599px) {
  .nav-sidebar {
    padding-block-end: calc(var(--wiki-space-6) + env(safe-area-inset-bottom));

    .nav-sidebar-list {
      padding-inline: var(--wiki-space-2);
    }

    .v-list-item {
      min-height: var(--wiki-control-height);
    }
  }

  .nav-sidebar-switcher {
    padding: var(--wiki-space-2);

    .nav-sidebar-mode {
      margin-inline-start: var(--wiki-space-2) !important;
    }
  }
}

@media (hover: none) and (pointer: coarse) {
  .nav-sidebar {
    .v-list-item {
      min-height: var(--wiki-control-height);
    }

    .nav-sidebar-ancestor {
      min-height: var(--wiki-control-height);
    }
  }
}

@media (forced-colors: active) {
  .nav-sidebar .v-list-item,
  .nav-sidebar-switcher .v-btn {
    border-color: CanvasText;
  }

  .nav-sidebar .v-list-item::before {
    background: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-sidebar .v-list-item,
  .nav-sidebar .v-list-item::before,
  .nav-sidebar-switcher .v-btn {
    transition-duration: .01ms !important;
  }
}
</style>
