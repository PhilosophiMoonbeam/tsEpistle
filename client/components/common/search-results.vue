<template lang="pug">
  .search-results(
    v-if='isAgentOpen || searchIsFocused || normalizedSearch.length > 1'
    :class='{ "search-results--ask": isAgentOpen }'
    role='dialog'
    :aria-modal='isAgentOpen ? `true` : undefined'
    :aria-labelledby='isAgentOpen ? `wiki-agent-title` : `wiki-search-title`'
    :aria-busy='!isAgentOpen && searchIsLoading'
    @click='handleBackdropClick'
  )
    .search-results-container(:class='{ "search-results-container--ask": isAgentOpen }')
      h1#wiki-agent-title.sr-only(v-if='isAgentOpen') Wiki Agent workspace
      v-btn.search-results-close(
          v-if='isAgentOpen'
          icon='mdi-close'
          variant='text'
          :aria-label='$t(`common:header.searchClose`)'
          @click.stop='closeSearch'
        )
      InlineAgentChat(
        v-if='isAgentOpen'
        ref='inlineAgent'
        :owner-id='agentOwnerId'
        :resume-session-id='agentResumeSessionId || undefined'
        :csrf-token='agentCsrfToken'
        :approval-id='approvalId'
        :provider-enabled='agentProviderEnabled'
        :skills-enabled='agentSkillsEnabled'
        :goals-enabled='agentGoalsEnabled'
        :page-id='agentPageId'
        :page-locale='agentPageLocale'
        :page-path='agentPagePath'
        :page-updated-at='agentPageUpdatedAt'
        @return-search='returnToSearch'
        @close='closeSearch'
      )
      WikiSourcePreview(
        v-if='previewSelector'
        :selector='previewSelector'
        :query='normalizedSearch'
        :can-ask='canAsk'
        @close='previewSelector = null'
        @ask='askSource'
      )
      .search-results-search(v-if='!isAgentOpen' @click.stop)
        .search-results-instructions.sr-only#wiki-search-instructions Use Arrow Up and Down to move through results, Enter to open a result, and Escape to close search.
        .search-results-scope
          h1#wiki-search-title.search-results-heading
            v-icon(icon='mdi-magnify' size='19' aria-hidden='true')
            span Search the Wiki
          .search-results-scope-actions(role='group' aria-label='Search scope')
            v-btn(
              size='small'
              prepend-icon='mdi-earth'
              :variant='!offlineSearchActive ? `tonal` : `text`'
              :color='!offlineSearchActive ? `primary` : undefined'
              :aria-pressed='!offlineSearchActive'
              @click='selectSearchScope(`wiki`)'
            ) All Wiki
            v-btn(
              size='small'
              prepend-icon='mdi-download-box-outline'
              :variant='offlineSearchActive ? `tonal` : `text`'
              :color='offlineSearchActive ? `primary` : undefined'
              :aria-pressed='offlineSearchActive'
              @click='selectSearchScope(`downloaded`)'
            ) Downloaded pages
            v-btn(
              v-if='currentPageLocale'
              size='small'
              prepend-icon='mdi-translate'
              :variant='searchRestrictLocale ? `tonal` : `text`'
              :color='searchRestrictLocale ? `primary` : undefined'
              :aria-pressed='searchRestrictLocale'
              :disabled='offlineSearchActive'
              :title='offlineSearchActive ? `Wiki scope filters require a live server.` : undefined'
              @click='searchRestrictLocale = !searchRestrictLocale'
            ) {{ currentPageLocale.toLocaleUpperCase() }}
            v-btn(
              v-if='currentPagePath'
              size='small'
              prepend-icon='mdi-file-tree-outline'
              :variant='searchRestrictPath ? `tonal` : `text`'
              :color='searchRestrictPath ? `primary` : undefined'
              :aria-pressed='searchRestrictPath'
              :disabled='offlineSearchActive'
              :title='offlineSearchActive ? `Wiki scope filters require a live server.` : undefined'
              @click='searchRestrictPath = !searchRestrictPath'
            ) This page tree
        .search-results-content
          .search-results-capability-note(v-if='offlineSearchActive || serverUnavailable' role='status' aria-live='polite')
            .search-results-capability-note-title {{ serverUnavailable ? `Server unavailable · Downloaded pages only` : `Downloaded pages` }}
            p {{ serverUnavailable ? `Wiki search, Ask/Agent, and server preview need a live server. This bounded local search uses only public pages saved on this device.` : `This search is bounded to public pages saved on this device; it does not include server suggestions, graph matches, or private metadata.` }}
            v-btn(
              v-if='serverUnavailable'
              size='small'
              variant='tonal'
              prepend-icon='mdi-refresh'
              :loading='serverRetryPending'
              @click='retrySearch'
            ) Retry connection
          .search-results-help(v-if='normalizedSearch.length < 2')
            .search-results-help-mark
              v-icon(icon='mdi-text-search' size='34')
            h2 Search your knowledge base
            p(v-if='offlineSearchActive') Type plain text to search downloaded page titles, descriptions, and content. Advanced syntax and path or tag filters require a live server.
            p(v-else) Type at least two characters to find pages by title, content, path, or tag.
            .search-results-syntax-tips(v-if='!offlineSearchActive')
              span.search-results-syntax-tip
                kbd "exact phrase"
                | exact match
              span.search-results-syntax-tip
                kbd -word
                | exclude
              span.search-results-syntax-tip
                kbd or
                | either
          .search-results-loader(v-else-if='searchIsLoading')
            async-state(
              state='loading'
              :title='$t(`common:header.searchLoading`)'
              :message='searchLoadingMessage'
            )
          .search-results-none(v-else-if='searchError')
            async-state(
              state='error'
              :title='offlineSearchActive ? `Downloaded search is temporarily unavailable` : `Search is temporarily unavailable`'
              :message='searchError'
              :retry-label='serverUnavailable ? `Retry connection` : `Try again`'
              @retry='retrySearch'
            )
          template(v-else)
            .search-results-summary(v-if='hasFreshResponse')
              div(role='status' aria-live='polite' aria-atomic='true')
                .search-results-eyebrow {{ offlineSearchActive ? `Downloaded pages` : `Search results` }}
                .search-results-count(v-if='offlineSearchActive') {{ offlineCorpusSummary }}
                template(v-else-if='results.length')
                  .search-results-count
                    span {{ response.windowTruncated ? `At least ${response.totalHits} matches` : `${response.totalHits} ${response.totalHits === 1 ? 'match' : 'matches'}` }}
                    span.search-results-window(v-if='response.results.length < response.totalHits')  · Showing the top {{ response.results.length }}
              v-btn.search-results-ask(
                v-if='canAsk || serverUnavailable'
                color='primary'
                variant='tonal'
                prepend-icon='mdi-book-open-page-variant-outline'
                :disabled='!canAsk'
                :title='!canAsk ? askUnavailableReason : undefined'
                @click='askCurrentQuery'
                data-modal-focus-key='search-ask-query'
              ) Ask about this
            .search-results-none(v-if='hasFreshResponse && results.length < 1')
              async-state(
                state='empty'
                :title='$t(`common:header.searchNoResult`)'
                :message='emptyResultsMessage'
              )
              .search-results-empty-actions(v-if='canAsk || serverUnavailable')
                v-btn.search-results-empty-ask(
                  color='primary'
                  variant='tonal'
                  prepend-icon='mdi-book-open-page-variant-outline'
                  :disabled='!canAsk'
                  :title='!canAsk ? askUnavailableReason : undefined'
                  @click='askCurrentQuery'
                  data-modal-focus-key='search-ask-empty'
                ) Ask Wiki about "{{ normalizedSearch }}"
            template(v-if='results.length > 0')
              v-list.search-results-items(
                id='wiki-search-results'
                role='grid'
                :aria-busy='searchIsLoading'
                aria-label='Search results'
              )
                template(v-for='(item, idx) of results' :key='resultKey(item)')
                  .search-results-row(role='row')
                    .search-results-main-cell(role='gridcell' :id='resultOptionId(idx)' :aria-selected='idx === cursor')
                      v-list-item.search-results-item(
                        lines='three'
                        :href='pageHref(item)'
                        :data-no-wiki-navigation='isDownloadedResult(item) ? `true` : undefined'
                        :class='idx === cursor ? `highlighted` : ``'
                        @click='handleResultClick($event, item)'
                      )
                        template(v-slot:prepend)
                          .search-results-item-mark
                            v-icon(icon='mdi-file-document-outline' size='21')
                        v-list-item-title {{ item.title }}
                        v-list-item-subtitle {{ item.description }}
                        .search-results-match(v-if='matchSummary(item)') {{ matchSummary(item) }}
                        .search-results-path
                          v-icon(icon='mdi-source-branch' size='14')
                          span {{ item.path }}
                        .search-results-tags(v-if='item.tags.length || item.matchedFields?.includes("graph")')
                          v-chip(
                            v-for='(tag, tagIndex) of item.tags.slice(0, 3)'
                            :key='occurrenceKey(item.tags, tag, tagIndex)'
                            size='x-small'
                            variant='tonal'
                          ) {{ tag }}
                          span.text-body-small.text-medium-emphasis(v-if='item.tags.length > 3') +{{ item.tags.length - 3 }}
                          v-chip(
                            v-if='item.matchedFields?.includes("graph")'
                            size='x-small'
                            variant='tonal'
                            color='secondary'
                          )
                            v-icon(start icon='mdi-graph-outline' size='12')
                            | Linked page
                        template(v-slot:append)
                          .search-results-item-meta
                            v-chip(v-if='item.visibility === "private"' size='x-small' label color='warning' variant='tonal')
                              v-icon(start icon='mdi-lock-outline' size='12')
                              | Private
                            v-chip(size='x-small' label variant='outlined') {{ item.locale.toLocaleUpperCase() }}
                            v-icon.search-results-item-chevron(icon='mdi-chevron-right' size='19')
                    .search-results-preview-cell(role='gridcell')
                      button.search-results-preview(
                        type='button'
                        :aria-label='`Preview ${item.title}`'
                        :disabled='!serverCapabilitiesAvailable || !hasFreshResponse'
                        :title='!serverCapabilitiesAvailable || !hasFreshResponse ? previewUnavailableReason : undefined'
                        @click='openPreview(item)'
                      )
                        v-icon(icon='mdi-text-box-search-outline' size='18')
                        span Preview
                  v-divider(v-if='idx < results.length - 1' aria-hidden='true')
              v-pagination.search-results-pagination(
                v-if='paginationLength > 1'
                v-model='pagination'
                :length='paginationLength'
                density='comfortable'
                :total-visible='$vuetify.display.xs ? 3 : 7'
                rounded
              )
            .search-results-continuation(v-if='offlineSearchActive ? offlineResultsTruncated : (response.nextCursor || moreError || response.windowTruncated)')
              v-btn(v-if='!offlineSearchActive && response.nextCursor' variant='tonal' :loading='loadingMore' prepend-icon='mdi-chevron-down' @click='loadMoreResults') More results
              p(v-if='offlineSearchActive && offlineResultsTruncated' role='status') Showing a bounded set of local matches. Narrow the query to search more precisely.
              p(v-if='!offlineSearchActive && moreError' role='alert') {{ moreError }}
              p(v-if='!offlineSearchActive && response.windowTruncated') Showing a bounded set of matches. Narrow the query or scope to find a more specific page.
            .search-results-suggestion-block(v-if='suggestions.length')
              .search-results-eyebrow Suggested searches
              v-list.search-results-suggestions(
                id='wiki-search-suggestions'
                role='listbox'
                :aria-busy='searchIsLoading'
                aria-label='Search suggestions'
                density='compact'
              )
                template(v-for='(term, idx) of suggestions' :key='occurrenceKey(suggestions, term, idx)')
                  v-list-item(
                    :id='`wiki-search-suggestion-${idx}`'
                    role='option'
                    :aria-selected='idx + results.length === cursor'
                    :class='idx + results.length === cursor ? `highlighted` : ``'
                    prepend-icon='mdi-magnify'
                    @click='setSearchTerm(term)'
                  )
                    v-list-item-title {{ term }}
                  v-divider(v-if='idx < suggestions.length - 1' aria-hidden='true')
        .search-results-keyboard-hint(
          v-if='!isAgentOpen && normalizedSearch.length >= 2'
          aria-hidden='true'
          title='Keyboard shortcuts: navigate, open, close'
        )
          kbd ↑↓
          kbd ↵
          kbd Esc

</template>
<script lang='ts'>
import { defineComponent } from 'vue'
import AsyncState from '@/components/common/async-state.vue'
import InlineAgentChat from '../agents/inline-agent-chat.vue'
import WikiSourcePreview from './wiki-source-preview.vue'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import type { AgentSearchScope } from '../../helpers/agent-draft.ts'
import type { WikiSource, WikiSourceSelector } from '../../../shared/wiki-source.ts'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import { emitSearchFocus, onSearchEnter, onSearchExit, onSearchMove, offSearchEnter, offSearchExit, offSearchMove } from '../../helpers/search-navigation-events'
import { useAgentsStore } from '../../store/agents.ts'
import { isAgentSessionId } from '../../helpers/agent-chat-pin.ts'
import { searchPages, type PageSearchResult, type PageSearchRow } from '../../helpers/pages-api'
import { openOfflineStorage } from '../../helpers/offline-storage.ts'
import {
  OFFLINE_SEARCH_RESULT_LIMIT,
  prepareOfflineSearchCorpus,
  searchPreparedOfflineDocumentsAsync,
  type OfflineSearchCorpus
} from '../../helpers/offline-search.ts'
import type { OfflineSearchDocumentV1, OfflineSnapshotRecord } from '../../../shared/offline.ts'
import { pwaState, retryServerConnection } from '../../helpers/pwa.ts'
import { activeOwnedOverlayRoots, createModalFocusScope, type ModalFocusScope } from './modal-focus-scope'
import { navigateToWikiPage } from '../../helpers/wiki-navigation'

type SearchScope = 'wiki' | 'downloaded'
type OnlineSearchRow = PageSearchRow & {
  readonly offline?: false
}
type DownloadedSearchRow = PageSearchRow & {
  readonly offline: true
  readonly offlineSiteId: string
  readonly offlinePageId: number
  readonly offlineLocale: string
}
type SearchResultRow = OnlineSearchRow | DownloadedSearchRow
type SearchResponse = Omit<PageSearchResult, 'results'> & {
  results: SearchResultRow[]
}

const OFFLINE_DOCUMENT_PATH = '/_offline'
const OFFLINE_LOCALE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u

const offlineRecordKey = (siteId: string, pageId: number, locale: string): string =>
  `${siteId}\u0000${pageId}\u0000${locale}`

const isOfflineLocale = (value: string): boolean => OFFLINE_LOCALE_PATTERN.test(value)

const isOfflineSnapshotRecord = (record: OfflineSnapshotRecord, origin: string): boolean =>
  record.siteId === origin &&
  record.pageId === record.snapshot.pageId &&
  record.locale === record.snapshot.locale &&
  Number.isSafeInteger(record.pageId) &&
  record.pageId > 0 &&
  isOfflineLocale(record.locale)

const toOfflineSearchDocument = (record: OfflineSnapshotRecord): OfflineSearchDocumentV1 => ({
  schemaVersion: record.snapshot.schemaVersion,
  siteId: record.siteId,
  pageId: record.snapshot.pageId,
  locale: record.snapshot.locale,
  path: record.snapshot.path,
  canonicalPath: record.snapshot.canonicalPath,
  title: record.snapshot.title,
  description: record.snapshot.description,
  searchText: record.snapshot.searchText,
  capturedAt: record.snapshot.capturedAt,
  byteSize: record.byteSize
})
const isOfflineSnapshotExpired = (record: OfflineSnapshotRecord, at = Date.now()): boolean => {
  if (!record.snapshot.expiresAt) return false
  const expiry = Date.parse(record.snapshot.expiresAt)
  return Number.isFinite(expiry) && expiry <= at
}

const isDownloadedSearchRow = (item: SearchResultRow): item is DownloadedSearchRow =>
  item.offline === true &&
  typeof item.offlineSiteId === 'string' &&
  Number.isSafeInteger(item.offlinePageId) &&
  item.offlinePageId > 0 &&
  typeof item.offlineLocale === 'string'

const offlineSelectorHref = (siteId: string, pageId: number, locale: string): string | null => {
  if (typeof window === 'undefined') return null
  const origin = window.location.origin
  if (siteId !== origin || !Number.isSafeInteger(pageId) || pageId < 1 || !isOfflineLocale(locale)) return null
  const url = new URL(OFFLINE_DOCUMENT_PATH, origin)
  url.searchParams.set('site', origin)
  url.searchParams.set('pageId', String(pageId))
  url.searchParams.set('locale', locale)
  return `${url.pathname}?${url.searchParams.toString()}`
}

type InlineAgentChatRef = {
  focusComposer: () => Promise<void>
  sendPrompt: (prompt: string) => Promise<boolean>
  preparePrompt: (prompt: string, source?: WikiSource, scope?: AgentSearchScope) => Promise<void>
  focusConversation: () => Promise<void>
}

const emptySearchResponse = (): SearchResponse => ({
  results: [],
  suggestions: [],
  totalHits: 0
})


export default defineComponent({
  components: {
    AsyncState,
    InlineAgentChat,
    WikiSourcePreview
  },
  data() {
    return {
      loadingMore: false,
      moreError: '',
      previewSelector: null as WikiSourceSelector | null,
      searchScope: 'wiki' as SearchScope,
      offlineCorpusCount: null as number | null,
      offlineResultsTruncated: false,
      offlineSearchCorpus: null as OfflineSearchCorpus | null,
      offlineSearchCorpusRevision: null as number | null,
      offlineSearchCorpusSessionGeneration: null as number | null,
      offlineSearchCorpusExpiresAt: null as number | null,
      serverRetryPending: false,
      searchRetryId: 0,
      cursor: -1,
      approvalId: '',
      pagination: 1,
      perPage: 10,
      searchTimer: null as number | null,
      searchError: '',
      searchRequestId: 0,
      response: emptySearchResponse(),
      responseKey: '',
      modalFocusScope: null as ModalFocusScope | null,
      searchModalFocusScope: null as ModalFocusScope | null,
      pendingAskRestoreTarget: null as HTMLElement | null,
      searchRestoreTarget: null as HTMLElement | null,
      searchExitRestoreFocus: true,
      directPromptHandoffId: 0,
      directPromptHandoffPending: false,
      agentResumeSessionId: null as string | null,
      agentOpeningPage: null as AgentCurrentPageHint | null,
      agentOpeningPageCaptured: false,
      searchAbortController: null as AbortController | null
    }
  },
  computed: {
    search: {
      get(): string { return wikiStore.site.search },
      set(value: string) { wikiStore.site.search = value }
    },
    searchMode: {
      get(): 'search' | 'ask' { return wikiStore.site.searchMode },
      set(value: 'search' | 'ask') { wikiStore.site.searchMode = value }
    },
    searchIsFocused: {
      get(): boolean { return wikiStore.site.searchIsFocused },
      set(value: boolean) { wikiStore.site.searchIsFocused = value }
    },
    searchIsLoading: {
      get(): boolean { return wikiStore.site.searchIsLoading },
      set(value: boolean) { wikiStore.site.searchIsLoading = value }
    },
    searchRestrictLocale: {
      get(): boolean { return wikiStore.site.searchRestrictLocale },
      set(value: boolean) { wikiStore.site.searchRestrictLocale = value }
    },
    serverUnavailable(): boolean {
      return pwaState.connectionState !== 'online' || pwaState.serverReachable !== true || pwaState.serverHealthy !== true
    },
    serverCapabilitiesAvailable(): boolean {
      return pwaState.connectionState === 'online' &&
        pwaState.serverReachable === true &&
        pwaState.serverHealthy === true
    },
    authAuthorityReady(): boolean {
      return wikiStore.user.authenticated &&
        wikiStore.authRefreshPending === false &&
        wikiStore.authRefreshSettled === true &&
        wikiStore.authRefreshOutcome === 'authenticated' &&
        wikiStore.offlineIdentityReady === true
    },
    offlineSearchActive(): boolean {
      return this.searchScope === 'downloaded' || this.serverUnavailable
    },
    offlineCorpusSummary(): string {
      const count = this.offlineCorpusCount
      if (count === null) return 'Bounded downloaded-page corpus'
      return `Bounded corpus: ${count} downloaded ${count === 1 ? 'page' : 'pages'}`
    },
    searchLoadingMessage(): string {
      if (!this.offlineSearchActive) return 'Searching the pages you can access.'
      if (this.offlineCorpusCount === null) return 'Searching the bounded downloaded-page corpus on this device.'
      return `Searching ${this.offlineCorpusCount} downloaded ${this.offlineCorpusCount === 1 ? 'page' : 'pages'} on this device.`
    },
    emptyResultsMessage(): string {
      if (this.offlineSearchActive) return 'No downloaded pages match this query in the bounded local corpus.'
      return this.canAsk ? 'Ask Wiki for a grounded answer, or try a different term or scope.' : 'Try a different term or broader scope.'
    },
    askUnavailableReason(): string {
      if (this.serverUnavailable) return 'Ask and Agent require a live server. Retry connection to enable them.'
      if (!this.authAuthorityReady) return 'Ask and Agent require a freshly verified signed-in session. Refresh your session, then try again.'
      return 'Ask and Agent are available after the server connection is verified.'
    },
    previewUnavailableReason(): string {
      if (!this.serverCapabilitiesAvailable) return 'Server preview requires a verified live server. Retry connection to enable it.'
      return 'Server preview is available only for the current verified search results.'
    },
    searchRestrictPath: {
      get(): boolean { return wikiStore.site.searchRestrictPath },
      set(value: boolean) { wikiStore.site.searchRestrictPath = value }
    },
    results(): SearchResultRow[] {
      const currentIndex = (this.pagination - 1) * this.perPage
      return this.response.results.slice(currentIndex, currentIndex + this.perPage)
    },
    normalizedSearch(): string {
      return this.search.trim()
    },
    suggestions(): string[] {
      return this.response.suggestions
    },
    canAsk(): boolean {
      return this.serverCapabilitiesAvailable &&
        this.authAuthorityReady &&
        siteConfig.agentsEnabled &&
        Array.isArray(wikiStore.user.permissions) &&
        wikiStore.user.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')
    },
    isAgentOpen(): boolean {
      return this.canAsk && this.searchMode === 'ask'
    },
    agentOwnerId(): number { return wikiStore.user.id },
    agentCsrfToken(): string { return siteConfig.agentCsrfToken },
    agentProviderEnabled(): boolean { return siteConfig.agentProviderEnabled },
    agentSkillsEnabled(): boolean { return siteConfig.agentSkillsEnabled },
    agentGoalsEnabled(): boolean { return siteConfig.agentGoalsEnabled },
    agentPageId(): number { return this.agentOpeningPage?.id ?? 0 },
    agentPageLocale(): string { return this.agentOpeningPage?.locale ?? '' },
    agentPagePath(): string { return this.agentOpeningPage?.path ?? '' },
    agentPageUpdatedAt(): string { return this.agentOpeningPage?.observedUpdatedAt ?? '' },
    currentPageId(): number { return wikiStore.page.id },
    currentPageLocale(): string { return wikiStore.page.locale },
    currentPagePath(): string { return wikiStore.page.path },
    currentPageUpdatedAt(): string { return wikiStore.page.updatedAt },
    searchRequestKey(): string {
      return JSON.stringify([
        this.normalizedSearch,
        this.searchRestrictLocale ? wikiStore.page.locale : '',
        this.searchRestrictPath ? wikiStore.page.path : '',
        this.offlineSearchActive ? 'downloaded' : 'wiki'
      ])
    },
    hasFreshResponse(): boolean {
      return this.responseKey === this.searchRequestKey && this.normalizedSearch.length >= 2
    },
    activeDescendant(): string | undefined {
      if (!this.hasFreshResponse || this.cursor < 0 || this.cursor >= this.results.length + this.suggestions.length) return undefined
      if (this.cursor < this.results.length) return this.resultOptionId(this.cursor)
      return `wiki-search-suggestion-${this.cursor - this.results.length}`
    },
    searchListIds(): string {
      return [
        this.results.length > 0 ? 'wiki-search-results' : '',
        this.suggestions.length > 0 ? 'wiki-search-suggestions' : ''
      ].filter(Boolean).join(' ')
    },
    paginationLength(): number {
      return this.response.results.length > 0 ? Math.ceil(this.response.results.length / this.perPage) : 0
    }
  },
  watch: {
    search(newValue: string | null) {
      const query = newValue ?? ''
      if (this.searchMode === 'search' && query.trim().length >= 2) this.searchIsFocused = true
    },
    searchRequestKey() {
      this.queueSearch(this.search)
    },
    offlineSearchActive(active: boolean) {
      if (active && this.previewSelector) this.previewSelector = null
      if (active && this.searchMode === 'ask') this.searchMode = 'search'
    },
    serverCapabilitiesAvailable(available: boolean) {
      if (!available) this.previewSelector = null
    },
    searchMode(mode: 'search' | 'ask') {
      if (mode === 'search') {
        if (!this.hasFreshResponse) this.queueSearch(this.search)
        return
      }
      this.searchAbortController?.abort()
      this.searchAbortController = null
      this.searchRequestId += 1
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchIsLoading = false
    },
    isAgentOpen(open: boolean) {
      if (open) {
        this.latchAgentOpeningPage()
        void this.activateAgentModal()
        return
      }
      if (this.directPromptHandoffPending) this.directPromptHandoffId += 1
      if (this.searchIsFocused) void this.reactivateSearchModal()
      else this.deactivateAgentModal(false)
    },
    searchIsFocused(open: boolean) {
      if (open) {
        void this.activateAgentModal()
        return
      }
      const restoreFocus = this.searchExitRestoreFocus
      this.searchExitRestoreFocus = true
      this.finishSearchFocus(restoreFocus)
    },
    agentOwnerId(newOwnerId: number, oldOwnerId: number | undefined) {
      if (oldOwnerId === undefined || newOwnerId === oldOwnerId) return
      this.agentResumeSessionId = null
      if (this.isAgentOpen) {
        this.searchMode = 'search'
        this.searchIsFocused = false
      }
    },
    currentPageId(newPageId: number, oldPageId: number | undefined) {
      if (oldPageId !== undefined && newPageId !== oldPageId) this.agentResumeSessionId = null
    },
    results() {
      this.cursor = -1
      void this.$nextTick(this.syncSearchInputA11y)
    },
    cursor() {
      void this.$nextTick(this.syncSearchInputA11y)
    },
    searchIsLoading() {
      void this.$nextTick(this.syncSearchInputA11y)
    }
  },
  mounted() {
    if (!this.canAsk && this.searchMode === 'ask') this.searchMode = 'search'
    const approvalId = new URL(window.location.href).searchParams.get('agentApproval')
    if (approvalId && /^[0-9a-f-]{36}$/i.test(approvalId) && this.canAsk) {
      this.approvalId = approvalId
      this.searchMode = 'ask'
      this.searchIsFocused = true
    }
    if (this.isAgentOpen) this.latchAgentOpeningPage()
    if (this.searchMode === 'search' && this.normalizedSearch.length >= 2) {
      this.searchIsFocused = true
      this.queueSearch(this.search)
    }
    onSearchMove(this.handleSearchMove)
    onSearchEnter(this.handleSearchEnter)
    onSearchExit(this.handleSearchExit)
    void this.$nextTick(this.syncSearchInputA11y)
    document.addEventListener('focusin', this.captureSearchRestoreTarget, true)
    if (this.searchIsFocused) void this.activateAgentModal()
  },
  beforeUnmount() {
    this.searchRequestId += 1
    this.searchRetryId += 1
    this.directPromptHandoffId += 1
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    this.searchAbortController?.abort()
    this.searchAbortController = null
    this.searchTimer = null
    this.serverRetryPending = false
    this.searchIsLoading = false
    offSearchMove(this.handleSearchMove)
    offSearchEnter(this.handleSearchEnter)
    offSearchExit(this.handleSearchExit)
    document.removeEventListener('focusin', this.captureSearchRestoreTarget, true)
    this.deactivateModalLayers(false)
    this.agentResumeSessionId = null
  },
  methods: {
    matchSummary(item: PageSearchRow): string {
      const labels = { title: 'title', tag: 'tags', path: 'page path', description: 'description', content: 'page text', graph: 'related links', knowledge: 'knowledge hints' }
      const fields = [...new Set(item.matchedFields ?? [])].map(field => labels[field]).filter(Boolean)
      return fields.length ? `Matches ${fields.slice(0, 3).join(' · ')}` : ''
    },
    currentPageHint(): AgentCurrentPageHint | null {
      const id = this.currentPageId
      if (id < 1 || !this.currentPageLocale || !this.currentPagePath || !this.currentPageUpdatedAt) return null
      return { id, locale: this.currentPageLocale, path: this.currentPagePath, observedUpdatedAt: this.currentPageUpdatedAt }
    },
    latchAgentOpeningPage(): void {
      if (this.agentOpeningPageCaptured) return
      this.agentOpeningPageCaptured = true
      this.agentOpeningPage = this.currentPageHint()
    },
    async activateAgentModal(): Promise<void> {
      const activeOpener = this.activeModalOpener()
      const searchOpener = this.searchRestoreTarget ??
        (this.isSearchControl(activeOpener) ? null : activeOpener) ??
        this.findSearchTrigger()
      const agentOpener = this.pendingAskRestoreTarget ?? activeOpener ?? this.findSearchControl()
      await this.$nextTick()
      if (!this.searchIsFocused && !this.isAgentOpen) return
      this.activateSearchModal(searchOpener)
      if (!this.isAgentOpen || this.modalFocusScope) return
      const root = this.$el
      if (!(root instanceof HTMLElement)) return
      const focusScope = createModalFocusScope({
        root,
        restoreTarget: this.restoreTargetFor(agentOpener),
        additionalRoots: () => activeOwnedOverlayRoots('.agent-owned-overlay'),
        onEscape: this.returnToSearch
      })
      this.pendingAskRestoreTarget = null
      this.modalFocusScope = focusScope
      const inlineAgent = this.$refs.inlineAgent as InlineAgentChatRef | undefined
      await inlineAgent?.focusComposer()
      this.retireResumeAfterSelection()
      if (this.modalFocusScope === focusScope && !focusScope.containsFocus()) focusScope.focusFirst()
    },
    activateSearchModal(restoreTarget: HTMLElement | null): void {
      if (this.searchModalFocusScope) return
      const root = this.$el
      if (!(root instanceof HTMLElement)) return
      this.searchModalFocusScope = createModalFocusScope({
        root,
        restoreTarget: this.restoreTargetFor(restoreTarget),
        additionalRoots: this.searchModalAdditionalRoots,
        onEscape: this.closeSearch
      })
    },
    async reactivateSearchModal(): Promise<void> {
      await this.$nextTick()
      if (this.isAgentOpen || !this.searchIsFocused) return
      this.deactivateAgentModal(false)
      this.activateSearchModal(this.searchRestoreTarget ?? this.findSearchTrigger())
      if (this.searchModalFocusScope && !this.searchModalFocusScope.containsFocus()) this.searchModalFocusScope.focusFirst()
    },
    deactivateAgentModal(restoreFocus = true): void {
      this.modalFocusScope?.deactivate({ restoreFocus })
      this.modalFocusScope = null
      this.syncSearchInputA11y()
    },
    deactivateModalLayers(restoreFocus = true): void {
      this.deactivateAgentModal(false)
      this.searchModalFocusScope?.deactivate({ restoreFocus })
      this.searchModalFocusScope = null
      this.syncSearchInputA11y()
    },
    finishSearchFocus(restoreFocus = true): void {
      this.deactivateModalLayers(restoreFocus)
      const active = document.activeElement
      if (this.isSearchControl(active)) active.blur()
      this.searchRestoreTarget = null
    },
    handleSearchExit(restoreFocus: boolean): void {
      this.searchExitRestoreFocus = restoreFocus
    },
    handleBackdropClick(event: MouseEvent): void {
      if (this.isAgentOpen) return
      const target = event.target
      // Returning from Agent changes the mode before this same click bubbles here.
      if (target instanceof Element && target.closest('.search-results-search, .wiki-source-preview, .inline-agent')) return
      this.closeSearch()
    },
    captureSearchRestoreTarget(event: FocusEvent): void {
      if (this.searchModalFocusScope || !this.isSearchControl(event.target)) return
      const previous = event.relatedTarget
      this.searchRestoreTarget = previous instanceof HTMLElement &&
        previous !== document.body &&
        previous.tabIndex >= 0 &&
        !previous.matches(':disabled') &&
        !this.isSearchControl(previous)
        ? previous
        : null
    },
    isSearchControl(target: EventTarget | null): target is HTMLElement {
      return target instanceof HTMLElement && Boolean(target.closest('.nav-header-search-control'))
    },
    activeModalOpener(): HTMLElement | null {
      const active = document.activeElement
      return active instanceof HTMLElement &&
        active !== document.body &&
        active.tabIndex >= 0
        ? active
        : null
    },
    restoreTargetFor(target: HTMLElement | null): () => HTMLElement | null {
      const key = target?.dataset.modalFocusKey
      return () => {
        if (target?.isConnected && target.tabIndex >= 0 && !target.matches(':disabled')) return target
        if (key) {
          const replacement = document.querySelector<HTMLElement>(`[data-modal-focus-key="${key}"]`)
          if (replacement && replacement.tabIndex >= 0 && !replacement.matches(':disabled')) return replacement
        }
        return this.findSearchTrigger()
      }
    },
    findSearchControls(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>('.nav-header-search-control input'))
        .filter(control => !control.matches(':disabled'))
    },
    findSearchControl(): HTMLElement | null {
      return this.findSearchControls().find(control => control.getClientRects().length > 0) ?? null
    },
    findSearchTrigger(): HTMLElement | null {
      return document.querySelector<HTMLElement>('.nav-header-search-toggle[data-search-modal-action]')
    },
    syncSearchInputA11y(): HTMLElement[] {
      const controls = this.findSearchControls()
      const searchVisible = !this.isAgentOpen && (this.searchIsFocused || this.normalizedSearch.length >= 2)
      const active = searchVisible ? this.activeDescendant : undefined
      for (const input of controls) {
        input.setAttribute('role', 'combobox')
        input.setAttribute('aria-expanded', String(searchVisible && this.normalizedSearch.length >= 2))
        input.setAttribute('aria-autocomplete', 'list')
        input.setAttribute('aria-busy', String(searchVisible && this.searchIsLoading))
        if (searchVisible) input.setAttribute('aria-describedby', 'wiki-search-instructions')
        else input.removeAttribute('aria-describedby')
        if (searchVisible && this.searchListIds) input.setAttribute('aria-controls', this.searchListIds)
        else input.removeAttribute('aria-controls')
        if (active) input.setAttribute('aria-activedescendant', active)
        else input.removeAttribute('aria-activedescendant')
      }
      return controls
    },
    retireResumeAfterSelection(): void {
      const agents = useAgentsStore()
      const selectedSessionId = agents.thread?.session.id
      if (
        this.agentResumeSessionId &&
        selectedSessionId &&
        selectedSessionId !== this.agentResumeSessionId &&
        agents.initializedWorkspaceVersion === agents.workspaceVersion &&
        isAgentSessionId(selectedSessionId)
      )
        this.agentResumeSessionId = null
    },
    searchModalAdditionalRoots(): HTMLElement[] {
      this.syncSearchInputA11y()
      return [
        ...Array.from(document.querySelectorAll<HTMLElement>('.nav-header-search-control, [data-search-modal-action]'))
          .filter(element => !element.matches(':disabled') && !element.closest('.v-input--disabled')),
        ...activeOwnedOverlayRoots('.agent-owned-overlay')
      ]
    },
    setSearchMode(mode: 'search' | 'ask'): void {
      if (mode === 'ask') this.openAsk()
      else this.searchMode = 'search'
    },
    captureAgentExcursion(): void {
      const agents = useAgentsStore()
      const sessionId = agents.workspaceDisposed ? null : agents.thread?.session.id
      if (sessionId && isAgentSessionId(sessionId)) this.agentResumeSessionId = sessionId
    },
    openAsk(): void {
      if (!this.canAsk) return
      this.latchAgentOpeningPage()
      this.directPromptHandoffId += 1
      this.pendingAskRestoreTarget = this.activeModalOpener()
      this.searchIsFocused = true
      this.searchMode = 'ask'
    },
    async returnToSearch(): Promise<void> {
      this.captureAgentExcursion()
      this.pendingAskRestoreTarget = null
      const returnId = ++this.directPromptHandoffId
      this.deactivateAgentModal(false)
      this.searchMode = 'search'
      this.searchIsFocused = true
      await this.$nextTick()
      if (returnId !== this.directPromptHandoffId || this.isAgentOpen || !this.searchIsFocused) return
      this.deactivateAgentModal(false)
      await this.$nextTick()
      if (returnId !== this.directPromptHandoffId || this.isAgentOpen || !this.searchIsFocused) return
      emitSearchFocus()
    },
    selectSearchScope(scope: SearchScope): void {
      this.searchScope = scope
      this.searchRestrictLocale = false
      this.searchRestrictPath = false
      this.previewSelector = null
      if (scope === 'downloaded' && this.searchMode === 'ask') this.searchMode = 'search'
    },
    queueSearch(query: string): void {
      this.cursor = -1
      this.searchRequestId += 1
      const requestId = this.searchRequestId
      this.searchAbortController?.abort()
      this.searchAbortController = null
      const normalizedQuery = query.trim()
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchIsLoading = false
      if (this.searchMode !== 'search') return
      if (normalizedQuery.length < 2) {
        this.searchError = ''
        this.responseKey = ''
        this.response = emptySearchResponse()
        this.pagination = 1
        return
      }
      const requestKey = this.searchRequestKey
      if (this.responseKey === requestKey && !this.searchError) {
        this.cursor = -1
        return
      }
      this.searchError = ''
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null
        this.searchIsLoading = true
        void this.runSearch(normalizedQuery, requestKey, requestId)
      }, 300)
    },
    handleSearchMove(dir: string): void {
      if (this.searchMode === 'ask' || this.searchIsLoading || !this.hasFreshResponse) return
      const lastIndex = this.results.length + this.suggestions.length - 1
      if (lastIndex < 0) {
        this.cursor = -1
        return
      }
      if (this.cursor < 0) this.cursor = dir === 'up' ? lastIndex : 0
      else this.cursor = Math.min(Math.max(this.cursor + (dir === 'up' ? -1 : 1), -1), lastIndex)
      void this.$nextTick(() => {
        const root = this.$el as HTMLElement | undefined
        root?.querySelector<HTMLElement>('.highlighted')?.scrollIntoView({ block: 'nearest' })
      })
    },
    async handleSearchEnter(): Promise<void> {
      if (this.canAsk && this.searchMode === 'ask') {
        await this.submitAskPrompt()
        return
      }
      if (this.searchIsLoading || !this.hasFreshResponse) return
      if (this.cursor >= 0 && this.cursor < this.results.length) {
        const result = this.results[this.cursor]
        if (result) this.navigateToPage(result)
      } else if (this.cursor >= this.results.length && this.cursor < this.results.length + this.suggestions.length) {
        this.setSearchTerm(this.suggestions[this.cursor - this.results.length])
      }
    },
    async submitAskPrompt(): Promise<void> {
      if (!this.canAsk || this.searchMode !== 'ask') return
      await this.sendAskPrompt(this.normalizedSearch)
    },
    async askCurrentQuery(): Promise<void> {
      if (!this.canAsk || this.normalizedSearch.length < 2 || this.directPromptHandoffPending) return
      const prompt = this.normalizedSearch
      this.latchAgentOpeningPage()
      this.pendingAskRestoreTarget = this.activeModalOpener()
      this.searchMode = 'ask'
      await this.$nextTick()
      await (this.$refs.inlineAgent as InlineAgentChatRef | undefined)?.preparePrompt(prompt, undefined, this.agentSearchScope())
    },
    agentSearchScope(): AgentSearchScope {
      if (this.searchRestrictPath && this.currentPageLocale && this.currentPagePath) return { kind: 'section', locale: this.currentPageLocale, path: this.currentPagePath }
      if (this.searchRestrictLocale && this.currentPageLocale) return { kind: 'locale', locale: this.currentPageLocale }
      return { kind: 'all' }
    },
    async askSource(source: WikiSource): Promise<void> {
      this.captureAgentExcursion()
      this.latchAgentOpeningPage()
      this.previewSelector = null
      this.searchMode = 'ask'
      await this.$nextTick()
      await (this.$refs.inlineAgent as InlineAgentChatRef | undefined)?.preparePrompt(this.normalizedSearch || `Help me understand “${source.title}”.`, source, this.agentSearchScope())
    },
    async sendAskPrompt(prompt: string): Promise<void> {
      if (!prompt || this.directPromptHandoffPending) return
      this.directPromptHandoffPending = true
      const handoffId = ++this.directPromptHandoffId
      try {
        await this.$nextTick()
        const inlineAgent = this.$refs.inlineAgent as InlineAgentChatRef | undefined
        if (!inlineAgent) return
        const success = await inlineAgent.sendPrompt(prompt)
        if (!success || handoffId !== this.directPromptHandoffId) return
        if (this.normalizedSearch === prompt) this.search = ''
        await this.$nextTick()
        if (handoffId === this.directPromptHandoffId && this.isAgentOpen) await inlineAgent.focusConversation()
      } finally {
        this.directPromptHandoffPending = false
      }
    },
    closeSearch(): void {
      const shouldCloseAgentWorkspace = this.isAgentOpen || Boolean(this.agentResumeSessionId)
      this.directPromptHandoffId += 1
      this.pendingAskRestoreTarget = null
      this.finishSearchFocus()
      this.searchIsFocused = false
      this.searchMode = 'search'
      this.search = ''
      this.approvalId = ''
      this.agentResumeSessionId = null
      this.agentOpeningPage = null
      this.agentOpeningPageCaptured = false
      if (shouldCloseAgentWorkspace) useAgentsStore().closeWorkspace()
      const url = new URL(window.location.href)
      url.searchParams.delete('agentApproval')
      window.history.replaceState(window.history.state, '', url)
    },
    clearSearchScope(): void {
      this.searchRestrictLocale = false
      this.searchRestrictPath = false
    },
    setSearchTerm(term: string | undefined): void {
      if (term === undefined) return
      this.search = term
      void this.$nextTick(() => this.findSearchControl()?.focus({ preventScroll: true }))
    },
    isDownloadedResult(item: SearchResultRow): boolean {
      return isDownloadedSearchRow(item)
    },
    resultKey(item: SearchResultRow): string {
      if (isDownloadedSearchRow(item)) return `offline:${offlineRecordKey(item.offlineSiteId, item.offlinePageId, item.offlineLocale)}`
      return `${typeof item.id}:${item.id}`
    },
    occurrenceKey(values: readonly string[], value: string, index: number): string {
      let occurrence = 0
      for (let precedingIndex = 0; precedingIndex < index; precedingIndex += 1) {
        if (values[precedingIndex] === value) occurrence += 1
      }
      return JSON.stringify([value, occurrence])
    },
    resultOptionId(index: number): string {
      return `wiki-search-result-${this.pagination}-${index}`
    },
    pageHref(item: SearchResultRow): string {
      if (isDownloadedSearchRow(item)) return offlineSelectorHref(item.offlineSiteId, item.offlinePageId, item.offlineLocale) ?? OFFLINE_DOCUMENT_PATH
      const visibilityScope = item.visibility === 'private' ? '/_private' : ''
      return `${visibilityScope}/${item.locale}/${item.path}`
    },
    openPreview(item: PageSearchRow): void {
      if (!this.serverCapabilitiesAvailable || !this.hasFreshResponse) return
      this.previewSelector = { id: Number(item.id) }
    },
    handleResultClick(event: Event, item: SearchResultRow): void {
      if (!isDownloadedSearchRow(item) && (!this.serverCapabilitiesAvailable || !this.hasFreshResponse)) {
        event.preventDefault()
        return
      }
      this.closeSearch()
    },
    navigateToPage(item: SearchResultRow): void {
      if (!isDownloadedSearchRow(item) && (!this.serverCapabilitiesAvailable || !this.hasFreshResponse)) return
      const href = this.pageHref(item)
      this.closeSearch()
      if (isDownloadedSearchRow(item)) window.location.assign(href)
      else navigateToWikiPage(href)
    },
    async loadMoreResults(): Promise<void> {
      if (
        this.offlineSearchActive ||
        !this.serverCapabilitiesAvailable ||
        !this.hasFreshResponse ||
        !this.response.nextCursor ||
        this.loadingMore
      ) return
      this.loadingMore = true
      this.moreError = ''
      const requestKey = this.searchRequestKey
      const requestId = this.searchRequestId
      const cursor = this.response.nextCursor
      try {
        const next = await searchPages(window.fetch.bind(window), this.normalizedSearch, {
          locale: this.searchRestrictLocale ? wikiStore.page.locale : undefined,
          path: this.searchRestrictPath ? wikiStore.page.path : undefined,
          paginated: true, cursor
        })
        if (
          requestKey !== this.searchRequestKey ||
          requestId !== this.searchRequestId ||
          !this.serverCapabilitiesAvailable ||
          !this.hasFreshResponse
        ) return
        const known = new Set(this.response.results.map(item => this.resultKey(item)))
        const added = next.results.filter(item => !known.has(this.resultKey(item)))
        const firstNewPage = Math.floor(this.response.results.length / this.perPage) + 1
        this.response = { ...next, results: [...this.response.results, ...added] }
        if (added.length) this.pagination = firstNewPage
      } catch (value) {
        if (
          requestKey === this.searchRequestKey &&
          requestId === this.searchRequestId &&
          this.serverCapabilitiesAvailable
        ) this.moreError = getErrorMessage(value)
      } finally {
        this.loadingMore = false
      }
    },
    async retrySearch(): Promise<void> {
      const query = this.normalizedSearch
      const retryId = ++this.searchRetryId
      const requestId = ++this.searchRequestId
      const serverWasUnavailable = this.serverUnavailable
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchAbortController?.abort()
      this.searchAbortController = null
      this.searchError = ''
      this.moreError = ''
      this.responseKey = ''
      this.response = emptySearchResponse()
      this.cursor = -1
      this.pagination = 1
      this.serverRetryPending = serverWasUnavailable
      this.searchIsLoading = query.length >= 2

      if (!serverWasUnavailable) {
        if (query.length >= 2 && this.searchMode === 'search') {
          void this.runSearch(query, this.searchRequestKey, requestId)
        } else {
          this.searchIsLoading = false
        }
        return
      }

      try {
        await retryServerConnection()
      } catch (error) {
        if (retryId === this.searchRetryId && requestId === this.searchRequestId && query.length >= 2) {
          this.searchError = getErrorMessage(error)
          this.response = emptySearchResponse()
          this.responseKey = ''
        }
      } finally {
        if (retryId === this.searchRetryId) this.serverRetryPending = false
      }

      if (
        retryId !== this.searchRetryId ||
        requestId !== this.searchRequestId ||
        this.searchMode !== 'search' ||
        query.length < 2
      ) {
        if (retryId === this.searchRetryId && requestId === this.searchRequestId) this.searchIsLoading = false
        return
      }
      this.queueSearch(query)
    },
    async runSearch(query: string, requestKey: string, requestId: number): Promise<void> {
      if (
        requestId !== this.searchRequestId ||
        requestKey !== this.searchRequestKey ||
        this.searchMode !== 'search'
      ) return
      if (this.offlineSearchActive) {
        await this.runOfflineSearch(query, requestKey, requestId)
        return
      }
      const controller = new AbortController()
      this.searchAbortController?.abort()
      this.searchAbortController = controller
      try {
        const response = await searchPages(
          (url, init) => window.fetch(url, { ...init, signal: controller.signal }),
          query,
          {
            paginated: true,
            locale: this.searchRestrictLocale ? wikiStore.page.locale : undefined,
            path: this.searchRestrictPath ? wikiStore.page.path : undefined
          }
        )
        if (
          requestId !== this.searchRequestId ||
          requestKey !== this.searchRequestKey ||
          controller.signal.aborted ||
          !this.serverCapabilitiesAvailable
        ) return
        this.moreError = ''
        this.response = response
        this.responseKey = requestKey
        this.pagination = 1
      } catch (err) {
        if (
          requestId !== this.searchRequestId ||
          requestKey !== this.searchRequestKey ||
          controller.signal.aborted
        ) return
        this.searchError = getErrorMessage(err)
        this.responseKey = ''
        this.response = emptySearchResponse()
      } finally {
        if (this.searchAbortController === controller) this.searchAbortController = null
        if (requestId === this.searchRequestId) this.searchIsLoading = false
      }
    },
    async runOfflineSearch(query: string, requestKey: string, requestId: number): Promise<void> {
      if (
        requestId !== this.searchRequestId ||
        requestKey !== this.searchRequestKey ||
        this.searchMode !== 'search' ||
        !this.offlineSearchActive
      ) return
      const controller = new AbortController()
      this.searchAbortController?.abort()
      this.searchAbortController = controller
      let storage: Awaited<ReturnType<typeof openOfflineStorage>> | null = null
      try {
        const origin = window.location.origin
        storage = await openOfflineStorage()
        if (requestId !== this.searchRequestId || requestKey !== this.searchRequestKey || controller.signal.aborted) return
        const corpus = await storage.readSnapshotCorpus()
        if (
          requestId !== this.searchRequestId ||
          requestKey !== this.searchRequestKey ||
          controller.signal.aborted
        ) return

        const now = Date.now()
        const activeRecords = corpus.snapshots.filter(record =>
          isOfflineSnapshotRecord(record, origin) && !isOfflineSnapshotExpired(record, now)
        )
        const activeDocuments = activeRecords.map(toOfflineSearchDocument)
        const nextExpiry = activeRecords.reduce<number | null>((soonest, record) => {
          if (!record.snapshot.expiresAt) return soonest
          const expiry = Date.parse(record.snapshot.expiresAt)
          if (!Number.isFinite(expiry) || expiry <= now) return soonest
          return soonest === null || expiry < soonest ? expiry : soonest
        }, null)
        const corpusRevision = corpus.corpusRevision
        const corpusSessionGeneration = corpus.sessionGeneration
        const cacheExpired =
          this.offlineSearchCorpusExpiresAt !== null &&
          this.offlineSearchCorpusExpiresAt <= now
        if (
          this.offlineSearchCorpus === null ||
          this.offlineSearchCorpusRevision !== corpusRevision ||
          this.offlineSearchCorpusSessionGeneration !== corpusSessionGeneration ||
          cacheExpired
        ) {
          const prepared = await prepareOfflineSearchCorpus(activeDocuments, { signal: controller.signal })
          if (
            requestId !== this.searchRequestId ||
            requestKey !== this.searchRequestKey ||
            controller.signal.aborted
          ) return
          this.offlineSearchCorpus = prepared
          this.offlineSearchCorpusRevision = corpusRevision
          this.offlineSearchCorpusSessionGeneration = corpusSessionGeneration
          this.offlineSearchCorpusExpiresAt = nextExpiry
        }
        const preparedCorpus = this.offlineSearchCorpus
        if (!preparedCorpus) throw new Error('Downloaded search corpus is unavailable.')
        const ranked = await searchPreparedOfflineDocumentsAsync(preparedCorpus, query, {
          limit: OFFLINE_SEARCH_RESULT_LIMIT,
          signal: controller.signal
        })
        if (
          requestId !== this.searchRequestId ||
          requestKey !== this.searchRequestKey ||
          controller.signal.aborted
        ) return
        this.offlineCorpusCount = activeDocuments.length
        this.offlineResultsTruncated = ranked.hasMore
        this.moreError = ''
        this.searchError = ''
        this.response = {
          results: ranked.results.map(({ document, score }): DownloadedSearchRow => ({
            id: document.pageId,
            title: document.title,
            description: document.description,
            path: document.path,
            locale: document.locale,
            visibility: 'public',
            tags: [],
            score,
            matchedFields: [],
            offline: true,
            offlineSiteId: origin,
            offlinePageId: document.pageId,
            offlineLocale: document.locale
          })),
          suggestions: [],
          totalHits: 0
        }
        this.responseKey = requestKey
        this.pagination = 1
      } catch (error) {
        if (
          requestId !== this.searchRequestId ||
          requestKey !== this.searchRequestKey ||
          controller.signal.aborted
        ) return
        this.searchError = getErrorMessage(error)
        this.responseKey = ''
        this.response = emptySearchResponse()
      } finally {
        storage?.close()
        if (this.searchAbortController === controller) this.searchAbortController = null
        if (requestId === this.searchRequestId) this.searchIsLoading = false
      }
    },
  }
})
</script>

<style lang="scss">
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.search-results {
  --search-overlay-ink: rgb(var(--v-theme-on-background));
  --search-overlay-top-offset: var(--v-layout-top, 64px);
  animation: searchResultsReveal var(--wiki-motion-normal) var(--wiki-motion-ease-out);
  background: rgba(var(--v-theme-surface), .18);
  backdrop-filter: blur(6px) saturate(110%);
  box-sizing: border-box;
  inset-inline: 0;
  inset-block-start: var(--search-overlay-top-offset);
  bottom: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  position: fixed;
  text-align: center;
  width: 100%;
  z-index: 1006;

  @supports not ((backdrop-filter: blur(6px)) or (-webkit-backdrop-filter: blur(6px))) {
    background: var(--wiki-surface-raised);
    backdrop-filter: none;
  }

  &--ask {
    animation: none;
    background: transparent;
    backdrop-filter: none;
    height: 100dvh;
    inset: 0;
    overflow: hidden;
    isolation: isolate;
    z-index: 1009;
  }

  &--ask &-container--ask {
    background: transparent;
  }

  &-container {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 68rem;
    padding: 0 clamp(var(--wiki-space-3), 2vw, var(--wiki-space-6)) max(clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8)), env(safe-area-inset-bottom, 0px));
    width: 100%;

    &--ask {
      animation: agentWorkspaceReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out);
      align-items: center;
      display: flex;
      flex-direction: column;
      height: 100%;
      max-width: none;
      padding: 0;
    }
  }

  &-close {
    position: absolute !important;
    inset-inline-end: var(--wiki-space-2);
    top: var(--wiki-space-1);
    border-radius: var(--wiki-radius-pill);
    color: color-mix(in srgb, var(--search-overlay-ink) 78%, transparent);
    transition:
      background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
      color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover,
    &:active {
      background-color: color-mix(in srgb, var(--search-overlay-ink) 9%, transparent);
      color: var(--search-overlay-ink);
      transform: none;
    }

    &:focus-visible {
      outline: .125rem solid var(--wiki-focus-color);
      outline-offset: var(--wiki-focus-offset);
      box-shadow: var(--wiki-focus-ring);
    }
  }

  &--ask &-close { top: var(--wiki-space-2); }

  &-keyboard-hint {
    display: flex;
    gap: .5rem;
    justify-content: flex-end;
    padding: .65rem 1rem;
    color: color-mix(in srgb, var(--search-overlay-ink) 65%, transparent);
    font-family: var(--wiki-font-mono);
    font-size: .7rem;
  }

  &-search {
    display: flex;
    flex-direction: column;
    margin-inline: auto;
    max-height: calc(100dvh - var(--search-overlay-top-offset) - max(var(--wiki-space-4), env(safe-area-inset-bottom, 0px)));
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--wiki-surface-border-strong);
    border-radius: var(--wiki-hero-radius);
    background: var(--wiki-surface-raised);
    color: rgb(var(--v-theme-on-surface));
    box-shadow: var(--wiki-shadow-lg), var(--wiki-shadow-inset);
    text-align: start;
  }

  &-scope {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-5);
    padding: var(--wiki-space-4) var(--wiki-space-5);
    border-bottom: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-hero-radius) var(--wiki-hero-radius) 0 0;
    background:
      radial-gradient(circle at 100% 0, color-mix(in srgb, var(--wiki-ambient-accent) 14%, transparent), transparent 42%),
      var(--wiki-surface-sunken);
  }

  &-heading {
    align-items: center;
    display: flex;
    gap: .55rem;
    min-width: 0;
    margin: 0;
    color: var(--search-overlay-ink);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -.01em;
    line-height: 1.2;
  }

  &-heading .v-icon {
    flex: 0 0 auto;
    color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
  }

  &-scope-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .35rem;
    justify-content: flex-end;
  }

  &-eyebrow {
    color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
    font-size: var(--wiki-type-micro, .75rem);
    font-weight: 750;
    letter-spacing: .11em;
    line-height: 1.3;
    text-transform: uppercase;
  }

  &-content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--wiki-space-4);
  }
  &-summary {
    display: flex;
    min-width: 0;
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-2));
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-4);
    padding: 0 var(--wiki-space-1) var(--wiki-space-3);
  }

  &-summary > div { min-width: 0; }
  &-count {
    margin-top: var(--wiki-space-1);
    overflow-wrap: anywhere;
    font-size: .95rem;
    font-weight: 600;
  }
  &-window {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
    font-size: .78rem;
    font-weight: 450;
  }
  &-ask { min-height: var(--wiki-control-height); flex: 0 0 auto; letter-spacing: 0; text-transform: none; }
  &-empty-actions {
    display: flex;
    justify-content: center;
    margin-top: var(--wiki-space-4);
    width: 100%;
  }
  &-empty-ask {
    letter-spacing: 0;
    max-width: min(100%, 36rem);
    min-height: var(--wiki-control-height);
    text-transform: none;
  }

  &-help,
  &-loader,
  &-none {
    align-items: center;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 19rem;
    padding: var(--wiki-space-10) var(--wiki-space-4);
    text-align: center;
  }

  &-help-mark {
    align-items: center;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 15%, rgb(var(--v-theme-surface)));
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 28%, transparent);
    border-radius: 1.15rem;
    color: rgb(var(--v-theme-primary));
    display: flex;
    height: 4rem;
    justify-content: center;
    width: 4rem;
  }

  &-help h2 {
    font-size: clamp(1.35rem, 3vw, 1.7rem);
    letter-spacing: -.02em;
    margin: 1rem 0 .45rem;
  }

  &-help p {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
    line-height: 1.55;
    margin: 0;
    max-width: 32rem;
  }

  &-syntax-tips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--wiki-space-3);
    justify-content: center;
    margin-top: var(--wiki-space-4);
  }

  &-syntax-tip {
    align-items: center;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 68%, transparent);
    display: inline-flex;
    font-size: var(--wiki-type-micro, .75rem);
    gap: var(--wiki-space-1);

    kbd {
      background: var(--wiki-surface-sunken);
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-radius-xs);
      font-family: var(--wiki-font-mono);
      font-size: .75rem;
      padding: 0.1rem 0.35rem;
    }
  }

  &-items,
  &-suggestions {
    overflow: hidden;
    padding: 0;
    border: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-panel-radius);
    background: transparent;
    text-align: start;
  }

  &-item {
    min-width: 0;
    min-height: 5.65rem;
    padding-block: var(--wiki-space-2);
    transition: background-color var(--wiki-motion-fast) var(--wiki-motion-ease);

    &:hover,
    &:focus-visible,
    &.highlighted {
      background: color-mix(in srgb, var(--wiki-accent-warm) 10%, var(--wiki-surface-raised));
    }

    &:focus-visible {
      box-shadow: inset var(--wiki-focus-ring);
    }
  }

  &-item-mark {
    align-items: center;
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 13%, rgb(var(--v-theme-surface)));
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary)) 22%, transparent);
    border-radius: .8rem;
    color: rgb(var(--v-theme-primary));
    display: flex;
    height: 2.65rem;
    justify-content: center;
    margin-inline-end: .1rem;
    width: 2.65rem;
  }

  &-item .v-list-item-title {
    overflow-wrap: anywhere;
    font-size: .98rem;
    font-weight: 650;
  }
  &-item .v-list-item-subtitle {
    margin-top: var(--wiki-space-1);
    opacity: .8;
    overflow-wrap: anywhere;
    line-height: 1.4;
    white-space: normal;
  }

  &-match {
    margin-top: .4rem;
    color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
    font-size: .72rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  &-path {
    align-items: center;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
    display: flex;
    font-size: .72rem;
    gap: .3rem;
    margin-top: .28rem;
    min-width: 0;

    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  &-tags {
    display: flex;
    min-width: 0;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--wiki-space-1);
    margin-top: var(--wiki-space-2);
  }

  &-tags .v-chip {
    max-width: 100%;
  }

  &-tags .v-chip__content {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &-item-meta {
    align-items: center;
    display: flex;
    gap: .3rem;
  }

  &-item-chevron { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 44%, transparent); }

  &-pagination { margin: .85rem 0 .2rem; }

  &-suggestion-block {
    margin-top: var(--wiki-space-4);
    padding: var(--wiki-space-4) var(--wiki-space-1) var(--wiki-space-1);
    border-top: 1px solid var(--wiki-surface-border);
  }

  &-suggestions { margin-top: var(--wiki-space-2); }

  &-suggestions .highlighted {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface)));
  }

  &--ask .inline-agent {
    box-sizing: border-box;
    flex: 1 1 auto;
    max-width: none;
    min-height: 0;
    padding: 0;
  }

  &--ask .inline-agent__card {
    height: 100%;
    min-height: 0;
  }

  @media #{map-get($display-breakpoints, 'sm-and-down')} {
    &-container { padding-inline: var(--wiki-space-2); }
    &-container--ask { padding: 0; }
    &-scope { align-items: flex-start; flex-direction: column; gap: var(--wiki-space-3); }
    &-scope-actions { justify-content: flex-start; }
    &-scope-actions .v-btn { min-height: 2.75rem; }
    &-content { padding: var(--wiki-space-3); }
  }

  @media (max-width: 599.98px) {
    &-search { border-radius: var(--wiki-panel-radius); }
    &-scope { border-radius: var(--wiki-panel-radius) var(--wiki-panel-radius) 0 0; }
    &-scope-actions .v-btn { max-width: 100%; padding-inline: var(--wiki-space-3); }
    &-summary { align-items: flex-start; flex-wrap: wrap; }
    &-ask .v-btn__content { font-size: .78rem; }
    &-item { padding-inline: var(--wiki-space-1); }
    &-item-chevron { display: none; }
    &-item-mark { height: var(--wiki-control-height); width: var(--wiki-control-height); }
  }
}

@keyframes agentWorkspaceReveal {
  from {
    opacity: 0;
    transform: scale(.992);
  }
}

@keyframes searchResultsReveal {
  from {
    opacity: 0;
    transform: translateY(-.65rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .search-results:not(.search-results--ask) {
    background: var(--wiki-surface-raised);
    backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .search-results {
    background: Canvas;
    color: CanvasText;
    backdrop-filter: none;
  }
  .search-results-search { border: 1px solid CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  .search-results,
  .search-results-container--ask,
  .search-results-item { animation: none; transition: none; }
}
</style>

<style scoped>
.search-results-capability-note { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem 1rem; padding: .8rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); background: color-mix(in srgb, rgb(var(--v-theme-primary)) 6%, transparent); color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 76%, transparent); font-size: .78rem; }
.search-results-capability-note-title { color: var(--wiki-accent-ink, rgb(var(--v-theme-primary))); font-weight: 700; }
.search-results-capability-note p { flex: 1 1 20rem; margin: 0; }
.search-results-capability-note .v-btn { flex: 0 0 auto; }
</style>

<style scoped>
.search-results-row { position: relative; }
.search-results-row .search-results-item { padding-inline-end: 7rem; }
.search-results-preview { position: absolute; inset-inline-end: 1rem; bottom: 1rem; display: flex; align-items: center; gap: .4rem; padding: .5rem .65rem; border-radius: .65rem; color: var(--wiki-accent-ink, rgb(var(--v-theme-on-surface))); font-size: .75rem; background: rgb(var(--v-theme-primary) / .08); }
.search-results-preview:hover { background: rgb(var(--v-theme-primary) / .17); }
.search-results-preview:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
@media (max-width: 480px) { .search-results-row .search-results-item { padding-inline-end: 3.5rem; } .search-results-preview { inset-inline-end: .5rem; } .search-results-preview span { display: none; } }
</style>

<style scoped>
.search-results-continuation { padding: 1rem; text-align: center; }
.search-results-continuation p { font-size: .75rem; opacity: .7; margin: .6rem 0 0; }
</style>
