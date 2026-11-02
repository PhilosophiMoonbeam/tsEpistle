<template>
  <v-container fluid class="admin-pages">
    <admin-hero :title="$t('admin:pages.title')" :description="$t('admin:pages.careKnowledgeWorkspace')" icon="mdi-file-document-multiple-outline">
      <template #status>
        <dl class="pages-totals" v-if="pages.length || (!loading && !errorMessage)">
          <div><dt>{{ $t('admin:pages.accessiblePages') }}</dt><dd>{{ pages.length }}</dd></div>
          <div><dt>{{ pages.some(page => page.isPublished === undefined) ? $t('admin:pages.knownDrafts') : $t('admin:pages.drafts') }}</dt><dd>{{ pages.filter(page => page.isPublished === false).length }}</dd></div>
          <div><dt>{{ $t('admin:pages.publicationUnavailable') }}</dt><dd>{{ pages.filter(page => page.isPublished === undefined).length }}</dd></div>
          <div><dt>{{ $t('admin:pages.private') }}</dt><dd>{{ pages.filter(page => page.visibility === 'private').length }}</dd></div>
        </dl>
      </template>
      <template #actions>
        <div class="pages-hero-actions">
          <div v-for="action in heroActionGeometry" :key="action.label" class="pages-hero-action">
            <!-- Inert sizing copies preserve each control's position before permission hydration. -->
            <span class="pages-hero-action-size v-btn v-btn--size-default v-btn--density-default rounded-lg" :class="`v-btn--variant-${action.variant}`" aria-hidden="true"><span class="v-btn__prepend"><v-icon :icon="action.icon" /></span><span class="v-btn__content">{{ $t(action.label) }}</span></span>
            <v-btn v-if="action.label === 'admin:shell.reload'" variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || bulkOpen" @click="refresh">{{ $t(action.label) }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:pages.reloadPageList') }}</v-tooltip></v-btn>
            <v-btn v-else-if="!action.restricted || canManageSystem" :variant="action.variant" :prepend-icon="action.icon" :to="action.to">{{ $t(action.label) }}</v-btn>
          </div>
        </div>
      </template>
    </admin-hero>
    <section class="pages-workbench" :aria-label="$t('admin:pages.pageInventory')">
      <div class="pages-search">
        <v-text-field v-model="search" :label="$t('admin:pages.findTitlePathTag')" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable density="compact" @update:model-value="filtersChanged" />
        <v-btn variant="text" :aria-expanded="filtersOpen" aria-controls="pages-advanced-filters" prepend-icon="mdi-filter-variant" @click="filtersOpen = !filtersOpen">{{ $t('admin:pages.filters') }}<span v-if="hasAdvancedFilters" class="pages-filter-active"> · {{ $t('admin:pages.activeFilters') }}</span></v-btn>
        <!-- biome-ignore lint/a11y/useSemanticElements: The labeled group preserves segmented quick-view semantics. -->
        <div class="pages-quickviews" :aria-label="$t('admin:pages.pageViews')" role="group"><v-btn v-for="view in views" :key="view.value" size="small" :variant="view.value === currentView ? 'tonal' : 'text'" :aria-pressed="view.value === currentView" @click="setView(view.value)">{{ view.title }}</v-btn></div>
      </div>
      <div v-show="filtersOpen" id="pages-advanced-filters" class="pages-filters">
        <v-select v-model="selectedLang" :items="langs" :label="$t('admin:pages.language')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
        <v-select v-model="visibility" :items="visibilityOptions" :label="$t('admin:pages.visibility')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
        <v-select v-model="publication" :items="publicationOptions" :label="$t('admin:pages.publication')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
        <v-autocomplete v-model="tag" :items="tagOptions" :label="$t('admin:pages.tag')" variant="outlined" hide-details density="compact" clearable @update:model-value="untagged = false; filtersChanged()" />
        <v-select v-model="sort" :items="sortOptions" :label="$t('admin:pages.orderPages')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
        <v-btn v-if="hasActiveFilters" variant="text" @click="clearFilters">{{ $t('admin:pages.clearFilters') }}</v-btn>
      </div>
      <div class="pages-inventory-toolbar"><span role="status">{{ $t('admin:pages.accessiblePages2', { filteredPagesCount: filteredPages.length, pagesCount: pages.length, interpolation: { escapeValue: false } }) }}</span><div><v-btn variant="text" size="small" :disabled="!visiblePages.length || bulkOpen" @click="selectVisible">{{ $t('admin:pages.selectPage') }}</v-btn><v-btn variant="text" size="small" :disabled="!filteredPages.length" @click="exportInventory">{{ $t('admin:pages.exportInventory') }}</v-btn></div></div>
      <section v-if="selectedIds.length" class="pages-selection" :aria-label="$t('admin:pages.selectedPages')"><div><strong>{{ $t('admin:pages.selected', { selectedIdsCount: selectedIds.length, interpolation: { escapeValue: false } }) }}</strong><span v-if="hiddenSelected"> {{ $t('admin:pages.outsideTheseFilters', { hiddenSelected, interpolation: { escapeValue: false } }) }}</span><small>{{ $t('admin:pages.up25PagesPer') }}</small></div><div><v-btn variant="text" @click="selectedIds = []">{{ $t('admin:pages.clearSelection') }}</v-btn><v-btn variant="flat" color="primary" :disabled="loading" @click="bulkOpen = true">{{ $t('admin:pages.reviewPublication') }}</v-btn></div></section>
      <v-alert v-if="errorMessage && pages.length" type="error" variant="tonal" class="ma-4">{{ errorMessage }} <v-btn variant="text" @click="loadPages">{{ $t('admin:pages.tryAgain') }}</v-btn></v-alert>
      <async-state v-if="loading && !pages.length" state="loading" :title="$t('admin:pages.loadingRegister')" :message="$t('admin:pages.fetchingPagesYouCan')" />
      <async-state v-else-if="errorMessage && !pages.length" state="error" :title="$t('admin:pages.pagesCouldNotLoaded')" :message="errorMessage" :retry-label="$t('admin:pages.tryAgain')" @retry="loadPages" />
      <async-state v-else-if="!filteredPages.length" state="empty" :title="hasActiveFilters ? $t('admin:pages.noPagesMatchView') : $t('admin:pages.knowledgeStartsHere')" :message="hasActiveFilters ? $t('admin:pages.tryDifferentTermClear') : $t('admin:pages.createPageWikiBegin')" />
      <div v-else class="pages-register" :aria-busy="loading">
        <article v-for="page in visiblePages" :key="page.id" class="pages-record">
          <input type="checkbox" :aria-label="$t('admin:pages.select', { value: page.title || page.path, interpolation: { escapeValue: false } })" :checked="selectedIds.includes(page.id)" :disabled="bulkOpen || (!selectedIds.includes(page.id) && selectedIds.length >= 25)" @change="toggleSelected(page.id)" />
          <div class="pages-record-main"><router-link class="admin-record-link" :to="`/pages/${page.id}`">{{ page.title || $t('admin:pages.untitledPage') }}</router-link><span class="pages-record-path"><bdi>{{ page.locale }} / {{ page.path }}</bdi></span></div>
          <div class="pages-record-state"><status-indicator aria-hidden="true" :positive="state(page) === 'Published'" :intermediary="state(page) === 'Scheduled'" :negative="state(page) === 'Invalid schedule'" :label="stateTitle(state(page))" /> <span>{{ stateTitle(state(page)) }}</span></div>
          <div class="pages-record-date"><time :datetime="page.updatedAt"><span class="pages-visually-hidden">{{ $t('admin:pages.updated') }} </span>{{ date(page.updatedAt) }}</time></div>
          <details class="pages-record-details">
            <summary :aria-label="$t('admin:pages.detailsFor', { title: page.title || page.path, interpolation: { escapeValue: false } })">{{ $t('admin:pages.details') }}</summary>
            <div class="pages-record-details-body wiki-surface-well">
              <p v-if="page.description">{{ page.description }}</p>
              <dl><div><dt>{{ $t('admin:pages.visibility') }}</dt><dd>{{ page.visibility === 'private' ? $t('admin:pages.privateOwner', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) : $t('admin:pages.workspacePageRulesApply') }}</dd></div><div><dt>{{ $t('admin:pages.recordIdentity') }}</dt><dd>{{ page.contentType }} · #{{ page.id }}</dd></div></dl>
              <div v-if="page.tags.length" class="pages-record-tags"><button type="button" v-for="entry in page.tags" :key="entry" @click="tag = entry; untagged = false; filtersChanged()">#{{ entry }}</button></div>
            </div>
          </details>
        </article>
      </div>
      <div v-if="pageCount > 1" class="pages-pagination"><span>{{ $t('admin:pages.of', { value: (pagination - 1) * 15 + 1, length: Math.min(pagination * 15, filteredPages.length), filteredPagesCount: filteredPages.length, interpolation: { escapeValue: false } }) }}</span><v-pagination v-model="pagination" :length="pageCount" :total-visible="$vuetify.display.smAndDown ? 3 : 6" :aria-label="$t('admin:pages.pagesPagination')" /></div>
      <p class="pages-footnote">{{ $t('admin:pages.registerRespectsAccessPage') }}</p>
    </section>
    <admin-pages-publication v-model="bulkOpen" :selected="selectedPages" @busy="bulkBusy = $event" @changed="loadPages" />
  </v-container>
</template>
<script lang='ts'>
import { requestConfirmation } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import AdminHero from '@/components/common/admin-hero.vue'
import AdminPagesPublication from './admin-pages-publication.vue'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api'
import { publicationState, PUBLICATION_STATE_KEYS, type PublicationState } from '../../helpers/admin-pages'
import { wikiStore } from '@/store/index.ts'

export default {
  components: { AdminHero, AsyncState, AdminPagesPublication, StatusIndicator },
  data() { return { pages: [] as PageListRow[], loading: false, errorMessage: '', loadRequestId: 0, search: '', selectedLang: null as string | null, visibility: 'all', publication: 'all', tag: null as string | null, untagged: false, sort: 'updated', pagination: 1, selectedIds: [] as number[], bulkOpen: false, bulkBusy: false, now: Date.now(), clock: null as ReturnType<typeof setInterval> | null,
    filtersOpen: false,
    heroActionGeometry: [
      { label: 'admin:shell.reload', icon: 'mdi-refresh', variant: 'text' as const, restricted: false, to: undefined },
      { label: 'admin:pages.exploreStructure', icon: 'mdi-graph-outline', variant: 'outlined' as const, restricted: false, to: '/pages/visualize' },
      { label: 'admin:pages.recycleBin', icon: 'mdi-delete-clock-outline', variant: 'outlined' as const, restricted: true, to: '/pages/recycle-bin' },
      { label: 'admin:pages.pageIntegrity', icon: 'mdi-shield-search', variant: 'outlined' as const, restricted: true, to: '/pages/integrity' }
    ],
    views: [{ title: this.$t('admin:pages.allPages'), value: 'all' }, { title: this.$t('admin:pages.drafts'), value: 'draft' }, { title: this.$t('admin:pages.privatePages'), value: 'private' }, { title: this.$t('admin:pages.withoutTags'), value: 'untagged' }],
    sortOptions: [{ title: this.$t('admin:pages.recentlyUpdated'), value: 'updated' }, { title: this.$t('admin:pages.oldestUpdateFirst'), value: 'oldest' }, { title: this.$t('admin:pages.titleZ'), value: 'title' }, { title: this.$t('admin:pages.pathZ'), value: 'path' }],
    visibilityOptions: [{ title: this.$t('admin:pages.allVisibility'), value: 'all' }, { title: this.$t('admin:pages.workspace'), value: 'public' }, { title: this.$t('admin:pages.private'), value: 'private' }],
    publicationOptions: [{ title: this.$t('admin:pages.allPublicationStates'), value: 'all' }, ...Object.entries(PUBLICATION_STATE_KEYS).map(([value, key]) => ({ title: this.$t(`admin:pages.publicationStates.${key}`), value }))]
  } },
  computed: {
    canManageSystem(): boolean { return wikiStore.user.permissions.includes('manage:system') },
    currentView(): string { return this.untagged ? 'untagged' : this.visibility === 'private' ? 'private' : this.publication === 'Draft' ? 'draft' : !this.hasActiveFilters ? 'all' : '' },
    hasActiveFilters(): boolean { return Boolean(this.search || this.selectedLang || this.tag || this.untagged || this.visibility !== 'all' || this.publication !== 'all') },
    hasAdvancedFilters(): boolean { return Boolean(this.selectedLang || this.tag || this.untagged || this.visibility !== 'all' || this.publication !== 'all' || this.sort !== 'updated') },
    langs() { return [{ title: this.$t('admin:pages.allLanguages'), value: null }, ...[...new Set(this.pages.map(page => page.locale))].sort().map(locale => ({ title: locale, value: locale }))] },
    tagOptions() { return [...new Set(this.pages.flatMap(page => page.tags))].sort() },
    filteredPages(): PageListRow[] {
      const search = (this.search || '').trim().toLocaleLowerCase()
      return this.pages.filter(page => (!this.selectedLang || page.locale === this.selectedLang) && (this.visibility === 'all' || page.visibility === this.visibility) && (this.publication === 'all' || this.state(page) === this.publication) && (!this.untagged || !page.tags.length) && (!this.tag || page.tags.includes(this.tag)) && (!search || [page.title, page.description, page.path, page.locale, String(page.id), ...page.tags].some(value => value?.toLocaleLowerCase().includes(search)))).sort((a, b) => this.sort === 'title' ? (a.title || '').localeCompare(b.title || '') || a.id - b.id : this.sort === 'path' ? `${a.locale}/${a.path}`.localeCompare(`${b.locale}/${b.path}`) || a.id - b.id : (this.sort === 'oldest' ? 1 : -1) * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) || a.id - b.id)
    },
    pageCount(): number { return Math.ceil(this.filteredPages.length / 15) },
    visiblePages(): PageListRow[] { return this.filteredPages.slice((this.pagination - 1) * 15, this.pagination * 15) },
    selectedPages(): PageListRow[] { return this.pages.filter(page => this.selectedIds.includes(page.id)) },
    hiddenSelected(): number { return this.selectedIds.filter(id => !this.filteredPages.some(page => page.id === id)).length }
  },
  methods: {
    state(page: PageListRow) { return publicationState(page, this.now) },
    stateTitle(state: PublicationState): string { return this.$t(`admin:pages.publicationStates.${PUBLICATION_STATE_KEYS[state]}`) },
    date(value: string): string { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) },
    toggleSelected(id: number) { this.selectedIds = this.selectedIds.includes(id) ? this.selectedIds.filter(value => value !== id) : [...this.selectedIds, id].slice(0, 25) },
    selectVisible() { this.selectedIds = [...new Set([...this.selectedIds, ...this.visiblePages.map(page => page.id)])].slice(0, 25) },
    clearFilters() { this.search = ''; this.selectedLang = null; this.visibility = 'all'; this.publication = 'all'; this.tag = null; this.untagged = false; this.filtersChanged() },
    setView(view: string) { this.search = ''; this.selectedLang = null; this.visibility = view === 'private' ? 'private' : 'all'; this.publication = view === 'draft' ? 'Draft' : 'all'; this.tag = null; this.untagged = view === 'untagged'; this.filtersChanged() },
    filtersChanged() { this.pagination = 1; const query = { ...(this.search ? { q: this.search } : {}), ...(this.selectedLang ? { locale: this.selectedLang } : {}), ...(this.visibility !== 'all' ? { visibility: this.visibility } : {}), ...(this.publication !== 'all' ? { publication: this.publication } : {}), ...(this.tag ? { tag: this.tag } : {}), ...(this.untagged ? { untagged: 'true' } : {}), ...(this.sort !== 'updated' ? { sort: this.sort } : {}) }; this.$router.replace({ query }) },
    restoreFilters() { const query = this.$route.query; this.search = typeof query.q === 'string' ? query.q : ''; this.selectedLang = typeof query.locale === 'string' ? query.locale : null; this.visibility = ['public', 'private'].includes(String(query.visibility)) ? String(query.visibility) : 'all'; this.publication = this.publicationOptions.some(option => option.value === query.publication) ? String(query.publication) : 'all'; this.tag = typeof query.tag === 'string' ? query.tag : null; this.untagged = query.untagged === 'true'; this.sort = this.sortOptions.some(option => option.value === query.sort) ? String(query.sort) : 'updated' },
    exportInventory() { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), pages: this.filteredPages }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'page-inventory.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) },
    async loadPages(): Promise<boolean> {
      const requestId = ++this.loadRequestId
      this.errorMessage = ''
      this.loading = true
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const pages = await fetchPageList(window.fetch.bind(window))
        if (requestId !== this.loadRequestId) return false
        this.pages = pages
        this.selectedIds = (this.selectedIds || []).filter(id => pages.some(page => page.id === id))
        return true
      } catch (err) {
        if (requestId !== this.loadRequestId) return false
        this.errorMessage = getErrorMessage(err)
        wikiStore.showError(err)
        return false
      } finally {
        wikiStore.stopLoading('admin-pages-refresh')
        if (requestId === this.loadRequestId) this.loading = false
      }
    },
    async refresh() {
      if (await this.loadPages()) wikiStore.showNotification({ message: this.$t('admin:pages.pageListHasBeen'), style: 'success', icon: 'cached' })
    }
  },  mounted() { this.restoreFilters(); this.loadPages(); this.clock = setInterval(() => { this.now = Date.now() }, 60000) },
  watch: { '$route.query'() { this.restoreFilters() }, pageCount(value: number) { this.pagination = Math.max(1, Math.min(this.pagination, value)) } },
  async beforeRouteLeave() { if (this.bulkBusy) { wikiStore.showNotification({ message: this.$t('admin:pages.stopFinishPublicationOperation'), style: 'warning', icon: 'info' }); return false } return !this.bulkOpen || await requestConfirmation({ title: this.$t('admin:pages.leavePublicationReview'), message: this.$t('admin:pages.completedChangesAlreadySaved'), confirmLabel: this.$t('admin:pages.leaveReview'), cancelLabel: this.$t('admin:pages.stay') }) },
  beforeUnmount() { this.loadRequestId++; if (this.clock) clearInterval(this.clock) }
}
</script>
<style scoped lang="scss">
/* Inert cells reserve every permission outcome; existing controls never relocate on hydration. */
.pages-hero-actions {
  display: flex;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  justify-content: flex-start;
  gap: .6rem;
}
.pages-hero-action { display: grid; min-width: 0; max-width: 100%; }
.pages-hero-action-size { visibility: hidden; pointer-events: none; }
.pages-hero-actions :deep(.v-btn) {
  grid-area: 1 / 1;
  min-width: 0;
  height: auto;
  min-height: 36px;
  padding-block: .5rem;
  flex-shrink: 1;
}
.pages-hero-actions :deep(.v-btn__content) { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.admin-pages { max-width: 1600px; padding-bottom: 2rem !important; }
.pages-totals { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem 1rem; margin: 0; }
.pages-totals > div { display: flex; align-items: baseline; gap: .35rem; font-size: .75rem; }
.pages-totals dt { color: var(--wiki-text-muted); }
.pages-totals dd { margin: 0; font-weight: 650; font-variant-numeric: tabular-nums; }
.pages-workbench { min-width: 0; border: 1px solid var(--wiki-material-border); border-radius: 12px; background: var(--wiki-surface-gradient); box-shadow: var(--wiki-specular-border); }
.pages-search { display: grid; grid-template-columns: minmax(12rem, 1fr) auto auto; align-items: center; gap: .5rem; padding: .5rem .75rem; }
.pages-quickviews { display: flex; flex-wrap: wrap; gap: .15rem; }
.pages-filter-active { font-size: .75rem; }
.pages-filters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) auto; align-items: center; gap: .5rem; padding: .25rem .75rem .75rem; }
.pages-inventory-toolbar, .pages-selection, .pages-pagination { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .35rem .75rem; padding: .25rem .75rem; }
.pages-inventory-toolbar > span { font-size: .75rem; color: var(--wiki-text-muted); }
.pages-selection { background: var(--wiki-surface-sunken); border-block: 1px solid var(--wiki-well-border); }
.pages-selection small { display: block; font-size: .75rem; }
.pages-register { background: var(--wiki-surface-sunken); background-image: none; box-shadow: var(--wiki-shadow-inset); }
.pages-record { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) minmax(9rem, 18%) 7rem 4.5rem; align-items: center; gap: .4rem .75rem; min-height: 60px; padding: .4rem .75rem; border-top: 1px solid var(--wiki-well-border); }
.pages-record > input { width: 18px; height: 18px; accent-color: rgb(var(--v-theme-primary)); cursor: pointer; }
.pages-record-main { min-width: 0; }
.admin-record-link { display: block; font-size: .875rem; font-weight: 600; line-height: 1.35; text-decoration: none; color: rgb(var(--v-theme-on-surface)); overflow-wrap: anywhere; }
.admin-record-link:hover { text-decoration: underline; }
.pages-record-path { display: block; font: .75rem/1.4 var(--font-family-monospace, monospace); overflow-wrap: anywhere; color: var(--wiki-text-muted); }
.pages-record-state { display: flex; align-items: center; gap: .3rem; font-size: .75rem; line-height: 1.4; }
.pages-record-date { font-size: .75rem; color: var(--wiki-text-muted); }
.pages-record-details { min-width: 0; font-size: .75rem; }
.pages-record-details summary { cursor: pointer; min-height: 36px; align-content: center; color: var(--wiki-primary-ink); }
.pages-record-details[open] { grid-column: 2 / -1; }
.pages-record-details-body { padding: .75rem; border-radius: 6px; }
.pages-record-details-body p { margin: 0 0 .5rem; font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; }
.pages-record-details-body dl { display: flex; flex-wrap: wrap; gap: .75rem 2rem; margin: 0; }
.pages-record-details-body dt { color: var(--wiki-text-muted); }
.pages-record-details-body dd { margin: .15rem 0 0; overflow-wrap: anywhere; }
.pages-record-tags { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
.pages-record-tags button { border: 1px solid var(--wiki-surface-border); border-radius: 999px; min-height: 36px; padding: .25rem .6rem; background: transparent; color: var(--wiki-primary-ink); overflow-wrap: anywhere; text-align: start; }
.pages-footnote { margin: 0; padding: .5rem .75rem; font-size: .75rem; line-height: 1.5; color: var(--wiki-text-muted); border-top: 1px solid var(--wiki-surface-border); }
.pages-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
button:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: var(--wiki-focus-offset); }
@media (max-width: 1100px) {
  .pages-search { grid-template-columns: minmax(0, 1fr) auto; }
  .pages-quickviews { grid-column: 1 / -1; }
  .pages-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .pages-search { padding: .5rem; gap: .25rem; }
  .pages-search > .v-btn { min-width: 44px; min-height: 44px; padding-inline: .5rem; }
  .pages-quickviews { gap: 0; }
  .pages-quickviews :deep(.v-btn) { padding-inline: .5rem; min-height: 36px; }
  .pages-filters { padding-inline: .5rem; }
  .pages-record { grid-template-columns: 1.25rem minmax(0, 1fr) auto; padding: .5rem; gap: .25rem .5rem; }
  .pages-record-main { grid-column: 2 / -1; }
  .pages-record-state { grid-column: 2; }
  .pages-record-date { grid-column: 2; }
  .pages-record-details { grid-column: 3; grid-row: span 2; }
  .pages-record-details[open] { grid-column: 2 / -1; grid-row: auto; }
  .pages-record-details summary { min-height: 44px; }
  .pages-selection > div:last-child { display: flex; flex-wrap: wrap; }
  .pages-totals { gap: .25rem .75rem; }
}
@media (forced-colors: active) {
  .pages-workbench, .pages-register { background: Canvas; border-color: CanvasText; }
  .pages-record-tags button { border-color: ButtonText; color: LinkText; }
}
</style>
