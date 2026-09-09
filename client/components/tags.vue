<template lang='pug'>
  v-app.tags
    nav-header
    v-main.tags-main
      v-container.tags-shell(fluid)
        header.tags-intro
          .tags-intro-copy
            .tags-eyebrow
              v-icon(size='18' aria-hidden='true') mdi-tag-outline
              span {{$t('tags:libraryEyebrow', { defaultValue: 'Editorial library' })}}
            h1#tags-library-title {{$t('common:header.browseTags')}}
            p {{$t('tags:libraryDescription', { defaultValue: 'Tags group related pages into a shared library. Select one or more tags to find pages that match every choice.' })}}

        section.tags-selection(
          v-if='hasSelection'
          aria-label='Selected tags; all selected tags must match'
        )
          .tags-selection-heading
            div
              h2 {{$t('tags:currentSelection', { defaultValue: 'Selected tags' })}}
              p {{$t('tags:allSelectedTagsMatch', { defaultValue: 'Pages must match every selected tag.' })}}
            v-btn.tags-clear-selection(
              variant='text'
              color='primary'
              prepend-icon='mdi-close'
              :aria-label='$t(`tags:clearSelection`, { defaultValue: `Clear selection` })'
              @click='clearSelection'
            ) {{$t('tags:clearSelection', { defaultValue: 'Clear selection' })}}
          .tags-selection-chips
            .tags-selected-token(
              v-for='(selected, index) of tagsSelected'
              :key='`tagSelected-` + selected.tag'
            )
              span.tags-selected-label
                bdi {{selected.label}}
                span.tags-selected-canonical(v-if='selected.canonical !== selected.label')
                  bdi(dir='ltr') {{selected.canonical}}
              button.tags-selected-remove(
                type='button'
                :data-tag-index='index'
                :aria-label='removeTagLabel(selected)'
                @click='removeTag(selected.tag)'
              )
                v-icon(size='18' aria-hidden='true') mdi-close

        p.tags-selection-status(v-if='selectionAnnouncement' role='status' aria-live='polite') {{selectionAnnouncement}}
        .tags-workspace(:class='{ "tags-workspace--selected": hasSelection }')
          section.tags-index(
            id='tags-index-region'
            aria-labelledby='tags-index-title'
            :aria-busy='tagsLoading ? `true` : `false`'
          )
            .tags-index-heading
              .tags-index-heading-copy
                .tags-eyebrow
                  v-icon(size='16' aria-hidden='true') mdi-format-list-bulleted
                  span {{$t('tags:indexEyebrow', { defaultValue: 'Browse the vocabulary' })}}
                h2#tags-index-title {{$t('tags:indexTitle', { defaultValue: 'Tag index' })}}
              v-text-field.tags-index-search(
                v-model='tagSearch'
                :label='$t(`tags:searchTags`, { defaultValue: `Search tags` })'
                variant='outlined'
                hide-details
                clearable
                prepend-inner-icon='mdi-magnify'
                autocomplete='off'
              )
            button.tags-index-disclosure(
              v-if='hasSelection'
              v-show='!$vuetify.display.mdAndUp'
              ref='indexDisclosure'
              type='button'
              :aria-expanded='indexExpanded ? `true` : `false`'
              aria-controls='tags-index-panel'
              @click='indexExpanded = !indexExpanded'
            )
              span {{indexExpanded ? $t('tags:hideTags', { defaultValue: 'Hide tags' }) : $t('tags:showTags', { defaultValue: 'Show tags' })}}
              v-icon(size='20' aria-hidden='true') {{indexExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'}}
            .tags-index-panel#tags-index-panel(v-show='indexIsVisible')
              p.tags-index-status(role='status') {{tagIndexStatus}}
              async-state(
                v-if='tagsLoading && tags.length === 0'
                state='loading'
                :title='$t(`tags:loading`, { defaultValue: `Loading tags` })'
                :message='$t(`tags:loadingMessage`, { defaultValue: `Fetching the editorial vocabulary.` })'
              )
              async-state(
                v-else-if='tagsError'
                state='error'
                :title='$t(`tags:loadError`, { defaultValue: `Tags could not be loaded` })'
                :message='tagsError'
                :retry-label='$t(`common:actions.retry`, { defaultValue: `Try again` })'
                @retry='loadTags'
              )
              async-state(
                v-else-if='tags.length === 0'
                state='empty'
                :title='$t(`tags:empty`, { defaultValue: `No tags available` })'
                :message='$t(`tags:emptyMessage`, { defaultValue: `There are no tags to browse yet.` })'
              )
              v-empty-state.tags-index-empty(
                v-else-if='filteredTags.length === 0'
                icon='mdi-text-search'
                color='primary'
                :title='$t(`tags:noMatchingTags`, { defaultValue: `No matching tags` })'
                :text='$t(`tags:noMatchingTagsMessage`, { defaultValue: `Try a different search or clear the tag filter.` })'
              )
                template(#actions)
                  v-btn(
                    color='primary'
                    variant='tonal'
                    prepend-icon='mdi-close'
                    @click='clearTagSearch'
                  ) {{$t('tags:clearSearch', { defaultValue: 'Clear search' })}}
              nav.tags-index-tree(
                v-else
                :aria-label='$t(`tags:indexTitle`, { defaultValue: `Tag index` })'
              )
                section.tags-index-group(v-for='group of tagsGrouped' :key='`tag-group-` + group.name')
                  h3 {{group.name}}
                  ul.tags-index-list
                    li(v-for='tag of group.tags' :key='`tag-` + tag.tag')
                      button.tags-index-item(
                        type='button'
                        :aria-pressed='isSelected(tag.tag)'
                        :aria-label='tagButtonLabel(tag)'
                        :class='{ "tags-index-item--selected": isSelected(tag.tag) }'
                        @click='toggleTag(tag.tag)'
                      )
                        v-icon.tags-index-item-icon(size='18' aria-hidden='true') {{isSelected(tag.tag) ? 'mdi-check' : 'mdi-tag-outline'}}
                        span.tags-index-item-copy
                          span.tags-index-item-label
                            bdi {{tagLabel(tag)}}
                          span.tags-index-item-canonical(v-if='tag.tag && tag.tag !== tagLabel(tag)')
                            bdi(dir='ltr') {{tag.tag}}

          section.tags-results(
            v-if='hasSelection'
            aria-labelledby='tags-results-title'
            :aria-busy='isLoading ? `true` : `false`'
          )
            header.tags-results-header
              .tags-results-heading
                .tags-eyebrow
                  v-icon(size='16' aria-hidden='true') mdi-file-document-multiple-outline
                  span {{$t('tags:resultsEyebrow', { defaultValue: 'Matching pages' })}}
                h2#tags-results-title(ref='resultsHeading' tabindex='-1') {{$t('tags:resultsTitle', { defaultValue: 'Pages for these tags' })}}
              v-btn.tags-view-pages(
                v-if='!$vuetify.display.mdAndUp'
                ref='viewPagesButton'
                color='primary'
                variant='tonal'
                prepend-icon='mdi-file-search-outline'
                @click='viewPages'
              ) {{$t('tags:viewPages', { defaultValue: 'View pages' })}}
            .tags-results-toolbar
              v-text-field.tags-results-search(
                v-model='innerSearch'
                :label='$t(`tags:searchWithinResultsPlaceholder`, { defaultValue: `Search these pages` })'
                variant='outlined'
                hide-details
                clearable
                prepend-inner-icon='mdi-magnify'
                autocomplete='off'
              )
              .tags-results-options
                .tags-results-field(v-if='locales.length > 1')
                  span.tags-field-label#tags-language-label {{$t(`tags:locale`, { defaultValue: `Language` })}}
                  v-select(
                    id='tags-language'
                    :items='locales'
                    v-model='locale'
                    item-title='name'
                    item-value='code'
                    variant='outlined'
                    hide-details
                    density='comfortable'
                    aria-labelledby='tags-language-label'
                  )
                .tags-results-field
                  span.tags-field-label#tags-order-label {{$t(`tags:orderBy`, { defaultValue: `Sort by` })}}
                  v-select(
                    id='tags-order'
                    :items='orderByItems'
                    v-model='orderBy'
                    variant='outlined'
                    hide-details
                    density='comfortable'
                    aria-labelledby='tags-order-label'
                  )
                v-btn-toggle.tags-sort-direction(
                  v-model='orderByDirection'
                  mandatory
                  color='primary'
                  variant='outlined'
                  :aria-label='$t(`tags:sortDirection`, { defaultValue: `Sort direction` })'
                )
                  v-btn(:value='0' :aria-label='$t(`tags:sortAscending`, { defaultValue: `Sort ascending` })')
                    v-icon(size='20' aria-hidden='true') mdi-sort-ascending
                  v-btn(:value='1' :aria-label='$t(`tags:sortDescending`, { defaultValue: `Sort descending` })')
                    v-icon(size='20' aria-hidden='true') mdi-sort-descending

            v-data-iterator.tags-result-iterator(
              :items='resultPages'
              :items-per-page='pagination.itemsPerPage'
              :search='innerSearch'
              :loading='isLoading'
              v-model:page='pagination.page'
              :sort-by='pagination.sortBy'
              must-sort
            )
              template(v-slot:header='props')
                p.tags-results-status(role='status')
                  span(v-if='isLoading') {{$t('tags:retrievingResultsLoading', { defaultValue: 'Loading matching pages…' })}}
                  span(v-else-if='pagesError') {{$t('tags:resultsError', { defaultValue: 'Matching pages could not be loaded.' })}}
                  span(v-else) {{props.itemsCount}} {{$t('tags:resultCount', { defaultValue: 'matching pages' })}}
              template(v-slot:loader)
                .tags-state.tags-state--loading(role='status')
                  v-progress-circular(indeterminate color='primary' size='40' width='3' aria-hidden='true')
                  h3 {{$t('tags:retrievingResultsLoading', { defaultValue: 'Loading matching pages…' })}}
              template(v-slot:no-data)
                async-state(
                  v-if='pagesError'
                  state='error'
                  :title='$t(`tags:resultsError`, { defaultValue: `Matching pages could not be loaded` })'
                  :message='pagesError'
                  :retry-label='$t(`common:actions.retry`, { defaultValue: `Try again` })'
                  @retry='loadPages'
                )
                .tags-state(v-else-if='typeof innerSearch === `string` && innerSearch.trim()')
                  v-icon(size='42' color='primary' aria-hidden='true') mdi-text-search
                  h3 {{$t('tags:noResultsWithFilter', { defaultValue: 'No pages match this search' })}}
                  p {{$t('tags:noResultsWithFilterMessage', { defaultValue: 'Try a different search or clear the page filter.' })}}
                  v-btn(color='primary' variant='tonal' prepend-icon='mdi-close' @click='clearResultSearch') {{$t('tags:clearSearch', { defaultValue: 'Clear search' })}}
                .tags-state(v-else)
                  v-icon(size='42' color='primary' aria-hidden='true') mdi-file-search-outline
                  h3 {{$t('tags:noResults', { defaultValue: 'No matching pages' })}}
                  p {{$t('tags:noResultsMessage', { defaultValue: 'Adjust your selected tags to find pages.' })}}
                  v-btn(color='primary' variant='tonal' prepend-icon='mdi-filter-remove-outline' @click='clearSelection') {{$t('tags:clearSelection', { defaultValue: 'Clear selection' })}}
              template(v-slot:default='props')
                .tags-result-register
                  article.tags-result(v-for='entry of props.items' :key='`page-` + entry.raw.id')
                    a.tags-result-link(:href='pageHref(entry.raw)')
                      .tags-result-topline
                        span.tags-result-locale
                          bdi(dir='ltr') {{entry.raw.locale}}
                        time(:datetime='entry.raw.updatedAt') {{ $helpers.formatMoment(entry.raw.updatedAt, 'from') }}
                      h3 {{pageTitle(entry.raw)}}
                      p(v-if='entry.raw.description') {{entry.raw.description}}
                      .tags-result-path
                        v-icon(size='17' aria-hidden='true') mdi-file-tree-outline
                        bdi(dir='ltr') /{{entry.raw.path}}
                        v-icon.tags-result-arrow(size='18' aria-hidden='true') {{ $vuetify.locale.isRtl ? 'mdi-arrow-left' : 'mdi-arrow-right' }}
              template(v-slot:footer='props')
                .tags-pagination(v-if='props.pageCount > 1')
                  v-pagination(v-model='pagination.page' :length='props.pageCount' :aria-label='$t(`tags:pagination`, { defaultValue: `Matching page pagination` })')

    nav-footer(:app='false')
    notify
    search-results
</template>

<script lang='ts'>
import { markRaw } from 'vue'

import { fetchPages, fetchPageTags, type PageListRow, type PageTagRow } from '../helpers/pages-api'
import { pageHref as buildPageHref } from '../helpers/admin-pages'
import { setLoading } from '../helpers/root-ui-store'
import AsyncState from '@/components/common/async-state.vue'
import { pathFromTagSelection, tagSelectionFromPath } from '../helpers/tag-navigation'
import { wikiStore } from '@/store/index.ts'

/* global siteLangs */

type TagLocale = {
  name: string
  code: string
}

type TagSortKey = 'createdAt' | 'id' | 'updatedAt' | 'path' | 'title'
type TagGroup = { name: string, tags: PageTagRow[] }
type SelectedTag = { tag: string, label: string, canonical: string }

function normalizeSortKey (value: unknown): TagSortKey {
  switch (normalizeQueryValue(value)?.toLocaleLowerCase()) {
    case 'createdat':
      return 'createdAt'
    case 'id':
      return 'id'
    case 'updatedat':
      return 'updatedAt'
    case 'path':
      return 'path'
    default:
      return 'title'
  }
}

function normalizeQueryValue (value: unknown): string | undefined {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' && normalized.length > 0 ? normalized : undefined
}

export default {
  components: {
    AsyncState
  },
  i18nOptions: { namespaces: 'tags' },
  data() {
    return {
      tags: [] as PageTagRow[],
      selection: [] as string[],
      tagSearch: '',
      indexExpanded: true,
      innerSearch: '',
      locale: 'any',
      locales: [] as TagLocale[],
      orderBy: 'title' as TagSortKey,
      orderByDirection: 0,
      routeSyncReady: false,
      routePushPendingPath: '',
      pagination: {
        page: 1,
        itemsPerPage: 12,
        sortBy: [{ key: 'title', order: 'asc' as 'asc' | 'desc' }]
      },
      pages: [] as PageListRow[],
      tagsLoading: true,
      tagsError: '',
      isLoading: false,
      pagesError: '',
      tagsLoadSequence: 0,
      pagesLoadSequence: 0,
      disposed: false,
      selectionAnnouncement: ''
    }
  },
  computed: {
    hasSelection (): boolean {
      return this.selection.length > 0
    },
    indexIsVisible (): boolean {
      return !this.hasSelection || this.indexExpanded || this.$vuetify.display.mdAndUp
    },
    filteredTags (): PageTagRow[] {
      const query = typeof this.tagSearch === 'string' ? this.tagSearch.trim().toLocaleLowerCase() : ''
      return this.tags
        .filter(tag => {
          if (!query) return true
          return this.tagLabel(tag).toLocaleLowerCase().includes(query) || tag.tag.toLocaleLowerCase().includes(query)
        })
        .slice()
        .sort((left, right) => this.compareTags(left, right))
    },
    tagsGrouped (): TagGroup[] {
      const groups = new Map<string, PageTagRow[]>()
      for (const tag of this.filteredTags) {
        const name = this.tagGroupName(tag)
        const group = groups.get(name)
        if (group) group.push(tag)
        else groups.set(name, [tag])
      }
      return [...groups.entries()]
        .sort(([left], [right]) => {
          if (left === right) return 0
          if (left === '#') return -1
          if (right === '#') return 1
          return left.localeCompare(right, undefined, { sensitivity: 'base' })
        })
        .map(([name, tags]) => ({ name, tags }))
    },
    tagsSelected (): SelectedTag[] {
      return this.selection.map(tag => {
        const known = this.tags.find(entry => entry.tag === tag)
        return {
          tag,
          label: known ? this.tagLabel(known) : (tag || 'Unnamed tag'),
          canonical: tag || 'Unnamed tag'
        }
      })
    },
    resultPages (): PageListRow[] {
      return this.pages.map(page => ({
        ...page,
        title: this.pageTitle(page)
      }))
    },
    tagIndexStatus (): string {
      if (this.tagsLoading) return this.$t('tags:loading', { defaultValue: 'Loading tags' })
      if (this.tagsError) return this.$t('tags:loadError', { defaultValue: 'Tags could not be loaded' })
      if (this.tags.length === 0) return this.$t('tags:empty', { defaultValue: 'No tags available' })
      if (typeof this.tagSearch === 'string' && this.tagSearch.trim() && this.filteredTags.length === 0) return this.$t('tags:noMatchingTags', { defaultValue: 'No matching tags' })
      return this.$t('tags:indexStatus', { defaultValue: 'Browse the alphabetical tag index' })
    },
    orderByItems () {
      return [
        { title: this.$t('tags:orderByField.creationDate'), value: 'createdAt' },
        { title: this.$t('tags:orderByField.ID'), value: 'id' },
        { title: this.$t('tags:orderByField.lastModified'), value: 'updatedAt' },
        { title: this.$t('tags:orderByField.path'), value: 'path' },
        { title: this.$t('tags:orderByField.title'), value: 'title' }
      ]
    }
  },
  watch: {
    locale () {
      if (this.routeSyncReady) this.rebuildURL()
    },
    orderBy (newValue: TagSortKey) {
      if (!this.routeSyncReady) return
      this.pagination.sortBy = [{ key: newValue, order: this.orderByDirection === 0 ? 'asc' : 'desc' }]
      this.rebuildURL()
    },
    orderByDirection (newValue: number) {
      if (!this.routeSyncReady) return
      this.pagination.sortBy = [{ key: this.orderBy, order: newValue === 0 ? 'asc' : 'desc' }]
      this.rebuildURL()
    },
    innerSearch () {
      this.pagination.page = 1
    },
    '$route.fullPath' () {
      const localRouteChange = this.routePushPendingPath === this.$route.fullPath
      this.routePushPendingPath = ''
      this.routeSyncReady = false
      this.syncRouteState()
      if (!localRouteChange && this.hasSelection && !this.$vuetify.display.mdAndUp) this.indexExpanded = false
      if (!this.hasSelection) this.indexExpanded = true
      this.loadPages()
      this.$nextTick(() => {
        if (!this.disposed) this.routeSyncReady = true
      })
    },
    '$vuetify.display.mdAndUp': {
      flush: 'pre',
      handler (large: boolean) {
        const activeElement = document.activeElement
        if (large) {
          const disclosure = this.$refs.indexDisclosure
          const disclosureElement = disclosure instanceof HTMLElement
            ? disclosure
            : (disclosure as { $el?: unknown } | undefined)?.$el
          if (activeElement && activeElement === disclosureElement) {
            document.querySelector<HTMLElement>('.tags-index-search input')?.focus({ preventScroll: true })
          }
          const viewPagesButton = this.$refs.viewPagesButton
          const viewPagesElement = viewPagesButton instanceof HTMLElement
            ? viewPagesButton
            : (viewPagesButton as { $el?: unknown } | undefined)?.$el
          if (activeElement && activeElement === viewPagesElement) {
            document.querySelector<HTMLElement>('#tags-results-title')?.focus({ preventScroll: true })
          }
          return
        }
        if (!this.hasSelection) {
          this.indexExpanded = true
          return
        }
        const indexRegion = document.getElementById('tags-index-region')
        if (activeElement && indexRegion?.contains(activeElement)) {
          this.indexExpanded = true
          return
        }
        this.indexExpanded = false
      }
    }
  },
  created () {
    wikiStore.page.mode = 'tags'
    this.selection = tagSelectionFromPath(this.$route.path)
    this.indexExpanded = this.selection.length === 0 || this.$vuetify.display.mdAndUp
  },
  mounted () {
    this.locales = [
      { name: this.$t('tags:localeAny'), code: 'any' },
      ...siteLangs
    ]
    this.syncRouteState()
    this.loadTags()
    this.loadPages()
    this.$nextTick(() => {
      if (!this.disposed) this.routeSyncReady = true
    })
  },
  beforeUnmount () {
    this.disposed = true
    this.tagsLoadSequence += 1
    this.pagesLoadSequence += 1
  },
  methods: {
    syncRouteState () {
      this.selection = tagSelectionFromPath(this.$route.path)
      this.locale = normalizeQueryValue(this.$route.query.lang) ?? 'any'
      this.orderBy = normalizeSortKey(this.$route.query.sort)
      this.orderByDirection = normalizeQueryValue(this.$route.query.dir) === 'desc' ? 1 : 0
      this.pagination.sortBy = [{
        key: this.orderBy,
        order: this.orderByDirection === 0 ? 'asc' : 'desc'
      }]
      this.pagination.page = 1
    },
    compareTags (left: PageTagRow, right: PageTagRow): number {
      const labelResult = this.tagLabel(left).localeCompare(this.tagLabel(right), undefined, { sensitivity: 'base' })
      if (labelResult !== 0) return labelResult
      return left.tag.localeCompare(right.tag, undefined, { sensitivity: 'base' })
    },
    tagLabel (tag: PageTagRow): string {
      const title = typeof tag.title === 'string' ? tag.title.trim() : ''
      return title || tag.tag || 'Unnamed tag'
    },
    tagGroupName (tag: PageTagRow): string {
      const first = this.tagLabel(tag).trim().charAt(0).toLocaleUpperCase()
      return /^\p{L}/u.test(first) ? first : '#'
    },
    tagButtonLabel (tag: PageTagRow): string {
      const label = this.tagLabel(tag)
      return label === tag.tag || !tag.tag ? label : `${label} (${tag.tag})`
    },
    removeTagLabel (selected: SelectedTag): string {
      return `Remove ${selected.label}${selected.canonical !== selected.label ? ` (${selected.canonical})` : ''}`
    },
    isSelected (tag: string): boolean {
      return this.selection.includes(tag)
    },
    toggleTag (tag: string): void {
      if (this.isSelected(tag)) {
        this.removeTag(tag)
        return
      }
      this.selection = [...this.selection, tag]
      this.pagination.page = 1
      this.selectionAnnouncement = `Added ${tag || 'unnamed tag'}. All selected tags must match.`
      this.rebuildURL()
    },
    removeTag (tag: string): void {
      const index = this.selection.indexOf(tag)
      if (index < 0) return
      this.selection = this.selection.filter(selectedTag => selectedTag !== tag)
      this.pagination.page = 1
      this.selectionAnnouncement = `Removed ${tag || 'unnamed tag'}.`
      this.rebuildURL()
      this.$nextTick(() => this.focusAfterTagRemoval(index))
    },
    clearSelection (): void {
      this.selection = []
      this.pagination.page = 1
      this.indexExpanded = true
      this.selectionAnnouncement = 'Selection cleared.'
      this.rebuildURL()
      this.$nextTick(() => this.focusTagIndex())
    },
    focusTagIndex (): void {
      const target = document.querySelector<HTMLElement>('.tags-index-search input') ?? document.querySelector<HTMLElement>('.tags-index-item')
      target?.focus({ preventScroll: true })
    },
    clearTagSearch (): void {
      this.tagSearch = ''
      this.$nextTick(() => {
        document.querySelector<HTMLElement>('.tags-index-search input')?.focus({ preventScroll: true })
      })
    },
    clearResultSearch (): void {
      this.innerSearch = ''
      this.$nextTick(() => {
        document.querySelector<HTMLElement>('.tags-results-search input')?.focus({ preventScroll: true })
      })
    },
    focusAfterTagRemoval (index: number): void {
      const nextIndex = Math.min(index, this.tagsSelected.length - 1)
      const token = nextIndex >= 0
        ? document.querySelector<HTMLElement>(`.tags-selected-remove[data-tag-index="${nextIndex}"]`)
        : null
      ;(token ?? document.querySelector<HTMLElement>('.tags-index-search input') ?? document.querySelector<HTMLElement>('.tags-index-item'))?.focus({ preventScroll: true })
    },
    viewPages (): void {
      this.indexExpanded = false
      this.$nextTick(() => {
        const heading = document.querySelector<HTMLElement>('#tags-results-title')
        heading?.focus({ preventScroll: true })
      })
    },
    rebuildURL (): void {
      const query: Record<string, string> = {}
      if (this.locale !== 'any') query.lang = this.locale
      if (this.orderBy !== 'title') query.sort = this.orderBy.toLowerCase()
      if (this.orderByDirection !== 0) query.dir = 'desc'
      const location = {
        path: pathFromTagSelection(this.selection),
        query
      }
      this.routePushPendingPath = this.$router.resolve(location).fullPath
      void this.$router.push(location)
    },
    async loadTags (): Promise<void> {
      const sequence = ++this.tagsLoadSequence
      const loadingKey = `tags-refresh-${sequence}`
      this.tagsLoading = true
      this.tagsError = ''
      this.tags = []
      setLoading(wikiStore, loadingKey, true)
      try {
        const tags = await fetchPageTags(window.fetch.bind(window))
        if (this.disposed || sequence !== this.tagsLoadSequence) return
        this.tags = markRaw(tags)
      } catch (err) {
        if (this.disposed || sequence !== this.tagsLoadSequence) return
        this.tagsError = err instanceof Error ? err.message : 'Unable to load tags.'
      } finally {
        if (sequence === this.tagsLoadSequence && !this.disposed) this.tagsLoading = false
        setLoading(wikiStore, loadingKey, false)
      }
    },
    async loadPages (): Promise<void> {
      const sequence = ++this.pagesLoadSequence
      const loadingKey = `pages-refresh-${sequence}`
      this.pagesError = ''
      this.pages = []
      this.pagination.page = 1
      if (this.selection.length < 1) {
        this.isLoading = false
        return
      }
      this.isLoading = true
      setLoading(wikiStore, loadingKey, true)
      try {
        const pages = await fetchPages(window.fetch.bind(window), {
          locale: this.locale === 'any' ? undefined : this.locale,
          tags: this.selection
        })
        if (this.disposed || sequence !== this.pagesLoadSequence) return
        this.pages = markRaw(pages)
      } catch (err) {
        if (this.disposed || sequence !== this.pagesLoadSequence) return
        this.pagesError = err instanceof Error ? err.message : 'Unable to load tagged pages.'
      } finally {
        if (sequence === this.pagesLoadSequence && !this.disposed) this.isLoading = false
        setLoading(wikiStore, loadingKey, false)
      }
    },
    pageTitle (page: PageListRow): string {
      return page.title?.trim() || page.path || 'Untitled page'
    },
    pageHref (page: PageListRow): string {
      return buildPageHref(page)
    }
  }
}
</script>

<style lang='scss'>
.tags {
  min-width: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
}

.tags-main {
  min-width: 0;
  background: rgb(var(--v-theme-background));
}

.tags-shell {
  width: min(100%, var(--wiki-content-max));
  max-width: 100%;
  min-width: 0;
  margin: 0 auto;
  padding: var(--wiki-space-8) var(--wiki-page-gutter) var(--wiki-space-8) !important;
}

.tags-intro {
  display: flex;
  min-width: 0;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--wiki-space-6);
  padding-block: 0 var(--wiki-space-6);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.tags-intro-copy {
  min-width: 0;
}

.tags-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: var(--wiki-space-2);
  color: var(--wiki-accent-ink);
  font-size: .8125rem;
  font-weight: 700;
  letter-spacing: .075em;
  line-height: 1.4;
  text-transform: uppercase;
}

.tags-intro h1 {
  margin: var(--wiki-space-2) 0 var(--wiki-space-3);
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-display);
  font-size: clamp(2rem, 4vw, 3rem);
  font-weight: 750;
  letter-spacing: -.045em;
  line-height: 1.12;
}

.tags-intro p {
  max-width: 52rem;
  margin: 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, rgb(var(--v-theme-background)));
  font-size: 1rem;
  line-height: 1.6;
}

.tags-selection,
.tags-index {
  min-width: 0;
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-raised);
}

.tags-selection {
  margin-top: var(--wiki-space-6);
  padding: var(--wiki-space-4) var(--wiki-space-5);
}

.tags-selection-heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--wiki-space-4);
}

.tags-selection-heading h2,
.tags-index-heading h2,
.tags-results-header h2 {
  margin: 0;
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-size: 1.2rem;
  font-weight: 720;
  letter-spacing: -.02em;
  line-height: 1.3;
}

.tags-selection-heading p {
  margin: var(--wiki-space-1) 0 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, rgb(var(--v-theme-background)));
  font-size: .875rem;
  line-height: 1.5;
}

.tags-clear-selection {
  flex: 0 0 auto;
  min-height: var(--wiki-control-height);
}

.tags-selection-chips {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: var(--wiki-space-2);
  margin-top: var(--wiki-space-4);
}

.tags-selected-token {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, var(--wiki-surface-border));
  border-radius: var(--wiki-radius-xs);
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, var(--wiki-surface-raised));
  color: rgb(var(--v-theme-on-surface));
}

.tags-selected-label {
  min-width: 0;
  padding: .5rem .625rem;
  overflow-wrap: anywhere;
  font-size: .875rem;
  line-height: 1.35;
}

.tags-selected-canonical {
  display: block;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, var(--wiki-surface-raised));
  font-family: var(--wiki-font-mono);
  font-size: .8125rem;
}

.tags-selected-remove {
  display: inline-grid;
  flex: 0 0 var(--wiki-control-height);
  width: var(--wiki-control-height);
  min-width: var(--wiki-control-height);
  height: var(--wiki-control-height);
  place-items: center;
  border: 0;
  border-inline-start: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 24%, var(--wiki-surface-border));
  border-start-end-radius: var(--wiki-radius-xs);
  border-end-end-radius: var(--wiki-radius-xs);
  background: transparent;
  color: var(--wiki-accent-ink);
  cursor: pointer;
}

.tags-selection-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.tags-workspace {
  display: block;
  min-width: 0;
  margin-top: var(--wiki-space-6);
}

.tags-workspace--selected {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: var(--wiki-space-6);
  align-items: start;
}

.tags-index {
  overflow: hidden;
}

.tags-index-heading {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-4);
  padding: var(--wiki-space-5);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.tags-index-heading-copy {
  min-width: 0;
}

.tags-index-heading h2 {
  margin-top: var(--wiki-space-2);
}

.tags-index-search,
.tags-results-search {
  min-width: 0;
}

.tags-index-search .v-field,
.tags-results-search .v-field,
.tags-results-options .v-field {
  border-radius: var(--wiki-control-radius);
}

.tags-index-disclosure {
  display: flex;
  width: 100%;
  min-height: var(--wiki-control-height);
  align-items: center;
  justify-content: space-between;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-4);
  border: 0;
  border-bottom: 1px solid var(--wiki-surface-border);
  background: var(--wiki-surface-sunken);
  color: var(--wiki-accent-ink);
  cursor: pointer;
  font-weight: 650;
  text-align: start;
}

.tags-index-panel {
  min-width: 0;
  padding: var(--wiki-space-4) var(--wiki-space-5) var(--wiki-space-5);
}

.tags-index-status,
.tags-results-status {
  min-height: 1.25rem;
  margin: 0 0 var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 66%, var(--wiki-surface-raised));
  font-size: .8125rem;
  line-height: 1.5;
}

.tags-index-tree {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--wiki-space-6) var(--wiki-space-5);
  min-width: 0;
}

.tags-index-group {
  min-width: 0;
}

.tags-index-group h3 {
  margin: 0 0 var(--wiki-space-2);
  padding-bottom: var(--wiki-space-2);
  border-bottom: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, var(--wiki-surface-raised));
  font-family: var(--wiki-font-heading);
  font-size: .875rem;
  font-weight: 720;
  line-height: 1.4;
}

.tags-index-list {
  display: grid;
  gap: var(--wiki-space-1);
  padding: 0;
  margin: 0;
  list-style: none;
}

.tags-index-item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: var(--wiki-control-height);
  align-items: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  border: 1px solid transparent;
  border-radius: var(--wiki-control-radius);
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  text-align: start;
  transition:
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.tags-index-item:hover {
  border-color: color-mix(in srgb, var(--wiki-accent-ink) 24%, var(--wiki-surface-border));
  background: color-mix(in srgb, var(--wiki-accent-ink) 7%, var(--wiki-surface-raised));
}

.tags-index-item--selected {
  border-color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, var(--wiki-surface-border));
  background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, var(--wiki-surface-raised));
  color: var(--wiki-accent-ink);
}

.tags-index-item-icon {
  flex: 0 0 auto;
}

.tags-index-item-copy {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.tags-index-item-label {
  display: block;
  min-width: 0;
  line-height: 1.35;
}

.tags-index-item-canonical {
  display: block;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, var(--wiki-surface-raised));
  font-family: var(--wiki-font-mono);
  font-size: .8125rem;
  line-height: 1.3;
}

.tags-index-empty {
  margin: 0;
  border-radius: var(--wiki-control-radius);
}

.tags-state {
  display: grid;
  min-height: 13rem;
  place-items: center;
  align-content: center;
  gap: var(--wiki-space-2);
  padding: var(--wiki-space-6) var(--wiki-space-4);
  border: 1px dashed var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  background: var(--wiki-surface-sunken);
  color: rgb(var(--v-theme-on-surface));
  text-align: center;
}

.tags-state h3 {
  margin: 0;
  font-family: var(--wiki-font-heading);
  font-size: 1rem;
  font-weight: 700;
}

.tags-state p {
  max-width: 34rem;
  margin: 0 0 var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 70%, var(--wiki-surface-raised));
  font-size: .875rem;
  line-height: 1.5;
}

.tags-results {
  min-width: 0;
}

.tags-results-header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--wiki-space-4);
  margin-bottom: var(--wiki-space-4);
}

.tags-results-heading {
  min-width: 0;
}

.tags-results-header h2 {
  margin-top: var(--wiki-space-2);
}

.tags-results-header h2:focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}

.tags-view-pages {
  flex: 0 0 auto;
  min-height: var(--wiki-control-height);
}

.tags-results-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  gap: var(--wiki-space-3);
  min-width: 0;
  margin-bottom: var(--wiki-space-4);
}

.tags-results-options {
  display: grid;
  grid-template-columns: minmax(0, .8fr) minmax(0, 1.15fr) auto;
  gap: var(--wiki-space-2);
  min-width: 0;
}

.tags-results-field {
  display: grid;
  min-width: 0;
  gap: var(--wiki-space-2);
}

.tags-field-label {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, rgb(var(--v-theme-background)));
  font-size: .8125rem;
  line-height: 1.35;
}

.tags-sort-direction {
  min-height: var(--wiki-control-height);
  border-radius: var(--wiki-control-radius);
}

.tags-sort-direction .v-btn {
  min-width: var(--wiki-control-height);
  min-height: var(--wiki-control-height);
}

.tags-results-status {
  margin-bottom: var(--wiki-space-3);
}

.tags-state--loading {
  min-height: 13rem;
}

.tags-result-register {
  min-width: 0;
  border-top: 1px solid var(--wiki-surface-border);
}

.tags-result {
  min-width: 0;
  border-bottom: 1px solid var(--wiki-surface-border);
}

.tags-result-link {
  display: block;
  min-width: 0;
  padding: var(--wiki-space-5) var(--wiki-space-2);
  color: inherit;
  text-decoration: none;
  transition:
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    border-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.tags-result-link:hover {
  background: color-mix(in srgb, var(--wiki-accent-ink) 5%, var(--wiki-surface-raised));
}

.tags-result-link h3 {
  margin: var(--wiki-space-2) 0 var(--wiki-space-1);
  color: var(--wiki-accent-ink);
  font-family: var(--wiki-font-heading);
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.tags-result-link p {
  max-width: 62rem;
  margin: 0 0 var(--wiki-space-3);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, var(--wiki-surface-raised));
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.tags-result-topline,
.tags-result-path {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--wiki-space-2);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 64%, var(--wiki-surface-raised));
  font-size: .8125rem;
  line-height: 1.4;
}

.tags-result-topline time {
  margin-inline-start: auto;
  text-align: end;
}

.tags-result-path {
  color: var(--wiki-accent-ink);
  font-family: var(--wiki-font-mono);
  overflow-wrap: anywhere;
}

.tags-result-path bdi {
  min-width: 0;
  overflow-wrap: anywhere;
}

.tags-result-arrow {
  margin-inline-start: auto;
  flex: 0 0 auto;
}

.tags-pagination {
  display: flex;
  max-width: 100%;
  justify-content: center;
  padding-top: var(--wiki-space-5);
}

.tags-pagination .v-pagination {
  max-width: 100%;
}
.tags-pagination .v-pagination__list {
  flex-wrap: wrap;
}

.tags :is(button, a, input, select, textarea):focus-visible {
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}


@media (max-width: 1279.98px) {
  .tags-index-tree {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 960px) {
  .tags-workspace--selected .tags-index-tree {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 959.98px) {
  .tags-shell {
    padding: var(--wiki-space-6) var(--wiki-space-4) var(--wiki-space-8) !important;
  }

  .tags-workspace--selected {
    display: block;
  }

  .tags-results {
    margin-top: var(--wiki-space-6);
  }

}

@media (max-width: 599.98px) {
  .tags-shell {
    padding: var(--wiki-space-5) var(--wiki-space-3) var(--wiki-space-6) !important;
  }

  .tags-intro {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--wiki-space-3);
    padding-bottom: var(--wiki-space-5);
  }

  .tags-intro h1 {
    font-size: clamp(2rem, 11vw, 2.5rem);
  }

  .tags-selection,
  .tags-index-heading,
  .tags-index-panel {
    padding-inline: var(--wiki-space-3);
  }

  .tags-selection-heading,
  .tags-results-header {
    align-items: stretch;
    flex-direction: column;
  }

  .tags-clear-selection,
  .tags-view-pages {
    width: 100%;
  }

  .tags-index-tree {
    grid-template-columns: 1fr;
  }

  .tags-results-toolbar,
  .tags-results-options {
    grid-template-columns: 1fr;
  }

  .tags-sort-direction {
    width: 100%;
  }

  .tags-sort-direction .v-btn {
    flex: 1 1 50%;
  }

  .tags-result-link {
    padding-inline: 0;
  }

  .tags-result-topline {
    align-items: flex-start;
    flex-direction: column;
  }

  .tags-result-topline time {
    margin-inline-start: 0;
    text-align: start;
  }
}

@media (forced-colors: active) {
  .tags-selection,
  .tags-index,
  .tags-index-group h3,
  .tags-result-register,
  .tags-result,
  .tags-selected-token,
  .tags-index-item,
  .tags-selected-remove {
    border-color: CanvasText !important;
  }

  .tags-index-item--selected {
    outline: 1px solid Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tags * {
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
  }
}
</style>
