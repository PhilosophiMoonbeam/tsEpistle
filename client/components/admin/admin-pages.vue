<template>
  <v-container fluid class="admin-pages">
    <admin-hero :title="$t('admin:pages.title')" :description="$t('admin:pages.careKnowledgeWorkspace')" icon="mdi-file-document-multiple-outline">
      <template #actions><v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || bulkOpen" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:pages.reloadPageList') }}</v-tooltip></v-btn><v-btn variant="outlined" prepend-icon="mdi-graph-outline" to="/pages/visualize">{{ $t('admin:pages.exploreStructure') }}</v-btn><v-btn v-if="canManageSystem" variant="outlined" prepend-icon="mdi-delete-clock-outline" to="/pages/recycle-bin">{{ $t('admin:pages.recycleBin') }}</v-btn><v-btn v-if="canManageSystem" variant="outlined" prepend-icon="mdi-shield-search" to="/pages/integrity">{{ $t('admin:pages.pageIntegrity') }}</v-btn></template>
    </admin-hero>
    <section class="pages-overview"><div><span class="pages-kicker">{{ $t('admin:pages.knowledgeRegister') }}</span><h2>{{ $t('admin:pages.clearViewEveryPage') }}</h2><p>{{ $t('admin:pages.findWhatNeedsAttention') }}</p></div><dl class="pages-totals"><div><dt>{{ $t('admin:pages.accessiblePages') }}</dt><dd>{{ pages.length }}</dd></div><div><dt>{{ pages.some(page => page.isPublished === undefined) ? $t('admin:pages.knownDrafts') : $t('admin:pages.drafts') }}</dt><dd>{{ pages.filter(page => page.isPublished === false).length }}</dd></div><div><dt>{{ $t('admin:pages.publicationUnavailable') }}</dt><dd>{{ pages.filter(page => page.isPublished === undefined).length }}</dd></div><div><dt>{{ $t('admin:pages.private') }}</dt><dd>{{ pages.filter(page => page.visibility === 'private').length }}</dd></div></dl></section>
    <div class="pages-quickviews" role="group" :aria-label="$t('admin:pages.pageViews')"><v-btn v-for="view in views" :key="view.value" :variant="view.value === currentView ? 'tonal' : 'text'" :aria-pressed="view.value === currentView" @click="setView(view.value)">{{ view.title }}</v-btn></div>
    <section class="pages-workbench" :aria-label="$t('admin:pages.pageInventory')">
      <div class="pages-search"><v-text-field v-model="search" :label="$t('admin:pages.findTitlePathTag')" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable density="comfortable" @update:model-value="filtersChanged" /><v-select v-model="sort" :items="sortOptions" :label="$t('admin:pages.orderPages')" variant="outlined" hide-details density="comfortable" @update:model-value="filtersChanged" /></div>
      <div class="pages-filters"><v-select v-model="selectedLang" :items="langs" :label="$t('admin:pages.language')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" /><v-select v-model="visibility" :items="visibilityOptions" :label="$t('admin:pages.visibility')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" /><v-select v-model="publication" :items="publicationOptions" :label="$t('admin:pages.publication')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" /><v-autocomplete v-model="tag" :items="tagOptions" :label="$t('admin:pages.tag')" variant="outlined" hide-details density="compact" clearable @update:model-value="untagged = false; filtersChanged()" /><v-btn v-if="hasActiveFilters" variant="text" @click="clearFilters">{{ $t('admin:pages.clearFilters') }}</v-btn></div>
      <div class="pages-inventory-toolbar"><span role="status">{{ $t('admin:pages.accessiblePages2', { filteredPagesCount: filteredPages.length, pagesCount: pages.length, interpolation: { escapeValue: false } }) }}</span><div><v-btn variant="text" size="small" :disabled="!visiblePages.length || bulkOpen" @click="selectVisible">{{ $t('admin:pages.selectPage') }}</v-btn><v-btn variant="text" size="small" :disabled="!filteredPages.length" @click="exportInventory">{{ $t('admin:pages.exportInventory') }}</v-btn></div></div>
      <div v-if="selectedIds.length" class="pages-selection" role="region" :aria-label="$t('admin:pages.selectedPages')"><div><strong>{{ $t('admin:pages.selected', { selectedIdsCount: selectedIds.length, interpolation: { escapeValue: false } }) }}</strong><span v-if="hiddenSelected"> {{ $t('admin:pages.outsideTheseFilters', { hiddenSelected, interpolation: { escapeValue: false } }) }}</span><small>{{ $t('admin:pages.up25PagesPer') }}</small></div><div><v-btn variant="text" @click="selectedIds = []">{{ $t('admin:pages.clearSelection') }}</v-btn><v-btn variant="flat" color="primary" :disabled="loading" @click="bulkOpen = true">{{ $t('admin:pages.reviewPublication') }}</v-btn></div></div>
      <v-alert v-if="errorMessage && pages.length" type="error" variant="tonal" class="ma-4">{{ errorMessage }} <v-btn variant="text" @click="loadPages">{{ $t('admin:pages.tryAgain') }}</v-btn></v-alert>
      <async-state v-if="loading && !pages.length" state="loading" :title="$t('admin:pages.loadingRegister')" :message="$t('admin:pages.fetchingPagesYouCan')" />
      <async-state v-else-if="errorMessage && !pages.length" state="error" :title="$t('admin:pages.pagesCouldNotLoaded')" :message="errorMessage" :retry-label="$t('admin:pages.tryAgain')" @retry="loadPages" />
      <async-state v-else-if="!filteredPages.length" state="empty" :title="hasActiveFilters ? $t('admin:pages.noPagesMatchView') : $t('admin:pages.knowledgeStartsHere')" :message="hasActiveFilters ? $t('admin:pages.tryDifferentTermClear') : $t('admin:pages.createPageWikiBegin')" />
      <div v-else class="pages-register" :aria-busy="loading">
        <article v-for="page in visiblePages" :key="page.id" class="pages-record">
          <input type="checkbox" :aria-label="$t('admin:pages.select', { value: page.title || page.path, interpolation: { escapeValue: false } })" :checked="selectedIds.includes(page.id)" :disabled="bulkOpen || (!selectedIds.includes(page.id) && selectedIds.length >= 25)" @change="toggleSelected(page.id)" />
          <div class="pages-record-main"><router-link class="admin-record-link" :to="`/pages/${page.id}`">{{ page.title || $t('admin:pages.untitledPage') }}</router-link><span class="pages-record-path">{{ page.locale }} / {{ page.path }}</span><p v-if="page.description">{{ page.description }}</p><div v-if="page.tags.length" class="pages-record-tags"><button v-for="entry in page.tags.slice(0, 3)" :key="entry" @click="tag = entry; untagged = false; filtersChanged()">#{{ entry }}</button><small v-if="page.tags.length > 3">+{{ page.tags.length - 3 }}</small></div></div>
          <dl class="pages-record-state"><div><dt>{{ $t('admin:pages.publication') }}</dt><dd class="d-inline-flex align-center"><status-indicator aria-hidden="true" :positive="state(page) === 'Published'" :intermediary="state(page) === 'Scheduled'" :negative="state(page) === 'Invalid schedule'" :label="stateTitle(state(page))" class="me-2" />{{ stateTitle(state(page)) }}</dd></div><div><dt>{{ $t('admin:pages.visibility') }}</dt><dd>{{ page.visibility === 'private' ? $t('admin:pages.privateOwner', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) : $t('admin:pages.workspacePageRulesApply') }}</dd></div></dl>
          <div class="pages-record-date"><small>{{ $t('admin:pages.updated') }}</small><time :datetime="page.updatedAt">{{ date(page.updatedAt) }}</time><small>{{ page.contentType }} · #{{ page.id }}</small></div>
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
import AdminPagesPublication from './admin-pages-publication.vue'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api'
import { publicationState } from '../../helpers/admin-pages'
import { wikiStore } from '@/store/index.ts'

const publicationStateKeys: Record<string, string> = { Draft: 'draft', Published: 'published', Scheduled: 'scheduled', 'Window ended': 'windowEnded', 'Invalid schedule': 'invalidSchedule', Unavailable: 'unavailable' }
export default {
  components: { AsyncState, AdminPagesPublication, StatusIndicator },
  data() { return { pages: [] as PageListRow[], loading: false, errorMessage: '', loadRequestId: 0, search: '', selectedLang: null as string | null, visibility: 'all', publication: 'all', tag: null as string | null, untagged: false, sort: 'updated', pagination: 1, selectedIds: [] as number[], bulkOpen: false, bulkBusy: false, now: Date.now(), clock: null as ReturnType<typeof setInterval> | null,
    views: [{ title: this.$t('admin:pages.allPages'), value: 'all' }, { title: this.$t('admin:pages.drafts'), value: 'draft' }, { title: this.$t('admin:pages.privatePages'), value: 'private' }, { title: this.$t('admin:pages.withoutTags'), value: 'untagged' }],
    sortOptions: [{ title: this.$t('admin:pages.recentlyUpdated'), value: 'updated' }, { title: this.$t('admin:pages.oldestUpdateFirst'), value: 'oldest' }, { title: this.$t('admin:pages.titleZ'), value: 'title' }, { title: this.$t('admin:pages.pathZ'), value: 'path' }],
    visibilityOptions: [{ title: this.$t('admin:pages.allVisibility'), value: 'all' }, { title: this.$t('admin:pages.workspace'), value: 'public' }, { title: this.$t('admin:pages.private'), value: 'private' }],
    publicationOptions: [{ title: this.$t('admin:pages.allPublicationStates'), value: 'all' }, ...Object.entries(publicationStateKeys).map(([value, key]) => ({ title: this.$t(`admin:pages.publicationStates.${key}`), value }))]
  } },
  computed: {
    canManageSystem(): boolean { return wikiStore.user.permissions.includes('manage:system') },
    currentView(): string { return this.untagged ? 'untagged' : this.visibility === 'private' ? 'private' : this.publication === 'Draft' ? 'draft' : !this.hasActiveFilters ? 'all' : '' },
    hasActiveFilters(): boolean { return Boolean(this.search || this.selectedLang || this.tag || this.untagged || this.visibility !== 'all' || this.publication !== 'all') },
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
    stateTitle(state: string): string { const key = publicationStateKeys[state]; return key ? this.$t(`admin:pages.publicationStates.${key}`) : state },
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
.admin-pages { max-width:1600px; padding-bottom:4rem !important; }.pages-kicker { font-size:.7rem; letter-spacing:.14em; text-transform:uppercase; color:rgb(var(--v-theme-on-surface-variant)); }.pages-overview { display:flex; align-items:center; justify-content:space-between; gap:3rem; padding:2.5rem .5rem 2rem; }.pages-overview h2 { font:500 clamp(1.7rem,2.6vw,2.6rem)/1.15 var(--font-family-serif, Georgia,serif); margin:.7rem 0 1rem; }.pages-overview p { max-width:43rem; line-height:1.7; color:rgb(var(--v-theme-on-surface-variant)); }.pages-totals { display:flex; gap:2rem; flex-shrink:0; }.pages-totals dt { font-size:.75rem; color:rgb(var(--v-theme-on-surface-variant)); }.pages-totals dd { margin:.4rem 0 0; font:500 2.3rem var(--font-family-serif,Georgia,serif); }.pages-quickviews { display:flex; flex-wrap:wrap; gap:.4rem; margin-bottom:1rem; }.pages-workbench { border:1px solid rgba(var(--v-border-color),.18); background:rgb(var(--v-theme-surface)); border-radius:14px; overflow:hidden; }.pages-search { display:grid; grid-template-columns:minmax(0,1fr) 15rem; gap:1rem; padding:1.5rem 1.5rem 1rem; }.pages-filters { display:grid; grid-template-columns:1fr 1fr 1.25fr 1.25fr auto; gap:.8rem; padding:0 1.5rem 1rem; }.pages-inventory-toolbar,.pages-selection,.pages-pagination { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; padding:.7rem 1.5rem; }.pages-inventory-toolbar>span { font-size:.8rem; color:rgb(var(--v-theme-on-surface-variant)); }.pages-selection { background:rgba(var(--v-theme-primary),.08); border-block:1px solid rgba(var(--v-theme-primary),.25); }.pages-selection small { display:block; margin-top:.2rem; }.pages-record { display:grid; grid-template-columns:1.2rem minmax(0,1fr) minmax(12rem,22%) 8rem; gap:1.5rem; padding:1.5rem; border-top:1px solid rgba(var(--v-border-color),.14); }.pages-record>input { width:18px; height:18px; margin-top:.25rem; accent-color:rgb(var(--v-theme-primary)); }.pages-record-main { min-width:0; }.admin-record-link { font-size:1.1rem; font-weight:600; text-decoration:none; color:rgb(var(--v-theme-on-surface)); overflow-wrap:anywhere; }.admin-record-link:hover { text-decoration:underline; }.pages-record-path { display:block; font-family:monospace; font-size:.78rem; margin-top:.5rem; overflow-wrap:anywhere; color:rgb(var(--v-theme-on-surface-variant)); }.pages-record p { font-size:.85rem; line-height:1.6; margin:.65rem 0 0; color:rgb(var(--v-theme-on-surface-variant)); }.pages-record-tags { display:flex; align-items:center; flex-wrap:wrap; gap:.7rem; margin-top:.6rem; }.pages-record-tags button { background:transparent; font-size:.75rem; color:rgb(var(--v-theme-on-surface)); text-decoration:underline; overflow-wrap:anywhere; text-align:left; }.pages-record-tags button:hover { text-decoration:underline; }.pages-record-state { margin:0; }.pages-record-state>div+div { margin-top:.65rem; }.pages-record-state dt,.pages-record-date small { font-size:.7rem; color:rgb(var(--v-theme-on-surface-variant)); }.pages-record-state dd { margin:.2rem 0 0; font-size:.8rem; line-height:1.5; }.pages-record-date>* { display:block; }.pages-record-date time { font-size:.8rem; margin:.3rem 0 .8rem; }.pages-footnote { padding:1rem 1.5rem; font-size:.75rem; line-height:1.7; color:rgb(var(--v-theme-on-surface-variant)); border-top:1px solid rgba(var(--v-border-color),.14); }button:focus-visible,a:focus-visible,input:focus-visible { outline:2px solid rgb(var(--v-theme-primary)); outline-offset:4px; }
.pages-totals { flex-wrap: wrap; }
@media(max-width:1100px) { .pages-overview { align-items:start; flex-direction:column; gap:1rem; }.pages-filters { grid-template-columns:repeat(2,minmax(0,1fr)); }.pages-record { grid-template-columns:1.2rem minmax(0,1fr) 12rem; }.pages-record-date { grid-column:2/-1; display:flex; gap:1rem; align-items:center; }.pages-record-date time { margin:0; } }
@media(max-width:600px) { .pages-search { grid-template-columns:1fr; padding:1rem; }.pages-filters { padding:0 1rem 1rem; }.pages-totals { gap:1.5rem; }.pages-totals dd { font-size:1.8rem; }.pages-record { padding:1.2rem 1rem; gap:.8rem; grid-template-columns:1.2rem minmax(0,1fr); }.pages-record-state { grid-column:2; display:flex; gap:1rem; flex-wrap:wrap; }.pages-record-state>div+div { margin:0; }.pages-record-date { flex-wrap:wrap; gap:.5rem; }.pages-inventory-toolbar,.pages-selection,.pages-pagination { padding:.7rem 1rem; }.pages-selection>div:last-child { display:flex; flex-wrap:wrap; gap:.5rem; }.pages-pagination { justify-content:center; } }
</style>
