<template lang="pug">
  div
    .pa-3.d-flex(v-if='navMode === `MIXED`', :class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-blue-darken-3`')
      v-btn(
        variant="flat"
        :color='$vuetify.theme.current.dark ? `grey-darken-4` : `blue-darken-2`'
        style='min-width:0;'
        @click='goHome'
        :aria-label='$t(`common:header.home`)'
        )
        v-icon(size='20') mdi-home
      v-btn.ml-3(
        v-if='currentMode === `custom`'
        variant="flat"
        :color='$vuetify.theme.current.dark ? `grey-darken-4` : `blue-darken-2`'
        style='flex: 1 1 100%;'
        @click='switchMode(`browse`)'
        )
        v-icon(start) mdi-file-tree
        .text-body-medium.text-none {{$t('common:sidebar.browse')}}
      v-btn.ml-3(
        v-else-if='currentMode === `browse`'
        variant="flat"
        :color='$vuetify.theme.current.dark ? `grey-darken-4` : `blue-darken-2`'
        style='flex: 1 1 100%;'
        @click='switchMode(`custom`)'
        )
        v-icon(start) mdi-navigation
        .text-body-medium.text-none {{$t('common:sidebar.mainMenu')}}
    v-divider
    //-> Custom Navigation
    v-list.py-2(v-if='currentMode === `custom`', density="compact", :class='color', role='navigation', :aria-label='$t(`common:sidebar.mainMenu`)')
      template(v-for='(item, idx) of items', :key='`${item.k}-${item.id || item.t || item.l || idx}`')
        v-list-item(
          v-if='item.k === `link`'
          :href='item.t'
          :target='item.y === `externalblank` ? `_blank` : `_self`'
          :rel='item.y === `externalblank` ? `noopener` : ``'
          )
          template(v-slot:prepend)
            v-avatar(size='24', rounded='0')
              v-icon(v-if='item.c.match(/fa[a-z] fa-/)', size='19') {{ item.c }}
              v-icon(v-else) {{ item.c }}
          v-list-item-title {{ item.l }}
        v-divider.my-2(v-else-if='item.k === `divider`')
        v-list-subheader.pl-4(v-else-if='item.k === `header`') {{ item.l }}
    //-> Browse
    v-list.py-2(v-else-if='currentMode === `browse`', density="compact", :class='color', role='navigation', :aria-label='$t(`common:sidebar.browse`)')
      template(v-if='currentParent.id > 0')
        v-list-item(v-for='(item, idx) of parents', :key='`parent-` + item.id', @click='fetchBrowseItems(item)', style='min-height: 30px;')
          template(v-slot:prepend)
            v-avatar(size='18', :style='`padding-left: ` + (idx * 8) + `px; width: auto; margin: 0 5px 0 0;`')
              v-icon(size="small") mdi-folder-open
          v-list-item-title {{ item.title }}
        v-divider.mt-2
        .d-flex.align-center.mt-2(v-if='currentParent.pageId > 0')
          v-list-item(
            :href='pagePath(currentParent)'
            :key='`directorypage-` + currentParent.id'
            :active='path === currentParent.path'
            style='min-width: 0;'
          )
            v-avatar(size='24')
              v-icon mdi-text-box
            v-list-item-title {{ currentParent.title }}
          v-btn.mr-2(
            v-if='canEditCurrentParent'
            icon
            size="small"
            :href='editPath(currentParent)'
            :aria-label='`Edit parent page ${currentParent.title}`'
          )
            v-icon(size="small") mdi-pencil
        v-list-subheader.pl-4 {{$t('common:sidebar.currentDirectory')}}
      template(v-for='item of currentItems')
        v-list-item(v-if='item.isFolder', :key='`childfolder-` + item.id', @click='fetchBrowseItems(item)')
          template(v-slot:prepend)
            v-avatar(size='24')
              v-icon mdi-folder
          v-list-item-title {{ item.title }}
        v-list-item(v-else, :href='(item.visibility === `private` ? `/_private` : ``) + `/` + item.locale + `/` + item.path', :key='`childpage-` + item.id', :active='path === item.path')
          template(v-slot:prepend)
            v-avatar(size='24')
              v-icon mdi-text-box
          v-list-item-title {{ item.title }}</template>

<script lang='ts'>
import _ from 'lodash'
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
      const item = requestedItem || this.currentParent

      if (this.loadedCache.indexOf(item.id) < 0) {
        this.currentItems = []
      }

      if (item.id === 0) {
        this.parents = []
      } else {
        const flushRightIndex = _.findIndex(this.parents, ['id', item.id])
        if (flushRightIndex >= 0) {
          this.parents = _.take(this.parents, flushRightIndex)
        }
        if (this.parents.length < 1) {
          this.parents.push(this.currentParent)
        }
        this.parents.push(item)
      }

      this.currentParent = item

      this.currentItems = await fetchPageTree(window.fetch.bind(window), {
        parent: item.id,
        locale: this.locale,
        mode: 'ALL'
      })
      this.loadedCache = _.union(this.loadedCache, [item.id])
      loadingStop(wikiStore, 'browse-load')
    },
    async loadFromCurrentPath() {
      loadingStart(wikiStore, 'browse-load')
      const items = await fetchPageTree(window.fetch.bind(window), {
        path: this.path,
        locale: this.locale,
        mode: 'ALL',
        includeAncestors: true
      })
      const curPage = _.find(items, ['pageId', wikiStore.page.id])
      if (!curPage) {
        console.warn('Could not find current page in page tree listing!')
        loadingStop(wikiStore, 'browse-load')
        return
      }

      let curParentId = curPage.parent
      const invertedAncestors: PageTreeRow[] = []
      while (curParentId) {
        const curParent = _.find(items, ['id', curParentId])
        if (!curParent) {
          break
        }
        invertedAncestors.push(curParent)
        curParentId = curParent.parent
      }

      this.parents = [this.currentParent, ...invertedAncestors.reverse()]
      this.currentParent = this.parents[this.parents.length - 1]
      this.loadedCache = [curPage.parent]
      this.currentItems = _.filter(items, ['parent', curPage.parent])
      loadingStop(wikiStore, 'browse-load')
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
