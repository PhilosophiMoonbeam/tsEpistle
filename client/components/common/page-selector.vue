<template lang="pug">
  v-dialog(
    v-model='isShown'
    max-width='850px'
    scrim='blue-darken-4'
    style='--v-overlay-opacity: .7'
    )
    v-card.page-selector
      .dialog-header.is-blue
        v-icon.mr-3(color='white') mdi-page-next-outline
        .text-body-large(v-if='mode === `create`') {{$t('common:pageSelector.createTitle')}}
        .text-body-large(v-else-if='mode === `move`') {{$t('common:pageSelector.moveTitle')}}
        .text-body-large(v-else-if='mode === `select`') {{$t('common:pageSelector.selectTitle')}}
        v-spacer
        v-progress-circular(
          indeterminate
          color='white'
          :size='20'
          :width='2'
          v-show='searchLoading'
          aria-label='Loading pages'
          )
      .d-flex
        v-col(cols='5', :class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-grey-lighten-3`')
          v-toolbar(color="grey-darken-3", density="compact", flat)
            .text-body-medium {{$t('common:pageSelector.virtualFolders')}}
            v-spacer
            v-btn(icon, rounded='0', href='https://docs.requarks.io/guide/pages#folders', target='_blank')
              v-icon mdi-help-box
          div(style='height:400px;')
            vue-scroll(:ops='scrollStyle')
              v-treeview(
                :key='`pageTree-` + treeViewCacheId'
                v-model:activated='currentNode'
                v-model:opened='openNodes'
                :items='tree'
                :load-children='fetchFolders'
                density="compact"
                expand-icon='mdi-menu-down-outline'
                item-value='id'
                item-title='title'
                activatable
                hoverable
                )
                template(v-slot:prepend='{ isOpen }')
                  v-icon mdi-{{ isOpen ? 'folder-open' : 'folder' }}
        v-col(cols='7')
          v-toolbar(color="blue-darken-2", density="compact", flat)
            .text-body-medium {{$t('common:pageSelector.pages')}}
            //- v-spacer
            //- v-btn(icon, rounded='0', disabled): v-icon mdi-content-save-move-outline
            //- v-btn(icon, rounded='0', disabled): v-icon mdi-trash-can-outline
          div(v-if='currentPages.length > 0', style='height:400px;')
            vue-scroll(:ops='scrollStyle')
              v-list.py-0(density="compact")
                template(v-for='(page, idx) of currentPages', :key='`page-` + page.id')
                  v-list-item(
                    :value='page'
                    :active='currentPage?.id === page.id'
                    @click='currentPage = page'
                  )
                    template(v-slot:prepend): v-icon mdi-text-box
                    v-list-item-title {{page.title}}
                  v-divider(v-if='idx < currentPages.length - 1')
          v-alert.animated.fadeIn(
            v-else
            text
            color='orange'
            prominent
            icon='mdi-alert'
            )
            .text-body-medium {{$t('common:pageSelector.folderEmptyWarning')}}
      v-card-actions.pa-2(:class='$vuetify.theme.current.dark ? `bg-grey-darken-2` : `bg-grey-lighten-1`', v-if='!mustExist')
        v-select(
          variant="solo"
          flat
          bg-color='grey-darken-3'
          hide-details
          single-line
          :items='namespaces'
          style='flex: 0 0 100px; border-radius: 4px 0 0 4px;'
          v-model='currentLocale'
          )
        v-text-field(
          ref='pathIpt'
          variant="solo"
          hide-details
          prefix='/'
          v-model='currentPath'
          flat
          clearable
          style='border-radius: 0 4px 4px 0;'
        )
      div.v-card-chin
        v-spacer
        v-btn(variant="text", @click='close') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='primary', @click='open', :disabled='!isValidPath')
          v-icon(start) mdi-check
          span {{$t('common:actions.select')}}</template>

<script lang='ts'>
import { defineComponent, type PropType } from 'vue'
import _ from 'lodash'
import { fetchPageTree, type PageTreeRow } from '../../helpers/pages-api'

const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i

type PageSelectorMode = 'create' | 'move' | 'select'
type PageSelection = { locale: string, path: string, id: number }
type OpenHandler = (selection: PageSelection) => boolean | void | Promise<boolean | void>
type PageTreeItem = PageTreeRow & { children?: PageTreeItem[] }
type PageEntry = PageTreeRow & { pageId: number }

function createRootNode (locale: string): PageTreeItem {
  return {
    id: 0,
    path: '',
    title: '/ (root)',
    isFolder: true,
    pageId: null,
    parent: 0,
    locale,
    visibility: 'public',
    ownerId: null,
    children: []
  }
}

function isPageEntry (item: PageTreeRow): item is PageEntry {
  return item.pageId !== null && item.pageId > 0
}

function isPageTreeItem (item: unknown): item is PageTreeItem {
  return typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'number'
}

/* global siteLangs, siteConfig */

export default defineComponent({
  emits: ['update:modelValue'],
  props: {
    modelValue: {
      type: Boolean,
      default: false
    },
    path: {
      type: String,
      default: 'new-page'
    },
    locale: {
      type: String,
      default: 'en'
    },
    mode: {
      type: String as PropType<PageSelectorMode>,
      default: 'create'
    },
    openHandler: {
      type: Function as PropType<OpenHandler>,
      default: () => undefined
    },
    mustExist: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      treeViewCacheId: 0,
      searchLoading: false,
      currentLocale: siteConfig.lang,
      currentFolderPath: '',
      currentPath: 'new-page' as string | null,
      currentPage: null as PageEntry | null,
      currentNode: [0] as number[],
      openNodes: [0] as number[],
      tree: [createRootNode(siteConfig.lang)] as PageTreeItem[],
      pages: [] as PageEntry[],
      all: [] as PageTreeRow[],
      namespaces: siteLangs.length ? siteLangs.map(ns => ns.code) : [siteConfig.lang],
      scrollStyle: {
        vuescroll: {},
        scrollPanel: {
          initialScrollX: 0.01, // fix scrollbar not disappearing on load
          scrollingX: false,
          speed: 50
        },
        rail: {
          gutterOfEnds: '2px'
        },
        bar: {
          onlyShowBarOnScroll: false,
          background: '#999',
          hoverStyle: {
            background: '#64B5F6'
          }
        }
      }
    }
  },
  computed: {
    isShown: {
      get(): boolean { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    currentPages (): PageEntry[] {
      return _.sortBy(_.filter(this.pages, ['parent', _.head(this.currentNode) ?? 0]), ['title', 'path'])
    },
    isValidPath (): boolean {
      if (!this.currentPath) {
        return false
      }
      if (this.mustExist && !this.currentPage) {
        return false
      }
      const firstSection = _.head(this.currentPath.split('/'))
      if (!firstSection || firstSection.length <= 1) {
        return false
      } else if (localeSegmentRegex.test(firstSection)) {
        return false
      } else if (
        _.some(['login', 'logout', 'register', 'verify', 'favicons', 'fonts', 'img', 'js', 'svg'], p => {
          return p === firstSection
        })) {
        return false
      } else {
        return true
      }
    }
  },
  watch: {
    isShown (newValue: boolean, oldValue: boolean) {
      if (newValue && !oldValue) {
        this.currentPath = this.path
        const localeChanged = this.currentLocale !== this.locale
        this.currentLocale = this.locale
        if (!localeChanged) {
          this.reloadTree(this.locale).catch(err => console.warn(err))
        }
        _.delay(() => {
          ;(this.$refs.pathIpt as { focus: () => void }).focus()
        }, 0)
      }
    },
    currentNode (newValue: number[], oldValue: number[]) {
      if (newValue.length < 1) { // force a selection
        this.$nextTick(() => {
          this.currentNode = oldValue
        })
      } else {
        const current = _.find(this.all, ['id', newValue[0]])

        if (this.openNodes.indexOf(newValue[0]) < 0) { // auto open and load children
          if (current) {
            if (this.openNodes.indexOf(current.parent) < 0) {
              this.$nextTick(() => {
                this.openNodes.push(current.parent)
              })
            }
          }
          this.$nextTick(() => {
            this.openNodes.push(newValue[0])
          })
        }

        this.currentPath = _.compact([current?.path ?? '', _.last(this.currentPath?.split('/') ?? [])]).join('/')
      }
    },
    currentPage (newValue: PageEntry | null) {
      if (newValue) {
        this.currentPath = newValue.path
      }
    },
    currentLocale (newValue: string) {
      this.reloadTree(newValue).catch(err => console.warn(err))
    }
  },
  methods: {
    close(): void {
      this.isShown = false
    },
    open(): void {
      if (!this.currentPath) return
      const exit = this.openHandler?.({
        locale: this.currentLocale,
        path: this.currentPath,
        id: (this.mustExist && this.currentPage) ? this.currentPage.pageId : 0
      })
      if (exit !== false) {
        this.close()
      }
    },
    async reloadTree (locale: string): Promise<void> {
      const root = createRootNode(locale)
      this.tree = [root]
      this.currentNode = [0]
      this.openNodes = [0]
      this.currentPage = null
      this.pages = []
      this.all = []
      this.treeViewCacheId += 1
      await this.fetchFolders(root)
    },
    async fetchFolders (item: unknown): Promise<void> {
      if (!isPageTreeItem(item)) {
        throw new TypeError('Invalid page tree item')
      }
      this.searchLoading = true
      try {
        const items = await fetchPageTree(window.fetch.bind(window), {
          parent: item.id,
          mode: 'ALL',
          locale: this.currentLocale
        })
        if (item.locale !== this.currentLocale) return
        const itemFolders: PageTreeItem[] = items.filter(item => item.isFolder).map(folder => ({ ...folder, children: [] }))
        const itemPages = items.filter(isPageEntry)
        item.children = itemFolders.length > 0 ? itemFolders : undefined
        this.pages = _.unionBy(this.pages, itemPages, 'id')
        this.all = _.unionBy(this.all, items, 'id')
      } finally {
        this.searchLoading = false
      }
    }
  }
})
</script>

<style lang='scss'>

.page-selector {
  .v-treeview .v-list-item-title {
    font-size: 13px;
  }
  .v-treeview .v-list-item {
    cursor: pointer;
  }
}

</style>
