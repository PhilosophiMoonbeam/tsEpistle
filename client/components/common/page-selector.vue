<template lang="pug">
  v-dialog(
    v-model='isShown'
    max-width='850px'
    :fullscreen='$vuetify.display.smAndDown'
    scrim='surface'
    style='--v-overlay-opacity: .7'
    :aria-labelledby='titleId'
    :persistent='isSubmitting'
    @after-enter='focusPath'
  )
    v-card.page-selector
      .dialog-header
        v-icon.mr-3(color='primary' aria-hidden='true') mdi-page-next-outline
        h2.text-body-large(v-if='mode === `create`' :id='titleId' ref='dialogTitle' tabindex='-1') {{$t('common:pageSelector.createTitle')}}
        h2.text-body-large(v-else-if='mode === `move`' :id='titleId' ref='dialogTitle' tabindex='-1') {{$t('common:pageSelector.moveTitle')}}
        h2.text-body-large(v-else-if='mode === `select`' :id='titleId' ref='dialogTitle' tabindex='-1') {{$t('common:pageSelector.selectTitle')}}
        v-spacer
        v-progress-circular(
          v-if='searchLoading'
          indeterminate
          color='primary'
          :size='20'
          :width='2'
          aria-hidden='true'
        )
      v-row.page-selector__panes(gap='0')
        v-col.page-selector__pane.page-selector__tree-pane(cols='12' md='5')
          v-toolbar(color='surface-variant' density='compact' flat)
            h3.page-selector__folders-label.text-body-medium(:id='foldersId') {{$t('common:pageSelector.virtualFolders')}}
            v-spacer
            v-tooltip(location='top')
              template(v-slot:activator='{ props }')
                v-btn(v-bind='props' icon rounded='0' href='https://docs.requarks.io/guide/pages#folders' target='_blank' rel='noopener noreferrer' aria-label='Open virtual folders help')
                  v-icon mdi-help-box-outline
              span {{$t('common:pageSelector.virtualFolders')}}
          div.page-selector__scroller(role='region' :aria-labelledby='foldersId' :aria-busy='searchLoading ? `true` : undefined')
            vue-scroll(:ops='scrollStyle')
              .page-selector__folder-errors(
                v-if='folderLoadFailureList.length > 0'
                role='status'
                aria-live='polite'
                aria-atomic='false'
              )
                v-alert.page-selector__folder-error(
                  v-for='failure in folderLoadFailureList'
                  :key='failure.key'
                  type='error'
                  variant='tonal'
                  density='compact'
                  :title='`Could not load ${failure.item.title}`'
                  :text='failure.message'
                )
                  template(v-slot:append)
                    v-btn(
                      variant='text'
                      size='small'
                      :aria-label='`Try loading ${failure.item.title} again`'
                      :loading='isFolderRetrying(failure)'
                      @click='retryFolderLoad(failure)'
                    ) Try again
              v-treeview(
                :key='`pageTree-` + treeViewCacheId'
                v-model:activated='currentNode'
                v-model:opened='openNodes'
                :items='tree'
                :load-children='fetchFolders'
                :aria-labelledby='foldersId'
                density='compact'
                expand-icon='mdi-menu-down-outline'
                item-value='id'
                item-title='title'
                activatable
                mandatory
                hoverable
              )
                template(v-slot:prepend='{ isOpen }')
                  v-icon(aria-hidden='true') mdi-{{ isOpen ? 'folder-open' : 'folder' }}
        v-col.page-selector__pane.page-selector__pages-pane(cols='12' md='7')
          v-toolbar(color='surface-variant' density='compact' flat)
            h3.text-body-medium(:id='pagesId') {{$t('common:pageSelector.pages')}}
          div.page-selector__scroller(role='region' :aria-labelledby='pagesId' :aria-busy='currentFolderLoading && currentPages.length > 0 ? `true` : undefined')
            async-state(
              v-if='currentFolderLoading && currentPages.length === 0'
              state='loading'
              title='Loading pages'
              message='Loading pages in the selected folder.'
            )
            v-list.py-0(
              v-else-if='currentPages.length > 0'
              v-model:activated='currentPageIds'
              density='compact'
              activatable
              :aria-labelledby='pagesId'
              mandatory
            )
              template(v-for='(page, idx) of currentPages' :key='`page-` + page.id')
                v-list-item(:value='page.id')
                  template(v-slot:prepend): v-icon aria-hidden='true' mdi-text-box-outline
                  v-list-item-title {{page.title}}
                v-divider(v-if='idx < currentPages.length - 1')
            async-state(
              v-else-if='currentFolderFailure'
              state='error'
              :title='`Could not load ${currentFolderFailure.item.title}`'
              :message='currentFolderFailure.message'
              retry-label='Try again'
              :announce='false'
              @retry='retryCurrentFolderLoad'
            )
            async-state(
              v-else-if='!currentFolderFailure'
              state='empty'
              :title='$t(`common:pageSelector.folderEmptyWarning`)'
              :message='$t(`common:pageSelector.pages`)'
            )
      v-card-actions.page-selector__options.pa-2(v-if='!mustExist || allowLocaleChange')
        v-select(
          v-model='currentLocale'
          variant='solo'
          flat
          bg-color='surface-variant'
          hide-details
          single-line
          :items='namespaces'
          label='Locale'
          aria-label='Page locale'
          :disabled='isSubmitting'
        )
        v-text-field(
          ref='pathIpt'
          v-model='currentPath'
          variant='solo'
          hide-details
          prefix='/'
          label='Page path'
          aria-label='Page path'
          flat
          :readonly='mustExist'
          clearable
          :disabled='isSubmitting'
        )
      div.v-card-chin.page-selector__chin
        v-alert.page-selector__submission-error(v-if='submissionError' type='error' variant='tonal' density='compact' role='alert') {{ submissionError }}
        v-spacer
        v-btn(variant='text' :disabled='isSubmitting' @click='close') {{$t('common:actions.cancel')}}
        v-btn.px-4(color='primary' :loading='isSubmitting' @click='open' :disabled='!isValidPath || isSubmitting')
          v-icon(start) mdi-check
          span {{$t('common:actions.select')}}</template>

<script lang='ts'>
import { defineComponent, markRaw, type PropType, useId } from 'vue'
import { fetchPageTree, type PageTreeRow } from '../../helpers/pages-api'
import { getErrorMessage } from '../../helpers/root-ui-store'
import AsyncState from './async-state.vue'

const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i

type PageSelectorMode = 'create' | 'move' | 'select'
type PageSelection = { locale: string, path: string, id: number }
type OpenHandler = (selection: PageSelection) => boolean | void | Promise<boolean | void>
type PageTreeItem = PageTreeRow & { treeId: number, children?: PageTreeItem[] }
type PageEntry = PageTreeRow & { pageId: number }
type FolderLoadFailure = { key: string, item: PageTreeItem, message: string, requestId: number }

function createRootNode (locale: string, treeId: number): PageTreeItem {
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
    treeId,
    children: []
  }
}

function isPageEntry (item: PageTreeRow): item is PageEntry {
  return item.pageId !== null && item.pageId > 0
}

function isPageTreeItem (item: unknown): item is PageTreeItem {
  return typeof item === 'object' && item !== null &&
    typeof (item as { id?: unknown }).id === 'number' &&
    typeof (item as { treeId?: unknown }).treeId === 'number'
}

function comparePageEntries (left: PageEntry, right: PageEntry): number {
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}

function appendUniqueById<T extends { id: number }> (current: T[], additions: T[]): T[] {
  const ids = new Set(current.map(item => item.id))
  return current.concat(additions.filter(item => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  }))
}

/* global siteLangs, siteConfig */

export default defineComponent({
  components: { AsyncState },
  emits: ['update:modelValue'],
  props: {
    modelValue: { type: Boolean, default: false },
    path: { type: String, default: 'new-page' },
    locale: { type: String, default: 'en' },
    mode: { type: String as PropType<PageSelectorMode>, default: 'create' },
    openHandler: { type: Function as PropType<OpenHandler>, default: () => undefined },
    mustExist: { type: Boolean, default: false },
    allowLocaleChange: { type: Boolean, default: false }
  },
  setup() {
    const id = useId()
    return {
      foldersId: `${id}-folders`,
      pagesId: `${id}-pages`,
      titleId: `${id}-title`
    }
  },
  data() {
    return {
      treeViewCacheId: 0,
      pendingRequests: 0,
      folderLoadFailures: {} as Record<string, FolderLoadFailure>,
      folderRequestIds: {} as Record<string, number>,
      folderPendingRequestIds: {} as Record<string, number>,
      folderRequestSequence: 0,
      submissionError: '',
      isSubmitting: false,
      currentLocale: siteConfig.lang,
      currentPath: 'new-page' as string | null,
      currentPage: null as PageEntry | null,
      currentNode: [0] as number[],
      openNodes: [0] as number[],
      tree: [createRootNode(siteConfig.lang, 0)] as PageTreeItem[],
      pages: [] as PageEntry[],
      all: [] as PageTreeRow[],
      namespaces: markRaw(siteLangs.length ? siteLangs.map(ns => ns.code) : [siteConfig.lang]),
      scrollStyle: markRaw({
        scrollPanel: { scrollingX: false }
      }),
      treeAbortController: null as AbortController | null,
      submissionRequestId: 0
    }
  },
  computed: {
    isShown: {
      get(): boolean { return this.modelValue },
      set(val: boolean) { this.$emit('update:modelValue', val) }
    },
    searchLoading(): boolean { return this.pendingRequests > 0 },
    folderLoadFailureList(): FolderLoadFailure[] {
      return Object.values(this.folderLoadFailures)
    },
    currentFolderRequestKey(): string | null {
      const nodeId = this.currentNode[0]
      return nodeId === undefined ? null : `${this.treeViewCacheId}:${nodeId}`
    },
    currentFolderFailure(): FolderLoadFailure | null {
      return this.currentFolderRequestKey ? this.folderLoadFailures[this.currentFolderRequestKey] ?? null : null
    },
    currentFolderLoading(): boolean {
      return this.currentFolderRequestKey ? this.folderPendingRequestIds[this.currentFolderRequestKey] !== undefined : false
    },
    currentPages (): PageEntry[] {
      const parentId = this.currentNode[0] ?? 0
      return this.pages.filter(page => page.parent === parentId).sort(comparePageEntries)
    },
    currentPageIds: {
      get(): number[] { return this.currentPage ? [this.currentPage.id] : [] },
      set(value: number[]) {
        this.currentPage = this.currentPages.find(page => page.id === value[0]) ?? null
      }
    },
    isValidPath (): boolean {
      if (!this.currentPath || (this.mustExist && !this.currentPage)) return false
      const firstSection = this.currentPath.split('/')[0]
      if (!firstSection || firstSection.length <= 1 || localeSegmentRegex.test(firstSection)) return false
      return !['login', 'logout', 'register', 'verify', 'favicons', 'fonts', 'img', 'js', 'svg'].includes(firstSection)
    }
  },
  watch: {
    isShown: {
      immediate: true,
      handler(newValue: boolean, oldValue: boolean | undefined) {
        if (newValue && !oldValue) {
          this.currentPath = this.path
          this.submissionError = ''
          const localeChanged = this.currentLocale !== this.locale
          this.currentLocale = this.locale
          if (!localeChanged) void this.reloadTree(this.locale)
        } else if (!newValue && oldValue) {
          this.treeViewCacheId += 1
          this.treeAbortController?.abort()
          this.treeAbortController = null
          this.pendingRequests = 0
        }
      }
    },
    currentNode (newValue: number[], oldValue: number[]) {
      const nodeId = newValue[0]
      if (nodeId === undefined) {
        void this.$nextTick(() => { this.currentNode = oldValue })
        return
      }
      const current = this.all.find(item => item.id === nodeId)
      const opened = new Set(this.openNodes)
      if (current) opened.add(current.parent)
      opened.add(nodeId)
      this.openNodes = [...opened]
      this.currentPage = null
      const pathParts = this.currentPath?.split('/') ?? []
      this.currentPath = [current?.path ?? '', pathParts[pathParts.length - 1] ?? ''].filter(Boolean).join('/')
    },
    currentPage (newValue: PageEntry | null) {
      if (newValue) this.currentPath = newValue.path
    },
    currentLocale (newValue: string) {
      void this.reloadTree(newValue)
    }
  },
  beforeUnmount() {
    this.submissionRequestId += 1
    this.treeViewCacheId += 1
    this.treeAbortController?.abort()
    this.treeAbortController = null
  },
  methods: {
    focusPath(): void {
      const input = this.$refs.pathIpt as { focus?: () => void } | undefined
      if (input?.focus) {
        input.focus()
        return
      }
      const title = this.$refs.dialogTitle
      if (title instanceof HTMLElement) title.focus()
    },
    close(): void {
      if (!this.isSubmitting) this.isShown = false
    },
    async open(): Promise<void> {
      if (!this.currentPath || !this.isValidPath || this.isSubmitting) return
      const requestId = ++this.submissionRequestId
      this.submissionError = ''
      this.isSubmitting = true
      try {
        const exit = await this.openHandler?.({
          locale: this.currentLocale,
          path: this.currentPath,
          id: (this.mustExist && this.currentPage) ? this.currentPage.pageId : 0
        })
        if (requestId === this.submissionRequestId && exit !== false) this.isShown = false
      } catch (err) {
        if (requestId === this.submissionRequestId) {
          this.submissionError = getErrorMessage(err) || 'The page selection could not be completed.'
        }
      } finally {
        if (requestId === this.submissionRequestId) this.isSubmitting = false
      }
    },
    async reloadTree (locale: string): Promise<void> {
      this.treeAbortController?.abort()
      this.treeAbortController = new AbortController()
      this.treeViewCacheId += 1
      const root = createRootNode(locale, this.treeViewCacheId)
      this.pendingRequests = 0
      this.folderLoadFailures = {}
      this.folderRequestIds = {}
      this.folderPendingRequestIds = {}
      this.tree = [root]
      this.currentNode = [0]
      this.openNodes = [0]
      this.currentPage = null
      this.pages = []
      this.all = []
      await this.fetchFolders(root)
    },
    isFolderRetrying(failure: FolderLoadFailure): boolean {
      return this.folderPendingRequestIds[failure.key] !== undefined
    },
    retryCurrentFolderLoad(): void {
      if (this.currentFolderFailure) this.retryFolderLoad(this.currentFolderFailure)
    },
    retryFolderLoad(failure: FolderLoadFailure): void {
      if (failure.item.treeId !== this.treeViewCacheId || this.isFolderRetrying(failure)) return
      void this.fetchFolders(failure.item)
    },
    async fetchFolders (item: unknown): Promise<void> {
      if (!isPageTreeItem(item)) throw new TypeError('Invalid page tree item')
      const requestLocale = this.currentLocale
      const requestTreeId = item.treeId
      if (requestTreeId !== this.treeViewCacheId) return
      const controller = this.treeAbortController
      if (!controller || controller.signal.aborted) return
      const requestKey = `${requestTreeId}:${item.id}`
      const requestId = ++this.folderRequestSequence
      this.folderRequestIds[requestKey] = requestId
      this.folderPendingRequestIds[requestKey] = requestId
      this.pendingRequests += 1
      try {
        const items = await fetchPageTree(
          (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
          { parent: item.id, mode: 'ALL', locale: requestLocale }
        )
        if (
          requestTreeId !== this.treeViewCacheId ||
          item.locale !== this.currentLocale ||
          requestLocale !== this.currentLocale ||
          this.folderRequestIds[requestKey] !== requestId
        ) return
        const itemFolders: PageTreeItem[] = items.filter(item => item.isFolder).map(folder => ({ ...folder, treeId: requestTreeId, children: [] }))
        const itemPages = items.filter(isPageEntry)
        item.children = itemFolders.length > 0 ? itemFolders : undefined
        this.pages = appendUniqueById(this.pages, itemPages)
        this.all = appendUniqueById(this.all, items)
        delete this.folderLoadFailures[requestKey]
      } catch (err) {
        if (controller.signal.aborted) return
        if (
          requestTreeId === this.treeViewCacheId &&
          requestLocale === this.currentLocale &&
          this.folderRequestIds[requestKey] === requestId
        ) {
          this.folderLoadFailures[requestKey] = {
            key: requestKey,
            item,
            message: getErrorMessage(err) || 'Pages could not be loaded.',
            requestId
          }
        }
      } finally {
        if (requestTreeId === this.treeViewCacheId) this.pendingRequests = Math.max(0, this.pendingRequests - 1)
        if (this.folderPendingRequestIds[requestKey] === requestId) delete this.folderPendingRequestIds[requestKey]
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

  &__panes {
    min-width: 0;
  }

  &__pane {
    min-width: 0;
  }

  &__folders-label {
    padding-inline-start: var(--wiki-space-3);
  }

  &__folder-errors {
    display: grid;
    gap: .5rem;
    padding: .5rem;
  }

  &__scroller {
    min-height: 12rem;
    max-height: min(400px, 52dvh);
    overflow: hidden;
  }

  &__options {
    gap: .5rem;
  }

  &__options .v-select {
    flex: 0 1 10rem;
    min-width: 7rem;
  }

  &__options .v-text-field {
    flex: 1 1 14rem;
    min-width: 0;
  }

  &__chin {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: .5rem;
    flex-wrap: wrap;
  }

  &__submission-error {
    flex: 1 1 100%;
    min-width: 0;
  }
}

@media (max-width: 599.98px) {
  .page-selector__panes {
    display: block;
    overflow-y: auto;
  }

  .page-selector__scroller {
    max-height: 34dvh;
  }

  .page-selector__options {
    flex-wrap: wrap;
  }

  .page-selector__options .v-select,
  .page-selector__options .v-text-field {
    flex: 1 1 100%;
  }
}
</style>
