<template lang="pug">
  //- Search keeps focus in the header field, outside this dialog, so it relies on the
  //- modal focus scope (inert, aria-hidden page) instead of aria-modal; Agent mode is modal.
  .search-results(
    v-if='isAgentOpen || searchIsFocused || normalizedSearch.length > 1'
    :class='{ "search-results--ask": isAgentOpen }'
    role='dialog'
    :aria-modal='isAgentOpen ? `true` : undefined'
    :aria-label='isAgentOpen ? $t(`common:searchPanel.agentWorkspace`) : undefined'
    :aria-labelledby='isAgentOpen ? undefined : `wiki-search-title`'
    :aria-busy='!isAgentOpen && searchIsLoading'
    @click='handleBackdropClick'
  )
    .search-results-container(:class='{ "search-results-container--ask": isAgentOpen }')
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
        :page-title='agentPageTitle'
        @return-search='returnToSearch'
        @close='closeSearch'
      )
      WikiSourcePreview(
        v-if='previewSelector'
        :selector='previewSelector'
        :query='normalizedSearch'
        :can-ask='canAsk'
        @close='closePreview'
        @ask='askSource'
      )
      .search-results-search(v-if='!isAgentOpen' @click.stop)
        //- The header field is the visible input; the panel title stays for assistive technology only.
        h2#wiki-search-title.sr-only {{ $t('common:searchPanel.title') }}
        .search-results-instructions.sr-only#wiki-search-instructions {{ $t('common:searchPanel.instructions') }}
        .search-results-scope
          .search-results-scope-actions(role='group' :aria-label='$t(`common:searchPanel.scopeLabel`)')
            v-btn(
              size='small'
              prepend-icon='mdi-earth'
              :variant='!offlineSearchActive ? `tonal` : `text`'
              :color='!offlineSearchActive ? `primary` : undefined'
              :aria-pressed='!offlineSearchActive'
              @click='selectSearchScope(`wiki`)'
            ) {{ $t('common:searchPanel.scopeWiki') }}
            v-btn(
              size='small'
              prepend-icon='mdi-cloud-check-outline'
              :variant='offlineSearchActive ? `tonal` : `text`'
              :color='offlineSearchActive ? `primary` : undefined'
              :aria-pressed='offlineSearchActive'
              @click='selectSearchScope(`downloaded`)'
            ) {{ $t('common:searchPanel.scopeDownloaded') }}
            v-tooltip(v-if='currentPageLocale' location='bottom' :disabled='!offlineSearchActive')
              template(v-slot:activator='{ props: tooltipProps }')
                v-btn.search-results-scope-filter(
                  v-bind='tooltipProps'
                  size='small'
                  prepend-icon='mdi-translate'
                  :variant='searchRestrictLocale ? `tonal` : `text`'
                  :color='searchRestrictLocale ? `primary` : undefined'
                  :aria-pressed='searchRestrictLocale'
                  :aria-disabled='offlineSearchActive ? `true` : undefined'
                  :aria-label='$t(`common:searchPanel.scopeLocale`, { locale: currentPageLocale.toLocaleUpperCase() })'
                  @click='toggleLocaleScope'
                ) {{ currentPageLocale.toLocaleUpperCase() }}
              span {{ $t('common:searchPanel.scopeNeedsServer') }}
            v-tooltip(v-if='currentPagePath' location='bottom' :disabled='!offlineSearchActive')
              template(v-slot:activator='{ props: tooltipProps }')
                v-btn.search-results-scope-filter(
                  v-bind='tooltipProps'
                  size='small'
                  prepend-icon='mdi-file-tree-outline'
                  :variant='searchRestrictPath ? `tonal` : `text`'
                  :color='searchRestrictPath ? `primary` : undefined'
                  :aria-pressed='searchRestrictPath'
                  :aria-disabled='offlineSearchActive ? `true` : undefined'
                  @click='togglePathScope'
                ) {{ $t('common:searchPanel.scopeTree') }}
              span {{ $t('common:searchPanel.scopeNeedsServer') }}
          v-btn.search-results-close(
            size='small'
            variant='text'
            prepend-icon='mdi-close'
            @click='closeSearch'
            data-modal-focus-key='search-close'
          ) {{ $t('common:searchPanel.closeSearch') }}
        .search-results-content
          .search-results-capability-note(v-if='offlineSearchActive || serverUnavailable' role='status' aria-live='polite')
            .search-results-capability-note-title {{ serverUnavailable ? $t('common:searchPanel.serverUnavailableTitle') : $t('common:searchPanel.scopeDownloaded') }}
            p {{ serverUnavailable ? offlineSearchUnavailableDescription : offlineSearchScopeDescription }}
            v-btn(
              v-if='serverUnavailable'
              size='small'
              variant='tonal'
              prepend-icon='mdi-refresh'
              :loading='serverRetryPending'
              @click='retrySearch'
            ) {{ $t('common:searchPanel.retryConnection') }}
          .search-results-help(v-if='normalizedSearch.length < 2')
            .search-results-help-mark(aria-hidden='true')
              v-icon(icon='mdi-text-search' size='34')
            h3 {{ $t('common:searchPanel.helpTitle') }}
            p(v-if='offlineSearchActive') {{ $t('common:searchPanel.helpOffline') }}
            p(v-else) {{ $t('common:searchPanel.helpOnline') }}
            .search-results-syntax-tips(v-if='!offlineSearchActive')
              span.search-results-syntax-tip
                kbd "exact phrase"
                | {{ $t('common:searchPanel.tipExact') }}
              span.search-results-syntax-tip
                kbd -word
                | {{ $t('common:searchPanel.tipExclude') }}
              span.search-results-syntax-tip
                kbd or
                | {{ $t('common:searchPanel.tipEither') }}
          .search-results-loader(v-else-if='searchIsLoading')
            async-state(
              state='loading'
              :title='$t(`common:header.searchLoading`)'
              :message='searchLoadingMessage'
            )
          .search-results-none(v-else-if='searchError')
            async-state(
              state='error'
              :title='offlineSearchActive ? $t(`common:searchPanel.errorTitleDownloaded`) : $t(`common:searchPanel.errorTitle`)'
              :message='searchError'
              :retry-label='serverUnavailable ? $t(`common:searchPanel.retryConnection`) : $t(`common:searchPanel.tryAgain`)'
              @retry='retrySearch'
            )
          template(v-else)
            .search-results-updating(v-if='resultsUpdating' role='status' aria-live='polite' aria-atomic='true') {{ $t('common:searchPanel.updatingResults') }}
            .search-results-summary(v-if='hasFreshResponse')
              div(role='status' aria-live='polite' aria-atomic='true')
                .search-results-eyebrow {{ offlineSearchActive ? $t('common:searchPanel.scopeDownloaded') : $t('common:searchPanel.resultsEyebrow') }}
                .search-results-count(v-if='resultSummary')
                  span {{ resultSummary }}
                  span.search-results-window(v-if='resultSummaryHint')  · {{ resultSummaryHint }}
              v-tooltip(v-if='canAsk || serverUnavailable' location='bottom' :disabled='canAsk')
                template(v-slot:activator='{ props: tooltipProps }')
                  v-btn.search-results-ask(
                    v-bind='tooltipProps'
                    color='primary'
                    variant='tonal'
                    prepend-icon='mdi-creation-outline'
                    :aria-disabled='!canAsk ? `true` : undefined'
                    @click='askCurrentQuery'
                    data-modal-focus-key='search-ask-query'
                  ) {{ $t('common:searchPanel.askAbout') }}
                span {{ askUnavailableReason }}
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
                  prepend-icon='mdi-creation-outline'
                  :aria-disabled='!canAsk ? `true` : undefined'
                  :aria-describedby='!canAsk ? `wiki-search-ask-reason` : undefined'
                  @click='askCurrentQuery'
                  data-modal-focus-key='search-ask-empty'
                ) {{ $t('common:searchPanel.askWikiAbout', { query: normalizedSearch }) }}
              p.search-results-reason#wiki-search-ask-reason(v-if='!canAsk') {{ askUnavailableReason }}
            template(v-if='results.length > 0')
              v-list.search-results-items(
                id='wiki-search-results'
                role='grid'
                :aria-busy='searchIsLoading'
                :class='{ "search-results-items--stale": !hasFreshResponse }'
                :aria-label='$t(`common:searchPanel.resultsLabel`)'
              )
                template(v-for='(item, idx) of results' :key='resultKey(item)')
                  .search-results-row(role='row')
                    .search-results-main-cell(role='gridcell' :id='resultOptionId(idx)' :aria-selected='idx === cursor')
                      v-list-item.search-results-item(
                        lines='three'
                        :href='pageHref(item)'
                        :data-no-wiki-navigation='isDownloadedResult(item) ? `true` : undefined'
                        :class='idx === cursor ? `highlighted` : ``'
                        :aria-disabled='!hasFreshResponse ? `true` : undefined'
                        @click='handleResultClick($event, item)'
                      )
                        template(v-slot:prepend)
                          .search-results-item-mark(aria-hidden='true')
                            v-icon(icon='mdi-file-document-outline' size='21')
                        v-list-item-title(:title='item.title')
                          template(v-for='(segment, segmentIndex) of resultHighlights[idx].title' :key='segmentIndex')
                            mark.search-results-text-match(v-if='segment.matched') {{ segment.text }}
                            template(v-else) {{ segment.text }}
                        v-list-item-subtitle
                          template(v-for='(segment, segmentIndex) of resultHighlights[idx].description' :key='segmentIndex')
                            mark.search-results-text-match(v-if='segment.matched') {{ segment.text }}
                            template(v-else) {{ segment.text }}
                        .search-results-match(v-if='matchSummary(item)') {{ matchSummary(item) }}
                        .search-results-path
                          v-icon(icon='mdi-source-branch' size='14' aria-hidden='true')
                          span
                            template(v-for='(segment, segmentIndex) of resultHighlights[idx].path' :key='segmentIndex')
                              mark.search-results-text-match(v-if='segment.matched') {{ segment.text }}
                              template(v-else) {{ segment.text }}
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
                            v-icon(start icon='mdi-graph-outline' size='12' aria-hidden='true')
                            | {{ $t('common:searchPanel.linkedPage') }}
                        template(v-slot:append)
                          .search-results-item-meta
                            v-chip(v-if='item.visibility === "private"' size='x-small' label color='warning' variant='tonal')
                              v-icon(start icon='mdi-lock-outline' size='12' aria-hidden='true')
                              | {{ $t('common:searchPanel.private') }}
                            v-chip(size='x-small' label variant='outlined') {{ item.locale.toLocaleUpperCase() }}
                            v-icon.search-results-item-chevron(icon='mdi-chevron-right' size='19' aria-hidden='true')
                    .search-results-preview-cell(role='gridcell')
                      v-tooltip(location='start' :disabled='previewAvailable')
                        template(v-slot:activator='{ props: tooltipProps }')
                          button.search-results-preview(
                            v-bind='tooltipProps'
                            type='button'
                            :aria-label='$t(`common:searchPanel.previewLabel`, { title: item.title })'
                            :aria-disabled='!previewAvailable ? `true` : undefined'
                            @click='openPreview(item)'
                          )
                            v-icon(icon='mdi-text-box-search-outline' size='18' aria-hidden='true')
                            span {{ $t('common:searchPanel.preview') }}
                        span {{ previewUnavailableReason }}
                  v-divider(v-if='idx < results.length - 1' aria-hidden='true')
            .search-results-continuation(v-if='!offlineSearchActive && (response.nextCursor || moreError)')
              v-btn(v-if='response.nextCursor' variant='tonal' :loading='loadingMore' prepend-icon='mdi-chevron-down' @click='loadMoreResults') {{ $t('common:searchPanel.moreResults') }}
              p(v-if='moreError' role='alert') {{ moreError }}
            .search-results-suggestion-block(v-if='suggestions.length')
              .search-results-eyebrow {{ $t('common:searchPanel.suggested') }}
              v-list.search-results-suggestions(
                id='wiki-search-suggestions'
                role='listbox'
                :aria-busy='searchIsLoading'
                :aria-label='$t(`common:searchPanel.suggestionsLabel`)'
                :class='{ "search-results-suggestions--stale": !hasFreshResponse }'
                density='compact'
              )
                template(v-for='(term, idx) of suggestions' :key='occurrenceKey(suggestions, term, idx)')
                  v-list-item(
                    :id='`wiki-search-suggestion-${idx}`'
                    role='option'
                    :aria-selected='idx + results.length === cursor'
                    :class='idx + results.length === cursor ? `highlighted` : ``'
                    prepend-icon='mdi-magnify'
                    :aria-disabled='!hasFreshResponse ? `true` : undefined'
                    @click='hasFreshResponse && setSearchTerm(term)'
                  )
                    v-list-item-title {{ term }}
                  v-divider(v-if='idx < suggestions.length - 1' aria-hidden='true')
        .search-results-keyboard-hint(
          v-if='!isAgentOpen && normalizedSearch.length >= 2'
          aria-hidden='true'
        )
          span
            kbd ↑↓
            | {{ $t('common:searchPanel.keyMove') }}
          span
            kbd ↵
            | {{ $t('common:searchPanel.keyOpen') }}
          span(v-if='previewAvailable' :title='$t(`common:searchPanel.previewShortcut`)')
            kbd Alt+↵
            | {{ $t('common:searchPanel.keyPreview') }}
          span
            kbd Esc
            | {{ $t('common:searchPanel.keyClose') }}

</template>
<script lang='ts'>
import { offlinePageHref, requestOfflineSavedPageOpen } from '../../helpers/offline-routes.ts'
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
import { readPrivateCorpus } from '../../helpers/offline-crypto.ts'
import {
  OFFLINE_SEARCH_RESULT_LIMIT,
  mergeOfflineSearchCorpora,
  prepareOfflineSearchCorpus,
  searchPreparedOfflineDocumentsAsync,
  type OfflineSearchCorpus
} from '../../helpers/offline-search.ts'
import { pwaState, retryServerConnection } from '../../helpers/pwa.ts'
import {
  currentOfflineReadingEpoch,
  currentOfflineReadingHandle,
  OFFLINE_READING_STATE_EVENT,
  type OfflineReadingHandleV1
} from '../../helpers/offline-session.ts'
import {
  OfflinePrivateSearchDocumentV1Schema,
  type OfflineSearchDocumentV1,
  type OfflineSnapshotRecord
} from '../../../shared/offline.ts'
import { activeOwnedOverlayRoots, createModalFocusScope, type ModalFocusScope } from './modal-focus-scope'
import { isWikiNavigationClick, navigateToWikiPage } from '../../helpers/wiki-navigation'
import { createSearchHighlighter, type SearchTextSegment } from '../../helpers/search-highlight.ts'

type SearchScope = 'wiki' | 'downloaded'
type OnlineSearchRow = PageSearchRow & {
  readonly offline?: false
}
type DownloadedSearchRow = PageSearchRow & {
  readonly offline: true
  readonly offlineSiteId: string
  readonly offlineCanonicalPath: string
  readonly offlinePageId: number
  readonly offlineLocale: string
}
type SearchResultRow = OnlineSearchRow | DownloadedSearchRow
type SearchResponse = Omit<PageSearchResult, 'results'> & {
  results: SearchResultRow[]
}

const OFFLINE_DOCUMENT_PATH = '/?saved=1'
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

const toOfflinePrivateSearchDocument = (value: unknown): OfflineSearchDocumentV1 | null => {
  const parsed = OfflinePrivateSearchDocumentV1Schema.safeParse(value)
  if (!parsed.success) return null
  const { sourceRevision: _sourceRevision, ...document } = parsed.data
  return document
}
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
      offlinePrivateSearchCorpus: null as OfflineSearchCorpus | null,
      offlinePrivateSearchCorpusRevision: null as number | null,
      offlinePrivateSearchCorpusSessionGeneration: null as number | null,
      offlinePrivateSearchEnabled: false,
      serverRetryPending: false,
      searchRetryId: 0,
      cursor: -1,
      approvalId: '',
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
      get(): string { return wikiStore.site.search ?? '' },
      set(value: string | null | undefined) { wikiStore.site.search = value ?? '' }
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
    offlineSearchScopeDescription(): string {
      return this.offlinePrivateSearchEnabled
        ? this.$t('common:searchPanel.savedScopePrivate')
        : this.$t('common:searchPanel.savedScopePublic')
    },
    offlineSearchUnavailableDescription(): string {
      return this.offlinePrivateSearchEnabled
        ? this.$t('common:searchPanel.serverUnavailablePrivate')
        : this.$t('common:searchPanel.serverUnavailablePublic')
    },
    searchLoadingMessage(): string {
      if (!this.offlineSearchActive) return this.$t('common:searchPanel.loadingWiki')
      if (this.offlineCorpusCount === null) return this.$t('common:searchPanel.loadingSaved')
      return this.$t('common:searchPanel.loadingSavedCount', { count: this.offlineCorpusCount })
    },
    emptyResultsMessage(): string {
      if (this.offlineSearchActive) return this.$t('common:searchPanel.emptySaved')
      return this.canAsk ? this.$t('common:searchPanel.emptyAsk') : this.$t('common:searchPanel.empty')
    },
    /** One summary line for the single "More results" paging model; truncation is folded in here. */
    resultSummary(): string {
      if (!this.hasFreshResponse) return ''
      if (this.offlineSearchActive) {
        const count = this.offlineCorpusCount
        if (count === null) return ''
        return this.offlineResultsTruncated
          ? this.$t('common:searchPanel.savedTop', { shown: this.response.results.length, count })
          : this.$t('common:searchPanel.savedSearched', { count })
      }
      const total = this.response.totalHits
      const shown = this.response.results.length
      if (shown < 1) return ''
      if (this.response.windowTruncated) return this.$t('common:searchPanel.topOfAtLeast', { shown, total })
      if (shown < total) return this.$t('common:searchPanel.topOf', { shown, total })
      return this.$t('common:searchPanel.matches', { count: total })
    },
    resultSummaryHint(): string {
      if (!this.hasFreshResponse || this.response.results.length < 1) return ''
      if (this.offlineSearchActive) return this.offlineResultsTruncated ? this.$t('common:searchPanel.narrowQuery') : ''
      return this.response.windowTruncated ? this.$t('common:searchPanel.narrowScope') : ''
    },
    askUnavailableReason(): string {
      if (this.serverUnavailable) return this.$t('common:searchPanel.askNeedsServer')
      if (!this.authAuthorityReady) return this.$t('common:searchPanel.askNeedsSession')
      return this.$t('common:searchPanel.askNeedsVerify')
    },
    previewAvailable(): boolean {
      return this.serverCapabilitiesAvailable && !this.offlineSearchActive && !this.searchIsLoading && this.hasFreshResponse
    },
    previewUnavailableReason(): string {
      if (!this.serverCapabilitiesAvailable) return this.$t('common:searchPanel.previewNeedsServer')
      if (this.offlineSearchActive) return this.$t('common:searchPanel.previewOnlineOnly')
      return this.$t('common:searchPanel.previewNeedsFresh')
    },
    searchRestrictPath: {
      get(): boolean { return wikiStore.site.searchRestrictPath },
      set(value: boolean) { wikiStore.site.searchRestrictPath = value }
    },
    results(): SearchResultRow[] {
      return this.response.results
    },
    resultHighlights(): { title: SearchTextSegment[], description: SearchTextSegment[], path: SearchTextSegment[] }[] {
      const highlight = createSearchHighlighter(this.hasFreshResponse ? this.normalizedSearch : '', !this.offlineSearchActive)
      return this.results.map(item => ({
        title: highlight(item.title),
        description: highlight(item.description),
        path: highlight(item.path)
      }))
    },
    normalizedSearch(): string {
      return (this.search ?? '').trim()
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
    agentPageTitle(): string { return this.agentOpeningPage?.id === wikiStore.page.id ? wikiStore.page.title : '' },
    currentPageId(): number { return wikiStore.page.id },
    currentPageLocale(): string { return wikiStore.page.locale },
    currentPagePath(): string { return wikiStore.page.path },
    currentPageUpdatedAt(): string { return wikiStore.page.updatedAt },
    currentPageContextKey(): string {
      return JSON.stringify([this.currentPageId, this.currentPageLocale, this.currentPagePath, this.currentPageUpdatedAt])
    },
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
    resultsUpdating(): boolean {
      return this.normalizedSearch.length >= 2 &&
        !this.hasFreshResponse &&
        !this.searchError &&
        (this.searchIsLoading || this.searchTimer !== null)
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
    authAuthorityReady(ready: boolean) {
      if (ready) useAgentsStore().notePageNavigation(this.currentPageHint(), this.agentOwnerId)
    },
    currentPageContextKey() {
      this.agentResumeSessionId = null
      const page = this.currentPageHint()
      useAgentsStore().notePageNavigation(page, this.authAuthorityReady ? this.agentOwnerId : undefined)
      if (this.agentOpeningPageCaptured) this.agentOpeningPage = page
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
    if (this.authAuthorityReady) useAgentsStore().notePageNavigation(this.currentPageHint(), this.agentOwnerId)
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
    document.addEventListener('keydown', this.handleSearchPreviewShortcut, true)
    if (this.searchIsFocused) void this.activateAgentModal()
    window.addEventListener(OFFLINE_READING_STATE_EVENT, this.handleOfflineReadingStateChange)
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
    window.removeEventListener(OFFLINE_READING_STATE_EVENT, this.handleOfflineReadingStateChange)
    document.removeEventListener('focusin', this.captureSearchRestoreTarget, true)
    document.removeEventListener('keydown', this.handleSearchPreviewShortcut, true)
    this.deactivateModalLayers(false)
    this.agentResumeSessionId = null
  },
  methods: {
    matchSummary(item: PageSearchRow): string {
      const labels = {
        title: 'common:searchPanel.matchTitle',
        tag: 'common:searchPanel.matchTag',
        path: 'common:searchPanel.matchPath',
        description: 'common:searchPanel.matchDescription',
        content: 'common:searchPanel.matchContent',
        graph: 'common:searchPanel.matchGraph',
        knowledge: 'common:searchPanel.matchKnowledge'
      }
      const fields = [...new Set(item.matchedFields ?? [])].map(field => labels[field]).filter(Boolean)
      return fields.length ? this.$t('common:searchPanel.matchedPrefix', { fields: fields.slice(0, 3).map(key => this.$t(key)).join(' · ') }) : ''
    },
    currentPageHint(): AgentCurrentPageHint | null {
      const id = this.currentPageId
      if (id < 1 || !this.currentPageLocale || !this.currentPagePath || !this.currentPageUpdatedAt) return null
      return { id, locale: this.currentPageLocale, path: this.currentPagePath, observedUpdatedAt: this.currentPageUpdatedAt }
    },
    latchAgentOpeningPage(): void {
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
        onEscape: this.closeSearch
      })
      this.pendingAskRestoreTarget = null
      this.modalFocusScope = focusScope
      const inlineAgent = this.$refs.inlineAgent as InlineAgentChatRef | undefined
      // Mobile: auto-focusing the composer opens the soft keyboard and shifts the
      // whole agent UI; keep the panel still until the user taps the input.
      if (!window.matchMedia('(max-width: 639.98px)').matches) await inlineAgent?.focusComposer()
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
      // The store owns the same-page, 15-minute resume window; a search
      // excursion must not create an explicit session override without expiry.
      this.agentResumeSessionId = null
    },
    openAsk(): void {
      if (!this.canAsk) return
      this.latchAgentOpeningPage()
      this.directPromptHandoffId += 1
      this.pendingAskRestoreTarget = this.activeModalOpener()
      this.searchIsFocused = true
      this.searchMode = 'ask'
    },
    handleOfflineReadingStateChange(): void {
      this.searchRequestId += 1
      this.searchRetryId += 1
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchAbortController?.abort()
      this.searchAbortController = null
      this.searchIsLoading = false
      this.searchError = ''
      this.moreError = ''
      this.response = emptySearchResponse()
      this.responseKey = ''
      this.cursor = -1
      this.offlineCorpusCount = null
      this.offlineResultsTruncated = false
      this.offlineSearchCorpus = null
      this.offlineSearchCorpusRevision = null
      this.offlineSearchCorpusSessionGeneration = null
      this.offlineSearchCorpusExpiresAt = null
      this.offlinePrivateSearchCorpus = null
      this.offlinePrivateSearchCorpusRevision = null
      this.offlinePrivateSearchCorpusSessionGeneration = null
      this.offlinePrivateSearchEnabled = typeof currentOfflineReadingHandle === 'function' && Boolean(currentOfflineReadingHandle())
      this.search = ''
    },
    toggleLocaleScope(): void {
      if (this.offlineSearchActive) return
      this.searchRestrictLocale = !this.searchRestrictLocale
    },
    togglePathScope(): void {
      if (this.offlineSearchActive) return
      this.searchRestrictPath = !this.searchRestrictPath
    },
    /** Agent search button: leave the Agent for the page it opened over, then open search with the field focused. */
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
    queueSearch(query: string | null | undefined): void {
      this.cursor = -1
      this.searchRequestId += 1
      const requestId = this.searchRequestId
      this.searchAbortController?.abort()
      this.searchAbortController = null
      const normalizedQuery = (query ?? '').trim()
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchIsLoading = false
      if (this.searchMode !== 'search') return
      if (normalizedQuery.length < 2) {
        this.searchError = ''
        this.responseKey = ''
        this.response = emptySearchResponse()
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
    handleSearchPreviewShortcut(event: KeyboardEvent): void {
      if (
        event.defaultPrevented || event.isComposing || event.key !== 'Enter' ||
        !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        this.searchMode !== 'search' || !this.searchIsFocused ||
        !(event.target instanceof HTMLInputElement) ||
        event.target !== document.activeElement || event.target !== this.findSearchControl()
      ) return
      // Alt+Enter never falls through to ordinary navigation or Agent submission.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat || this.previewSelector || !this.previewAvailable) return
      const result = this.cursor >= 0 && this.cursor < this.results.length ? this.results[this.cursor] : undefined
      if (result && !isDownloadedSearchRow(result)) this.openPreview(result)
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
      await (this.$refs.inlineAgent as InlineAgentChatRef | undefined)?.preparePrompt(this.normalizedSearch || this.$t('common:searchResults.helpMeUnderstand', { title: source.title, interpolation: { escapeValue: false } }), source, this.agentSearchScope())
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
      this.previewSelector = null
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
      return `wiki-search-result-${index}`
    },
    pageHref(item: SearchResultRow): string {
      if (isDownloadedSearchRow(item)) {
        if (item.visibility === 'private') {
          return item.offlineCanonicalPath.startsWith('/') ? item.offlineCanonicalPath : `/${item.offlineCanonicalPath}`
        }
        return offlinePageHref({ siteId: item.offlineSiteId, snapshot: { canonicalPath: item.offlineCanonicalPath } }, window.location.origin) ?? OFFLINE_DOCUMENT_PATH
      }
      const visibilityScope = item.visibility === 'private' ? '/_private' : ''
      return `${visibilityScope}/${item.locale}/${item.path}`
    },
    requestOfflineSavedResultOpen(item: SearchResultRow): boolean {
      if (!isDownloadedSearchRow(item) || item.visibility !== 'private' || !currentOfflineReadingHandle()) return false
      return requestOfflineSavedPageOpen({
        siteId: item.offlineSiteId,
        pageId: item.offlinePageId,
        locale: item.offlineLocale,
        audience: 'private',
        canonicalPath: item.offlineCanonicalPath
      })
    },
    openPreview(item: SearchResultRow): void {
      if (!this.previewAvailable || this.previewSelector || isDownloadedSearchRow(item)) return
      this.previewSelector = { id: Number(item.id) }
    },
    async closePreview(): Promise<void> {
      this.previewSelector = null
      await this.$nextTick()
      if (!this.previewSelector && this.searchIsFocused && this.searchMode === 'search') {
        this.findSearchControl()?.focus({ preventScroll: true })
      }
    },
    handleResultClick(event: Event, item: SearchResultRow): void {
      if (event.defaultPrevented) return
      if (event instanceof MouseEvent) {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
        const anchor = event.currentTarget
        if (!isDownloadedSearchRow(item) && anchor instanceof HTMLAnchorElement && !isWikiNavigationClick(event, anchor)) return
      }
      if (!this.hasFreshResponse) {
        event.preventDefault()
        return
      }
      if (this.requestOfflineSavedResultOpen(item)) {
        event.preventDefault()
        this.closeSearch()
        return
      }
      if (!isDownloadedSearchRow(item) && !this.serverCapabilitiesAvailable) {
        event.preventDefault()
        return
      }
      this.closeSearch()
    },
    navigateToPage(item: SearchResultRow): void {
      if (!this.hasFreshResponse) return
      if (this.requestOfflineSavedResultOpen(item)) {
        this.closeSearch()
        return
      }
      if (!isDownloadedSearchRow(item) && !this.serverCapabilitiesAvailable) return
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
        this.response = { ...next, results: [...this.response.results, ...added] }
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
      const getReadingHandle = typeof currentOfflineReadingHandle === 'function' ? currentOfflineReadingHandle : (() => null)
      const getReadingEpoch = typeof currentOfflineReadingEpoch === 'function' ? currentOfflineReadingEpoch : (() => 0)
      const readingHandle: OfflineReadingHandleV1 | null = getReadingHandle()
      const readingEpoch = getReadingEpoch()
      const makeEmptyResponse = typeof emptySearchResponse === 'function'
        ? emptySearchResponse
        : (() => ({ results: [], suggestions: [], totalHits: 0 }))
      const documentIdentity = (document: Pick<OfflineSearchDocumentV1, 'siteId' | 'pageId' | 'locale'>): string =>
        `${document.siteId}\u0000${document.pageId}\u0000${document.locale}`
      let storage: Awaited<ReturnType<typeof openOfflineStorage>> | null = null
      try {
        const origin = window.location.origin
        storage = await openOfflineStorage()
        const isCurrent = (): boolean =>
          requestId === this.searchRequestId &&
          requestKey === this.searchRequestKey &&
          this.searchMode === 'search' &&
          this.offlineSearchActive &&
          !controller.signal.aborted &&
          getReadingEpoch() === readingEpoch &&
          getReadingHandle() === readingHandle
        if (!isCurrent()) return

        const corpus = await storage.readSnapshotCorpus()
        if (!isCurrent()) return
        const corpusRevision = corpus.corpusRevision
        const corpusSessionGeneration = corpus.sessionGeneration
        const sessionGeneration = readingHandle?.sessionGeneration ?? corpusSessionGeneration
        if (readingHandle && corpusSessionGeneration !== sessionGeneration) return

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

        let privateDocuments: OfflineSearchDocumentV1[] = []
        if (readingHandle) {
          const privateCorpus = await readPrivateCorpus(readingHandle, storage, corpusRevision)
          if (!isCurrent()) return
          privateDocuments = privateCorpus.searchDocuments.flatMap(value => {
            const document = toOfflinePrivateSearchDocument(value)
            return document ? [document] : []
          })
          this.offlinePrivateSearchEnabled = true
        } else {
          this.offlinePrivateSearchEnabled = false
          this.offlinePrivateSearchCorpus = null
          this.offlinePrivateSearchCorpusRevision = null
          this.offlinePrivateSearchCorpusSessionGeneration = null
        }

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
          if (!isCurrent()) return
          this.offlineSearchCorpus = prepared
          this.offlineSearchCorpusRevision = corpusRevision
          this.offlineSearchCorpusSessionGeneration = corpusSessionGeneration
          this.offlineSearchCorpusExpiresAt = nextExpiry
        }
        if (readingHandle && (
          this.offlinePrivateSearchCorpus === null ||
          this.offlinePrivateSearchCorpusRevision !== corpusRevision ||
          this.offlinePrivateSearchCorpusSessionGeneration !== sessionGeneration
        )) {
          const preparedPrivate = await prepareOfflineSearchCorpus(privateDocuments, { signal: controller.signal })
          if (!isCurrent()) return
          this.offlinePrivateSearchCorpus = preparedPrivate
          this.offlinePrivateSearchCorpusRevision = corpusRevision
          this.offlinePrivateSearchCorpusSessionGeneration = sessionGeneration
        }
        const preparedPublic = this.offlineSearchCorpus
        if (!preparedPublic) throw new Error(this.$t('common:searchResults.downloadedSearchCorpusUnavailable'))
        const mergeCorpora = typeof mergeOfflineSearchCorpora === 'function'
          ? mergeOfflineSearchCorpora
          : (publicCorpus: OfflineSearchCorpus, _privateCorpus: OfflineSearchCorpus | null): OfflineSearchCorpus => publicCorpus
        const preparedCorpus = mergeCorpora(preparedPublic, readingHandle ? this.offlinePrivateSearchCorpus : null)
        if (!isCurrent()) return
        const ranked = await searchPreparedOfflineDocumentsAsync(preparedCorpus, query, {
          limit: OFFLINE_SEARCH_RESULT_LIMIT,
          signal: controller.signal
        })
        if (!isCurrent()) return
        const currentRevision = await storage.currentCorpusRevision?.()
        const currentSessionGeneration = await storage.currentSessionGeneration?.()
        if (
          !isCurrent() ||
          (currentRevision !== undefined && currentRevision !== corpusRevision) ||
          (currentSessionGeneration !== undefined && currentSessionGeneration !== sessionGeneration)
        ) return

        const privateIdentities = new Set(privateDocuments.map(documentIdentity))
        const resultDocuments = new Set<string>()
        for (const document of activeDocuments) resultDocuments.add(documentIdentity(document))
        for (const document of privateDocuments) resultDocuments.add(documentIdentity(document))
        this.offlineCorpusCount = resultDocuments.size
        this.offlineResultsTruncated = ranked.hasMore
        this.moreError = ''
        this.searchError = ''
        this.response = {
          results: ranked.results.map(({ document, score }): DownloadedSearchRow => {
            const isPrivate = privateIdentities.has(documentIdentity(document))
            return {
              id: document.pageId,
              title: document.title,
              description: document.description,
              path: document.path,
              locale: document.locale,
              visibility: isPrivate ? 'private' : 'public',
              tags: [],
              score,
              matchedFields: [],
              offline: true,
              offlineSiteId: document.siteId,
              offlinePageId: document.pageId,
              offlineCanonicalPath: document.canonicalPath,
              offlineLocale: document.locale
            }
          }),
          suggestions: [],
          totalHits: 0
        }
        this.responseKey = requestKey
      } catch (error) {
        if (
          requestId !== this.searchRequestId ||
          requestKey !== this.searchRequestKey ||
          controller.signal.aborted ||
          getReadingEpoch() !== readingEpoch ||
          getReadingHandle() !== readingHandle
        ) return
        this.searchError = getErrorMessage(error)
        this.responseKey = ''
        this.response = makeEmptyResponse()
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
  --search-overlay-top-offset: var(--search-header-height, 52px);
  // Lighter glass than the header: the page stays visible, softened, behind the results panel.
  --search-overlay-glass: color-mix(in srgb, rgb(var(--v-theme-background)) 18%, transparent);
  --search-overlay-blur: blur(4px) saturate(125%);
  animation: searchResultsReveal var(--wiki-motion-normal) var(--wiki-motion-ease-out);
  background: var(--search-overlay-glass);
  -webkit-backdrop-filter: var(--search-overlay-blur);
  backdrop-filter: var(--search-overlay-blur);
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
    background: color-mix(in srgb, rgb(var(--v-theme-background)) 72%, transparent);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  &--ask {
    animation: none;
    background: transparent;
    -webkit-backdrop-filter: none;
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

  &-keyboard-hint {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: var(--wiki-space-4);
    justify-content: flex-end;
    padding: .65rem 1rem;
    border-top: 1px solid var(--wiki-surface-border);
    color: var(--wiki-text-muted);
    font-size: .75rem;

    span {
      align-items: center;
      display: inline-flex;
      gap: var(--wiki-space-1);
    }

    kbd {
      font-family: var(--wiki-font-mono);
      font-size: .7rem;
      padding: 0 .3rem;
      border: 1px solid var(--wiki-surface-border);
      border-radius: var(--wiki-radius-xs);
    }
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
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
    gap: var(--wiki-space-5);
    padding: var(--wiki-space-3) var(--wiki-space-5);
    border-bottom: 1px solid var(--wiki-surface-border);
    border-radius: var(--wiki-hero-radius) var(--wiki-hero-radius) 0 0;
    background:
      radial-gradient(circle at 100% 0, color-mix(in srgb, var(--wiki-ambient-accent) 14%, transparent), transparent 42%),
      var(--wiki-surface-sunken);
  }

  &-scope-actions {
    align-items: center;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    flex-wrap: wrap;
    gap: .35rem;
    justify-content: flex-start;
  }

  &-close {
    flex: 0 0 auto;
    margin-inline-start: auto;
  }

  // Disabled-with-reason controls stay focusable so their tooltip can explain why.
  &-scope-filter[aria-disabled='true'],
  &-ask[aria-disabled='true'],
  &-empty-ask[aria-disabled='true'] {
    opacity: .6;
  }

  &-reason {
    margin: var(--wiki-space-2) 0 0;
    color: var(--wiki-text-muted);
    font-size: .8rem;
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
    color: var(--wiki-text-muted);
    font-size: .78rem;
    font-weight: 450;
  }
  &-updating {
    padding: 0 var(--wiki-space-1) var(--wiki-space-3);
    color: var(--wiki-text-muted);
    font-size: .78rem;
    line-height: 1.4;
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
    color: var(--wiki-primary-ink);
    display: flex;
    height: 4rem;
    justify-content: center;
    width: 4rem;
  }

  &-help h3 {
    font-size: clamp(1.35rem, 3vw, 1.7rem);
    letter-spacing: -.02em;
    margin: 1rem 0 .45rem;
  }

  &-help p {
    color: var(--wiki-text-muted);
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
    color: var(--wiki-text-muted);
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
  &-items--stale,
  &-suggestions--stale {
    opacity: .6;
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
    &.highlighted::before {
      position: absolute;
      inset-inline-start: 0;
      inset-block: .65rem;
      width: 3px;
      border-radius: 2px;
      background: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
      content: '';
      pointer-events: none;
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
    color: var(--wiki-primary-ink);
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
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: 1.4;
    overflow: hidden;
    white-space: normal;
  }
  &-item .v-list-item-subtitle {
    margin-top: var(--wiki-space-1);
    color: var(--wiki-text-muted);
    opacity: 1;
    overflow-wrap: anywhere;
    line-height: 1.4;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  &-text-match {
    background: color-mix(in srgb, var(--wiki-accent-warm) 20%, transparent);
    border-radius: .15em;
    color: inherit;
    padding: 0;
  }
  &-item .v-list-item__content { min-width: 0; }

  &-match {
    margin-top: .4rem;
    color: var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
    font-size: .72rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  &-path {
    align-items: center;
    color: var(--wiki-text-muted);
    display: flex;
    font-size: .72rem;
    gap: .3rem;
    margin-top: .28rem;
    min-width: 0;

    > .v-icon { flex: 0 0 auto; }
    > span {
      min-width: 0;
      overflow-wrap: anywhere;
      white-space: normal;
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

  &-item-chevron { color: var(--wiki-text-subtle); }

  &-suggestion-block {
    margin-top: var(--wiki-space-4);
    padding: var(--wiki-space-4) var(--wiki-space-1) var(--wiki-space-1);
    border-top: 1px solid var(--wiki-surface-border);
  }

  &-suggestions { margin-top: var(--wiki-space-2); }

  &-suggestions .highlighted {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface)));
    border-inline-start: 3px solid var(--wiki-accent-ink, rgb(var(--v-theme-primary)));
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
    // The mobile search field occupies the app bar's 48px extension.
    --search-overlay-top-offset: calc(var(--search-header-height, 52px) + 48px);
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
    &-item .v-list-item__append { align-self: start; margin-inline-start: .25rem; }
    &-item-meta { align-items: flex-end; flex-direction: column; max-width: 5rem; }
    &-item-meta .v-chip { max-width: 100%; }
    &-item-meta .v-chip__content { overflow: hidden; text-overflow: ellipsis; }
  }
}

.nav-header--dense ~ .search-results {
  --search-header-height: 48px;
}

// Keep opacity off the glass surfaces' ancestors: a translucent ancestor
// becomes a backdrop root and hides the page from blur until the fade ends.
.search-results-container--ask .inline-agent__toolbar > *,
.search-results-container--ask .inline-agent__body > * {
  animation: agentContentReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out);
}

@keyframes agentWorkspaceReveal {
  from { transform: scale(.992); }
}

@keyframes agentContentReveal {
  from { opacity: 0; }
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
    // Keep the page dimmed, not hidden, when transparency effects are reduced.
    background: color-mix(in srgb, rgb(var(--v-theme-background)) 72%, transparent);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .search-results {
    background: Canvas;
    color: CanvasText;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .search-results-search { border: 1px solid CanvasText; }
  .search-results-item.highlighted::before { background: Highlight; }
  .search-results-suggestions .highlighted { border-inline-start-color: Highlight; }
}

@media (prefers-reduced-motion: reduce) {
  .search-results,
  .search-results-container--ask,
  .search-results-container--ask .inline-agent__toolbar > *,
  .search-results-container--ask .inline-agent__body > *,
  .search-results-item { animation: none; transition: none; }
}
</style>

<style scoped>
.search-results-capability-note { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem 1rem; padding: .8rem 1.25rem; border-bottom: 1px solid var(--wiki-surface-border); background: color-mix(in srgb, rgb(var(--v-theme-primary)) 6%, transparent); color: var(--wiki-text-muted); font-size: .78rem; }
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
.search-results-preview[aria-disabled='true'] { opacity: .6; cursor: default; }
.search-results-preview[aria-disabled='true']:hover { background: rgb(var(--v-theme-primary) / .08); }
@media (max-width: 480px) { .search-results-row .search-results-item { padding-inline-end: 3.5rem; } .search-results-preview { inset-inline-end: .5rem; } .search-results-preview span { display: none; } }
</style>

<style scoped>
.search-results-continuation { padding: 1rem; text-align: center; }
.search-results-continuation p { font-size: .8rem; color: var(--wiki-text-muted); margin: .6rem 0 0; }
</style>
