<template lang='pug'>
  v-container.profile-pages(fluid)
    admin-hero(
      :title='$t("profile:pages.title")'
      :description='$t("profile:pages.subtitle")'
      icon='mdi-file-document-multiple-outline'
      heading-id='profile-pages-title'
    )
      template(#actions)
        v-btn(variant='outlined', prepend-icon='mdi-refresh', @click='refresh', :loading='loading', :disabled='loading || identityPending') {{ $t('profile:pages.reloadShort', { defaultValue: 'Reload' }) }}
    section.profile-pages-register(:aria-label='$t("profile:pages.title")', :aria-busy='loading || identityPending')
      form.profile-pages-toolbar(@submit.prevent='searchNow')
        v-text-field.profile-pages-search(v-model='search', :label='$t("profile:pages.find", { defaultValue: "Search your pages" })', prepend-inner-icon='mdi-magnify', variant='outlined', density='compact', hide-details, clearable, maxlength='200', autocomplete='off')
        v-select.profile-pages-sort(v-model='orderBy', :items='sortOptions', :label='$t("profile:pages.sort", { defaultValue: "Sort by" })', variant='outlined', density='compact', hide-details)
        v-select.profile-pages-sort(v-model='orderByDirection', :items='directionOptions', :label='$t("profile:pages.direction", { defaultValue: "Order" })', variant='outlined', density='compact', hide-details)
        v-btn(type='button', :variant='privateOnly ? "tonal" : "text"', :aria-pressed='privateOnly', @click='privateOnly = !privateOnly', prepend-icon='mdi-lock-outline') {{ $t('profile:pages.privateOnly', { defaultValue: 'Private only' }) }}
      .profile-pages-summary(role='status', aria-live='polite')
        span(v-if='loading || identityPending') {{ $t(identityPending ? 'profile:pages.accountLoading' : 'profile:pages.loading') }}
        span(v-else-if='hasLoaded && !staleResults') {{ $t('profile:pages.loadedCount', { count: pages.length }) }}
        span(v-if='staleResults') {{ $t('profile:pages.previousResults', { defaultValue: 'Showing previous results. Reload to apply the current filters.' }) }}
      async-state(v-if='errorMessage', state='error', :title='$t("profile:pages.loadError", { defaultValue: "Pages could not be loaded" })', :message='errorMessage', :retry-label='$t("common:page.tryAgain")', @retry='retry')
      async-state(v-if='!hasLoaded && (loading || identityPending)', state='loading', :title='$t(identityPending ? "profile:pages.accountLoading" : "profile:pages.loading")', :message='identityPending ? "" : $t("profile:pages.loadingMessage")')
      ul.profile-pages-records(v-if='pages.length')
        li(v-for='page in pages', :key='page.id')
          .profile-pages-identity
            a.profile-page-link(:href='pageHref(page)') {{ page.title || page.path }}
            v-chip(v-if='page.visibility === "private"', size='small', variant='outlined', prepend-icon='mdi-lock-outline') {{ $t('profile:pages.private', { defaultValue: 'Private' }) }}
            p(v-if='page.description') {{ page.description }}
            .profile-pages-path {{ page.locale }} / {{ page.path }}
          dl.profile-pages-dates
            div
              dt {{ $t('profile:pages.headerCreatedAt') }}
              dd {{ $helpers.formatMoment(page.createdAt, 'calendar') }}
            div
              dt {{ $t('profile:pages.headerUpdatedAt') }}
              dd {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
      async-state(v-else-if='hasLoaded && !loading && !errorMessage && !staleResults', state='empty', :title='offset > 0 || nextOffset !== null ? $t("profile:pages.emptyBatch", { defaultValue: "No readable pages in this batch" }) : hasActiveFilters ? emptyStateTitle : $t("profile:pages.emptyList", { defaultValue: "No pages to display" })', :message='offset > 0 || nextOffset !== null ? $t("profile:pages.batchRecoveryHint", { defaultValue: "Review the filters or return to another batch of your contributions." }) : hasActiveFilters ? emptyStateMessage : $t("profile:pages.noContributions", { defaultValue: "Pages you create or contribute to will appear here." })')
      footer.profile-pages-pagination(v-if='hasLoaded')
        span {{ $t('profile:pages.batch', { number: previousOffsets.length + 1 }) }}
        .profile-pages-pagination-actions
          v-btn(variant='text', prepend-icon='mdi-chevron-left', :disabled='loading || staleResults || !previousOffsets.length', @click='previous') {{ $t('common:actions.previous', { defaultValue: 'Previous' }) }}
          v-btn(variant='outlined', append-icon='mdi-chevron-right', :disabled='loading || staleResults || nextOffset === null', @click='next') {{ $t('common:actions.next', { defaultValue: 'Next' }) }}
</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import { fetchPageDirectory, type PageListRow } from '../../helpers/pages-api'
import { getErrorMessage, showNotification, setLoading } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  components: { AsyncState },
  data() {
    return {
      search: '' as string | null,
      privateOnly: false,
      orderBy: 'UPDATED' as 'ID' | 'PATH' | 'TITLE' | 'CREATED' | 'UPDATED',
      orderByDirection: 'DESC' as 'ASC' | 'DESC',
      pages: [] as PageListRow[],
      offset: 0,
      nextOffset: null as number | null,
      previousOffsets: [] as number[],
      loading: false,
      errorMessage: '',
      hasLoaded: false,
      loadedSignature: '',
      sequence: 0,
      disposed: false,
      timer: null as ReturnType<typeof setTimeout> | null,
      pendingOffset: 0,
      pendingPrevious: [] as number[]
    }
  },
  computed: {
    accountId(): number { return Number.isSafeInteger(wikiStore.user.id) && wikiStore.user.id > 0 ? wikiStore.user.id : 0 },
    identityPending(): boolean { return this.accountId === 0 },
    normalizedSearch(): string { return (this.search ?? '').trim().slice(0, 200) },
    querySignature(): string { return JSON.stringify([this.normalizedSearch, this.privateOnly, this.orderBy, this.orderByDirection]) },
    staleResults(): boolean { return this.hasLoaded && this.loadedSignature !== this.querySignature },
    hasActiveFilters(): boolean { return Boolean(this.privateOnly || this.normalizedSearch) },
    sortOptions() {
      return [
        { title: this.$t('profile:pages.headerUpdatedAt'), value: 'UPDATED' },
        { title: this.$t('profile:pages.headerCreatedAt'), value: 'CREATED' },
        { title: this.$t('profile:pages.headerTitle'), value: 'TITLE' },
        { title: this.$t('profile:pages.headerPath'), value: 'PATH' },
        { title: this.$t('profile:pages.pageId', { defaultValue: 'Page ID' }), value: 'ID' }
      ]
    },
    directionOptions() { return [{ title: this.$t('profile:pages.descending', { defaultValue: 'Descending' }), value: 'DESC' }, { title: this.$t('profile:pages.ascending', { defaultValue: 'Ascending' }), value: 'ASC' }] },
    emptyStateTitle(): string {
      return this.$t(this.privateOnly ? 'profile:pages.noPrivateMatches' : 'profile:pages.noMatches', { defaultValue: this.privateOnly ? 'No matching private pages' : 'No matching pages' })
    },
    emptyStateMessage(): string {
      return this.$t('profile:pages.directoryNoMatches', { defaultValue: 'Try another title, path, description, language, page ID or tag, or turn off Private only.' })
    }
  },
  watch: {
    querySignature() { this.queueSearch() },
    accountId() {
      this.sequence++
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.pages = []
      this.hasLoaded = false
      this.errorMessage = ''
      this.nextOffset = null
      this.offset = this.pendingOffset = 0
      this.previousOffsets = []
      this.pendingPrevious = []
      if (this.accountId) void this.loadPages()
      else if (this.loading) {
        this.loading = false
        setLoading(wikiStore, 'profile-pages-refresh', false)
      }
    }
  },
  mounted() { void this.loadPages() },
  beforeUnmount() {
    this.disposed = true
    this.sequence++
    if (this.timer) clearTimeout(this.timer)
    setLoading(wikiStore, 'profile-pages-refresh', false)
  },
  methods: {
    queueSearch() {
      this.sequence++
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.searchNow(), 250)
    },
    searchNow() {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      void this.loadPages(0, [])
    },
    retry() { void this.loadPages(this.staleResults ? 0 : this.pendingOffset, this.staleResults ? [] : this.pendingPrevious) },
    previous() {
      const offsets = this.previousOffsets.slice()
      const offset = offsets.pop()
      if (offset !== undefined) void this.loadPages(offset, offsets)
    },
    next() { if (this.nextOffset !== null) void this.loadPages(this.nextOffset, [...this.previousOffsets, this.offset]) },
    async refresh() {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      const loaded = await this.loadPages(this.staleResults ? 0 : this.offset, this.staleResults ? [] : this.previousOffsets)
      if (loaded) showNotification(wikiStore, { message: this.$t('profile:pages.refreshSuccess'), style: 'success', icon: 'cached' })
    },
    pageHref(item: PageListRow): string {
      const scope = item.visibility === 'private' ? '/_private' : ''
      return `${scope}/${item.locale}/${item.path}`
    },
    async loadPages(offset = 0, previousOffsets: number[] = []): Promise<boolean> {
      const userId = this.accountId
      if (this.disposed || !userId) return false
      const sequence = ++this.sequence
      const signature = this.querySignature
      this.pendingOffset = offset
      this.pendingPrevious = previousOffsets.slice()
      this.errorMessage = ''
      if (!this.loading) setLoading(wikiStore, 'profile-pages-refresh', true)
      this.loading = true
      try {
        const directory = await fetchPageDirectory(window.fetch.bind(window), {
          creatorId: userId,
          authorId: userId,
          limit: 25,
          offset,
          search: this.normalizedSearch,
          visibility: this.privateOnly ? 'private' : 'all',
          orderBy: this.orderBy,
          orderByDirection: this.orderByDirection
        })
        if (this.disposed || sequence !== this.sequence || userId !== this.accountId) return false
        this.pages = directory.items
        this.nextOffset = directory.nextOffset
        this.offset = offset
        this.previousOffsets = previousOffsets.slice()
        this.loadedSignature = signature
        this.hasLoaded = true
        return true
      } catch (err) {
        if (!this.disposed && sequence === this.sequence) this.errorMessage = getErrorMessage(err)
        return false
      } finally {
        if (!this.disposed && sequence === this.sequence) {
          this.loading = false
          setLoading(wikiStore, 'profile-pages-refresh', false)
        }
      }
    }
  }
}
</script>

<style lang='scss'>
.profile-pages-register { min-width: 0; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); overflow: hidden; }
.profile-pages-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid var(--wiki-surface-border); }
.profile-pages-search { flex: 1 1 18rem; min-width: 0; }
.profile-pages-sort { flex: 0 1 10rem; min-width: 9rem; }
.profile-pages-summary { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; font-size: .8125rem; color: var(--wiki-text-muted); }
.profile-pages-records { list-style: none; margin: 0; padding: 0; > li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(15rem, .5fr); gap: 16px; padding: 16px; border-top: 1px solid var(--wiki-surface-border); } }
.profile-pages-identity { min-width: 0; .v-chip { margin-inline-start: 8px; } p { font-size: .875rem; color: var(--wiki-text-muted); margin: 6px 0; overflow-wrap: anywhere; } }
.profile-page-link { color: var(--wiki-primary-ink); font-weight: 600; text-decoration: none; overflow-wrap: anywhere; &:hover, &:focus-visible { text-decoration: underline; text-underline-offset: 3px; } }
.profile-pages-path { font-size: .8125rem; overflow-wrap: anywhere; color: var(--wiki-text-muted); }
.profile-pages-dates { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-width: 0; dt { font-size: .75rem; color: var(--wiki-text-muted); } dd { margin: 4px 0 0; font-size: .8125rem; overflow-wrap: anywhere; } }
.profile-pages-pagination { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--wiki-surface-border); > span { font-size: .8125rem; color: var(--wiki-text-muted); } }
.profile-pages-pagination-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 700px) { .profile-pages-records > li { grid-template-columns: minmax(0, 1fr); } .profile-pages-search { flex-basis: 100%; } .profile-pages-sort { flex: 1 1 8rem; min-width: 0; } .profile-pages .v-btn { min-height: 44px; height: auto; white-space: normal; .v-btn__content { white-space: normal; } } .profile-page-link { display: inline-flex; align-items: center; min-height: 44px; } }
</style>
