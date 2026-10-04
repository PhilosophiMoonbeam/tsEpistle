<template>
  <v-container fluid class="admin-pages">
    <admin-hero :title="$t('admin:pages.title')" :description="$t('admin:pages.careKnowledgeWorkspace')" icon="mdi-file-document-multiple-outline">
      <template #actions><v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="loading || bulkOpen" @click="refresh">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:pages.reloadPageList') }}</v-tooltip></v-btn><v-btn variant="outlined" prepend-icon="mdi-graph-outline" to="/pages/visualize">{{ $t('admin:pages.exploreStructure') }}</v-btn><v-btn v-if="canManageSystem" variant="outlined" prepend-icon="mdi-delete-clock-outline" to="/pages/recycle-bin">{{ $t('admin:pages.recycleBin') }}</v-btn><v-btn v-if="canManageSystem" variant="outlined" prepend-icon="mdi-shield-search" to="/pages/integrity">{{ $t('admin:pages.pageIntegrity') }}</v-btn></template>
    </admin-hero>
    <p class="pages-context">{{ $t('admin:pages.directoryContext', { defaultValue: 'Search and filter the whole accessible corpus. Results load in bounded windows; no corpus totals are inferred.' }) }}</p>
    <div class="pages-quickviews" role="group" :aria-label="$t('admin:pages.pageViews')"><v-btn v-for="view in views" :key="view.value" :variant="view.value === currentView ? 'tonal' : 'text'" :aria-pressed="view.value === currentView" @click="setView(view.value)">{{ view.title }}</v-btn></div>
    <section class="pages-workbench" :aria-label="$t('admin:pages.pageInventory')">
      <div class="pages-search">
        <v-text-field v-model="search" :label="$t('admin:pages.findTitlePathTag')" prepend-inner-icon="mdi-magnify" variant="outlined" hide-details clearable density="compact" maxlength="200" @update:model-value="filtersChanged" />
        <v-select v-model="sort" :items="sortOptions" :label="$t('admin:pages.orderPages')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
      </div>
      <div class="pages-filters">
        <v-combobox v-model="selectedLang" :items="langs" :label="$t('admin:pages.language')" variant="outlined" hide-details density="compact" clearable :return-object="false" @update:model-value="filtersChanged" />
        <v-select v-model="visibility" :items="visibilityOptions" :label="$t('admin:pages.visibility')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
        <v-select v-model="publication" :items="publicationOptions" :label="$t('admin:pages.publication')" variant="outlined" hide-details density="compact" @update:model-value="filtersChanged" />
        <v-text-field v-model="tag" :label="$t('admin:pages.tag')" variant="outlined" hide-details density="compact" clearable @update:model-value="untagged = false; filtersChanged()" />
        <v-text-field v-model="creatorIdInput" :label="$t('admin:pages.creatorAccountId', { defaultValue: 'Creator account ID' })" type="number" min="1" step="1" variant="outlined" hide-details density="compact" clearable @update:model-value="filtersChanged" />
        <v-text-field v-model="authorIdInput" :label="$t('admin:pages.authorAccountId', { defaultValue: 'Last editor account ID' })" type="number" min="1" step="1" variant="outlined" hide-details density="compact" clearable @update:model-value="filtersChanged" />
        <v-checkbox v-model="untagged" :label="$t('admin:pages.withoutTags')" hide-details density="compact" @update:model-value="tag = null; filtersChanged()" />
        <v-btn v-if="hasActiveFilters" variant="text" @click="clearFilters">{{ $t('admin:pages.clearFilters') }}</v-btn>
      </div>
      <p v-if="creatorIdInput && authorIdInput" class="pages-filter-note">{{ $t('admin:pages.authorshipUnion', { defaultValue: 'Matching pages were created by the creator account or last edited by the editor account.' }) }}</p>
      <div class="pages-inventory-toolbar">
        <span role="status">{{ pages.length }} · {{ $t('admin:pages.windowCount', { defaultValue: 'Pages in this window' }) }}</span>
        <div><v-btn variant="text" :disabled="!pages.length || loading || stale || bulkOpen" @click="selectVisible">{{ $t('admin:pages.selectPage') }}</v-btn><v-btn variant="text" :loading="exporting" :disabled="exporting || loading" @click="exportInventory">{{ $t('admin:pages.exportInventory') }}</v-btn></div>
      </div>
      <div v-if="selectedIds.length" class="pages-selection" role="region" :aria-label="$t('admin:pages.selectedPages')">
        <div><strong>{{ $t('admin:pages.selected', { selectedIdsCount: selectedIds.length, interpolation: { escapeValue: false } }) }}</strong><span v-if="hiddenSelected"> · {{ hiddenSelected }} {{ $t('admin:pages.outsideCurrentWindow', { defaultValue: 'outside this window' }) }}</span><small>{{ $t('admin:pages.up25PagesPer') }}</small></div>
        <div><v-btn variant="text" :disabled="bulkOpen" @click="selection = []">{{ $t('admin:pages.clearSelection') }}</v-btn><v-btn variant="flat" color="primary" :disabled="loading || bulkOpen" @click="bulkOpen = true">{{ $t('admin:pages.reviewPublication') }}</v-btn></div>
      </div>
      <v-alert v-if="stale && pages.length" type="warning" variant="tonal" class="ma-3">{{ $t('admin:pages.staleWindow', { defaultValue: 'Showing the previous window while the current request is unresolved. These rows do not represent the current filters.' }) }}</v-alert>
      <v-alert v-if="errorMessage && pages.length" type="error" variant="tonal" class="ma-3">{{ errorMessage }} <v-btn variant="text" @click="loadPages">{{ $t('admin:pages.tryAgain') }}</v-btn></v-alert>
      <v-alert v-if="exportError" type="error" variant="tonal" class="ma-3">{{ exportError }}</v-alert>
      <async-state v-if="loading && !pages.length" state="loading" :title="$t('admin:pages.loadingRegister')" :message="$t('admin:pages.fetchingPagesYouCan')" />
      <async-state v-else-if="errorMessage && !pages.length" state="error" :title="$t('admin:pages.pagesCouldNotLoaded')" :message="errorMessage" :retry-label="$t('admin:pages.tryAgain')" @retry="loadPages" />
      <async-state v-else-if="!pages.length && (offset > 0 || scanned > 0 || nextOffset !== null)" state="empty" :title="$t('admin:pages.emptyWindow', { defaultValue: 'No visible pages in this window' })" :message="$t('admin:pages.emptyWindowHint', { defaultValue: 'This window has no visible matches. Review the filters or navigate another window.' })" />
      <async-state v-else-if="!pages.length" state="empty" :title="hasActiveFilters ? $t('admin:pages.noPagesMatchView') : $t('admin:pages.knowledgeStartsHere')" :message="hasActiveFilters ? $t('admin:pages.tryDifferentTermClear') : $t('admin:pages.createPageWikiBegin')" />
      <div v-else class="pages-register" :aria-busy="loading">
        <article v-for="page in pages" :key="page.id" class="pages-record">
          <label class="pages-record-select"><input type="checkbox" :aria-label="$t('admin:pages.select', { value: page.title || page.path, interpolation: { escapeValue: false } })" :checked="selectedIds.includes(page.id)" :disabled="bulkOpen || loading || stale || (!selectedIds.includes(page.id) && selectedIds.length >= 25)" @change="toggleSelected(page)" /></label>
          <div class="pages-record-main"><router-link class="admin-record-link" :to="`/pages/${page.id}`">{{ page.title || $t('admin:pages.untitledPage') }}</router-link><span class="pages-record-path">{{ page.locale }} / {{ page.path }}</span><p v-if="page.description">{{ page.description }}</p><div v-if="page.tags.length" class="pages-record-tags"><button v-for="entry in page.tags.slice(0, 3)" :key="entry" @click="tag = entry; untagged = false; filtersChanged()">#{{ entry }}</button><small v-if="page.tags.length > 3">+{{ page.tags.length - 3 }}</small></div></div>
          <dl class="pages-record-state"><div><dt>{{ $t('admin:pages.publication') }}</dt><dd class="d-inline-flex align-center"><status-indicator aria-hidden="true" :positive="state(page) === 'Published'" :intermediary="state(page) === 'Scheduled'" :negative="state(page) === 'Invalid schedule'" :label="stateTitle(state(page))" class="me-2" />{{ stateTitle(state(page)) }}</dd></div><div><dt>{{ $t('admin:pages.visibility') }}</dt><dd>{{ page.visibility === 'private' ? $t('admin:pages.privateOwner', { ownerId: page.ownerId, interpolation: { escapeValue: false } }) : $t('admin:pages.workspacePageRulesApply') }}</dd></div></dl>
          <div class="pages-record-date"><small>{{ $t('admin:pages.updated') }}</small><time :datetime="page.updatedAt">{{ date(page.updatedAt) }}</time><small>{{ page.contentType }} · #{{ page.id }}</small></div>
        </article>
      </div>
      <div class="pages-pagination">
        <span>{{ $t('admin:pages.windowNumber', { defaultValue: 'Window' }) }} {{ previousOffsets.length + 1 }} · {{ scanned }} {{ $t('admin:pages.candidatesScanned', { defaultValue: 'candidates scanned' }) }}</span>
        <div><v-btn variant="text" :disabled="loading || stale || !previousOffsets.length" @click="previousWindow">{{ $t('admin:groups.previous') }}</v-btn><v-btn variant="outlined" :disabled="loading || stale || nextOffset === null" @click="nextWindow">{{ $t('admin:groups.next') }}</v-btn></div>
      </div>
      <p class="pages-footnote">{{ $t('admin:pages.registerRespectsAccessPage') }}</p>
    </section>
    <admin-pages-publication v-model="bulkOpen" :selected="selectedPages" @busy="bulkBusy = $event" @changed="loadPages" />
  </v-container>
</template>
<script lang="ts">
import { defineComponent } from 'vue'
import { requestConfirmation } from '../common/confirm-dialog.ts'
import AsyncState from '@/components/common/async-state.vue'
import AdminPagesPublication from './admin-pages-publication.vue'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageDirectory, type PageDirectoryOptions, type PageListRow } from '../../helpers/pages-api'
import { publicationState } from '../../helpers/admin-pages'
import { wikiStore } from '@/store/index.ts'

/* global siteLangs */
const publicationStateKeys: Record<string, string> = { Draft: 'draft', Published: 'published', Scheduled: 'scheduled', 'Window ended': 'windowEnded', 'Invalid schedule': 'invalidSchedule', Unavailable: 'unavailable' }
const accountId = (value: unknown): number | undefined => {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export default defineComponent({
  components: { AsyncState, AdminPagesPublication, StatusIndicator },
  data() {
    return {
      pages: [] as PageListRow[], selection: [] as PageListRow[],
      loading: false, stale: false, errorMessage: '', loadRequestId: 0,
      loadController: null as AbortController | null,
      filterTimer: null as ReturnType<typeof setTimeout> | null,
      offset: 0, nextOffset: null as number | null, previousOffsets: [] as number[], scanned: 0,
      search: '', selectedLang: null as string | null,
      visibility: 'all' as NonNullable<PageDirectoryOptions['visibility']>,
      publication: 'all' as NonNullable<PageDirectoryOptions['publication']>,
      tag: null as string | null, untagged: false, sort: 'updated',
      creatorIdInput: '', authorIdInput: '',
      exporting: false, exportError: '', exportRequestId: 0, exportController: null as AbortController | null,
      bulkOpen: false, bulkBusy: false, now: Date.now(),
      clock: null as ReturnType<typeof setInterval> | null,
      views: [{ title: this.$t('admin:pages.allPages'), value: 'all' }, { title: this.$t('admin:pages.drafts'), value: 'draft' }, { title: this.$t('admin:pages.privatePages'), value: 'private' }, { title: this.$t('admin:pages.withoutTags'), value: 'untagged' }],
      sortOptions: [{ title: this.$t('admin:pages.recentlyUpdated'), value: 'updated' }, { title: this.$t('admin:pages.oldestUpdateFirst'), value: 'oldest' }, { title: this.$t('admin:pages.titleZ'), value: 'title' }, { title: this.$t('admin:pages.pathZ'), value: 'path' }],
      visibilityOptions: [{ title: this.$t('admin:pages.allVisibility'), value: 'all' }, { title: this.$t('admin:pages.workspace'), value: 'public' }, { title: this.$t('admin:pages.private'), value: 'private' }],
      publicationOptions: [{ title: this.$t('admin:pages.allPublicationStates'), value: 'all' }, ...Object.entries(publicationStateKeys).map(([value, key]) => ({ title: this.$t(`admin:pages.publicationStates.${key}`), value }))]
    }
  },
  computed: {
    canManageSystem(): boolean { return wikiStore.user.permissions.includes('manage:system') },
    currentView(): string { return this.untagged ? 'untagged' : this.visibility === 'private' ? 'private' : this.publication === 'Draft' ? 'draft' : !this.hasActiveFilters ? 'all' : '' },
    hasActiveFilters(): boolean { return Boolean(this.search || this.selectedLang || this.tag || this.untagged || this.creatorIdInput || this.authorIdInput || this.visibility !== 'all' || this.publication !== 'all') },
    langs(): string[] { return siteLangs.map((locale: { code: string }) => locale.code) },
    selectedIds(): number[] { return this.selection.map(page => page.id) },
    selectedPages(): PageListRow[] { return this.selection },
    hiddenSelected(): number { return this.selection.filter(selected => !this.pages.some(page => page.id === selected.id)).length },
    directoryOptions(): PageDirectoryOptions {
      return {
        search: (this.search || '').trim().slice(0, 200),
        ...(this.selectedLang ? { locale: this.selectedLang } : {}),
        visibility: this.visibility, publication: this.publication,
        ...(this.tag ? { tag: this.tag } : {}), untagged: this.untagged,
        ...(accountId(this.creatorIdInput) ? { creatorId: accountId(this.creatorIdInput) } : {}),
        ...(accountId(this.authorIdInput) ? { authorId: accountId(this.authorIdInput) } : {}),
        orderBy: this.sort === 'title' ? 'TITLE' : this.sort === 'path' ? 'PATH' : 'UPDATED',
        orderByDirection: this.sort === 'updated' ? 'DESC' : 'ASC'
      }
    }
  },
  methods: {
    state(page: PageListRow) { return publicationState(page, this.now) },
    stateTitle(state: string): string { const key = publicationStateKeys[state]; return key ? this.$t(`admin:pages.publicationStates.${key}`) : state },
    date(value: string): string { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) },
    toggleSelected(page: PageListRow) {
      if (this.bulkOpen || this.loading || this.stale) return
      this.selection = this.selectedIds.includes(page.id)
        ? this.selection.filter(selected => selected.id !== page.id)
        : [...this.selection, { ...page, tags: [...page.tags] }].slice(0, 25)
    },
    selectVisible() {
      if (this.bulkOpen || this.loading || this.stale) return
      for (const page of this.pages) {
        if (this.selection.length >= 25) break
        if (!this.selectedIds.includes(page.id)) this.selection.push({ ...page, tags: [...page.tags] })
      }
    },
    clearFilters() {
      this.search = ''; this.selectedLang = null; this.visibility = 'all'; this.publication = 'all'
      this.tag = null; this.untagged = false; this.creatorIdInput = ''; this.authorIdInput = ''
      this.filtersChanged()
    },
    setView(view: string) {
      this.search = ''; this.selectedLang = null; this.visibility = view === 'private' ? 'private' : 'all'
      this.publication = view === 'draft' ? 'Draft' : 'all'; this.tag = null; this.untagged = view === 'untagged'
      this.creatorIdInput = ''; this.authorIdInput = ''; this.filtersChanged()
    },
    queueFirstWindow() {
      this.loadRequestId++; this.loadController?.abort()
      this.stale = true; this.loading = true; this.offset = 0; this.previousOffsets = []
      if (this.filterTimer) clearTimeout(this.filterTimer)
      this.filterTimer = setTimeout(() => { this.filterTimer = null; void this.loadPages() }, 250)
    },
    filtersChanged() {
      this.queueFirstWindow()
      const query = {
        ...(this.search ? { q: this.search } : {}), ...(this.selectedLang ? { locale: this.selectedLang } : {}),
        ...(this.visibility !== 'all' ? { visibility: this.visibility } : {}), ...(this.publication !== 'all' ? { publication: this.publication } : {}),
        ...(this.tag ? { tag: this.tag } : {}), ...(this.untagged ? { untagged: 'true' } : {}),
        ...(this.creatorIdInput ? { creatorId: String(this.creatorIdInput) } : {}), ...(this.authorIdInput ? { authorId: String(this.authorIdInput) } : {}),
        ...(this.sort !== 'updated' ? { sort: this.sort } : {})
      }
      void this.$router.replace({ query })
    },
    restoreFilters() {
      const query = this.$route.query
      this.search = typeof query.q === 'string' ? query.q.slice(0, 200) : ''
      this.selectedLang = typeof query.locale === 'string' ? query.locale : null
      this.visibility = query.visibility === 'public' || query.visibility === 'private' ? query.visibility : 'all'
      this.publication = this.publicationOptions.some(option => option.value === query.publication) ? query.publication as NonNullable<PageDirectoryOptions['publication']> : 'all'
      this.tag = typeof query.tag === 'string' ? query.tag : null; this.untagged = query.untagged === 'true'
      this.creatorIdInput = accountId(query.creatorId) ? String(query.creatorId) : ''
      this.authorIdInput = accountId(query.authorId) ? String(query.authorId) : ''
      this.sort = this.sortOptions.some(option => option.value === query.sort) ? String(query.sort) : 'updated'
    },
    async exportInventory() {
      if (this.exporting) return
      const requestId = ++this.exportRequestId
      const controller = new AbortController(); this.exportController = controller
      const options = { ...this.directoryOptions }
      this.exporting = true; this.exportError = ''
      const inventory = new Map<number, PageListRow>()
      let offset: number | null = 0
      try {
        while (offset !== null) {
          const result = await fetchPageDirectory((url, init) => window.fetch(url, { ...init, signal: controller.signal }), { ...options, limit: 100, offset }, this.$t('common:error.unexpected'))
          if (requestId !== this.exportRequestId || controller.signal.aborted) return
          for (const page of result.items) inventory.set(page.id, page)
          offset = result.nextOffset
        }
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), pages: [...inventory.values()] }, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob); const link = document.createElement('a')
        link.href = url; link.download = 'page-inventory.json'; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (err) {
        if (requestId !== this.exportRequestId || controller.signal.aborted) return
        this.exportError = getErrorMessage(err); wikiStore.showError(err)
      } finally {
        if (requestId === this.exportRequestId) { this.exporting = false; this.exportController = null }
      }
    },
    async loadPages(): Promise<boolean> {
      if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null }
      const requestId = ++this.loadRequestId
      this.loadController?.abort()
      const controller = new AbortController(); this.loadController = controller
      this.errorMessage = ''; this.loading = true; this.stale = true
      const loadingKey = `admin-pages-refresh-${requestId}`
      wikiStore.startLoading(loadingKey)
      try {
        const result = await fetchPageDirectory((url, init) => window.fetch(url, { ...init, signal: controller.signal }), { ...this.directoryOptions, limit: 25, offset: this.offset }, this.$t('common:error.unexpected'))
        if (requestId !== this.loadRequestId || controller.signal.aborted) return false
        this.pages = result.items; this.nextOffset = result.nextOffset; this.scanned = result.scanned; this.stale = false
        return true
      } catch (err) {
        if (requestId !== this.loadRequestId || controller.signal.aborted) return false
        this.errorMessage = getErrorMessage(err); wikiStore.showError(err)
        return false
      } finally {
        wikiStore.stopLoading(loadingKey)
        if (requestId === this.loadRequestId) { this.loading = false; this.loadController = null }
      }
    },
    nextWindow() {
      if (this.loading || this.stale || this.nextOffset === null) return
      this.previousOffsets.push(this.offset); this.offset = this.nextOffset; void this.loadPages()
    },
    previousWindow() {
      if (this.loading || this.stale || !this.previousOffsets.length) return
      this.offset = this.previousOffsets.pop()!; void this.loadPages()
    },
    async refresh() {
      if (await this.loadPages()) wikiStore.showNotification({ message: this.$t('admin:pages.pageListHasBeen'), style: 'success', icon: 'cached' })
    }
  },
  mounted() { this.restoreFilters(); void this.loadPages(); this.clock = setInterval(() => { this.now = Date.now() }, 60000) },
  watch: {
    '$route.query'() {
      const previous = JSON.stringify(this.directoryOptions)
      this.restoreFilters()
      if (previous !== JSON.stringify(this.directoryOptions)) this.queueFirstWindow()
    }
  },
  async beforeRouteLeave() {
    if (this.bulkBusy) { wikiStore.showNotification({ message: this.$t('admin:pages.stopFinishPublicationOperation'), style: 'warning', icon: 'info' }); return false }
    return !this.bulkOpen || await requestConfirmation({ title: this.$t('admin:pages.leavePublicationReview'), message: this.$t('admin:pages.completedChangesAlreadySaved'), confirmLabel: this.$t('admin:pages.leaveReview'), cancelLabel: this.$t('admin:pages.stay') })
  },
  beforeUnmount() {
    this.loadRequestId++; this.exportRequestId++; this.loadController?.abort(); this.exportController?.abort()
    if (this.filterTimer) clearTimeout(this.filterTimer)
    if (this.clock) clearInterval(this.clock)
  }
})
</script>
<style scoped lang="scss">
.admin-pages { max-width: 1600px; min-width: 0; padding-bottom: 2rem !important; }
.pages-context, .pages-footnote { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; }
.pages-context { margin: .75rem 0; max-width: 70rem; }
.pages-filter-note { padding: 0 1rem .75rem; margin: 0; color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; }
.pages-quickviews { display: flex; flex-wrap: wrap; gap: .25rem; margin-bottom: .75rem; }
.pages-workbench { overflow: hidden; border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.pages-search { display: grid; grid-template-columns: minmax(0, 1fr) 15rem; gap: .75rem; padding: 1rem 1rem .75rem; }
.pages-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; padding: 0 1rem .75rem; }
.pages-inventory-toolbar, .pages-selection, .pages-pagination { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .5rem 1rem; padding: .5rem 1rem; }
.pages-inventory-toolbar { border-top: 1px solid var(--wiki-surface-border); background: var(--wiki-surface-sunken); }
.pages-inventory-toolbar > span, .pages-pagination > span, .pages-selection small { color: var(--wiki-text-muted); font-size: .8125rem; }
.pages-inventory-toolbar > div, .pages-selection > div:last-child, .pages-pagination > div { display: flex; flex-wrap: wrap; gap: .25rem; }
.pages-selection { border-block: 1px solid var(--wiki-surface-border-strong); background: var(--wiki-surface-sunken); }
.pages-selection small { display: block; margin-top: .125rem; }
.pages-record { display: grid; grid-template-columns: 2rem minmax(0, 1fr) minmax(12rem, 22%) 8rem; gap: 1rem; padding: .875rem 1rem; border-top: 1px solid var(--wiki-surface-border); }
.pages-record-select { display: flex; align-items: start; justify-content: center; cursor: pointer; padding-top: .25rem; }
.pages-record-select input { width: 18px; height: 18px; accent-color: rgb(var(--v-theme-primary)); }
.pages-record-main, .pages-record-state, .pages-record-date { min-width: 0; overflow-wrap: anywhere; }
.admin-record-link { color: rgb(var(--v-theme-on-surface)); font-size: .9375rem; font-weight: 650; text-decoration: none; overflow-wrap: anywhere; }
.admin-record-link:hover { text-decoration: underline; }
.pages-record-path { display: block; margin-top: .25rem; color: var(--wiki-text-muted); font-family: var(--wiki-font-mono); font-size: .75rem; overflow-wrap: anywhere; }
.pages-record p { color: var(--wiki-text-muted); font-size: .8125rem; line-height: 1.5; margin: .375rem 0 0; }
.pages-record-tags { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem .5rem; margin-top: .25rem; }
.pages-record-tags button { min-height: 1.75rem; color: var(--wiki-accent-ink); font-size: .75rem; text-decoration: underline; overflow-wrap: anywhere; text-align: start; }
.pages-record-state { margin: 0; }
.pages-record-state > div + div { margin-top: .375rem; }
.pages-record-state dt, .pages-record-date small { color: var(--wiki-text-muted); font-size: .75rem; }
.pages-record-state dd { margin: .125rem 0 0; font-size: .8125rem; line-height: 1.45; }
.pages-record-date > * { display: block; }
.pages-record-date time { font-size: .8125rem; margin: .125rem 0 .375rem; }
.pages-footnote { padding: .75rem 1rem; margin: 0; border-top: 1px solid var(--wiki-surface-border); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: 3px; }
@media (max-width: 1000px) {
  .pages-record { grid-template-columns: 2rem minmax(0, 1fr) 12rem; }
  .pages-record-date { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .pages-record-date time { margin: 0; }
}
@media (max-width: 600px) {
  .pages-search, .pages-filters { grid-template-columns: minmax(0, 1fr); }
  .pages-record { gap: .5rem; grid-template-columns: 2.75rem minmax(0, 1fr); padding: .75rem; }
  .pages-record-select { min-width: 44px; min-height: 44px; align-items: center; padding: 0; }
  .pages-record-state { grid-column: 2; display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
  .pages-record-state > div + div { margin: 0; }
  .pages-record-tags button { min-height: 44px; }
  .pages-inventory-toolbar, .pages-selection, .pages-pagination { align-items: start; }
}
</style>
