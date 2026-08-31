<template lang="pug">
  .search-results(
    v-if='isAgentOpen || searchIsFocused || normalizedSearch.length > 1'
    :class='{ "search-results--ask": isAgentOpen }'
    role='dialog'
    aria-modal='true'
    :aria-labelledby='isAgentOpen ? `wiki-agent-title` : `wiki-search-title`'
    :aria-busy='!isAgentOpen && searchIsLoading'
    tabindex='-1'
  )
    .search-results-container(:class='{ "search-results-container--ask": isAgentOpen }')
      h1#wiki-agent-title.sr-only(v-if='isAgentOpen') Wiki Agent workspace
      h1#wiki-search-title.sr-only(v-else) Wiki search
      .search-results-agent-nav(v-if='isAgentOpen')
        v-btn.search-results-agent-back(
          prepend-icon='mdi-arrow-left'
          variant='text'
          @click='returnToSearch'
        ) Search
        .search-results-agent-context
          .search-results-agent-mark
            v-icon(icon='mdi-auto-fix' size='17')
          span Agent workspace
        v-btn.search-results-agent-close(
          icon='mdi-close'
          variant='text'
          aria-label='Close Wiki Agent'
          @click='closeSearch'
        )
      .search-results-controls(v-else)
        v-btn-toggle.search-results-mode(
          v-if='canAsk'
          :model-value='searchMode'
          mandatory
          density='compact'
          color='primary'
          :aria-label='$t(`common:header.searchModeLabel`)'
        )
          v-btn(value='search' prepend-icon='mdi-magnify') {{$t('common:header.searchMode')}}
          v-btn(value='ask' prepend-icon='mdi-auto-fix' data-modal-focus-key='search-ask-mode' @click='openAsk') {{$t('common:header.askMode')}}
        .search-results-controls-title(v-else)
          v-icon(icon='mdi-magnify' size='19')
          span Search the Wiki
        v-chip.search-results-shortcut(
          variant='text'
          size='small'
          prepend-icon='mdi-keyboard-outline'
        ) Ctrl/⌘ + Shift + A
        v-btn.search-results-close(
          icon='mdi-close'
          variant='text'
          :aria-label='$t(`common:header.searchClose`)'
          @click='closeSearch'
        )
        .search-results-keyboard-hint(
          v-if='!isAgentOpen && normalizedSearch.length >= 2'
          aria-hidden='true'
          title='Keyboard shortcuts: navigate, open, close'
        )
          kbd ↑↓
          kbd ↵
          kbd Esc
      InlineAgentChat(
        v-if='isAgentOpen'
        ref='inlineAgent'
        :csrf-token='agentCsrfToken'
        :approval-id='approvalId'
        :provider-enabled='agentProviderEnabled'
        :skills-enabled='agentSkillsEnabled'
        :goals-enabled='agentGoalsEnabled'
        :page-id='currentPageId'
        :page-locale='currentPageLocale'
        :page-path='currentPagePath'
        :page-updated-at='currentPageUpdatedAt'
        @return-search='returnToSearch'
        @close='closeSearch'
      )
      .search-results-search(v-else)
        .search-results-instructions.sr-only#wiki-search-instructions Use Arrow Up and Down to move through results, Enter to open a result, and Escape to close search.
        .search-results-scope
          .search-results-scope-copy
            .search-results-eyebrow Search scope
            .search-results-scope-title Choose where direct matches come from
          .search-results-scope-actions(role='group' aria-label='Search scope')
            v-btn(
              size='small'
              prepend-icon='mdi-earth'
              :variant='!searchRestrictLocale && !searchRestrictPath ? `tonal` : `text`'
              :color='!searchRestrictLocale && !searchRestrictPath ? `primary` : undefined'
              :aria-pressed='!searchRestrictLocale && !searchRestrictPath'
              @click='clearSearchScope'
            ) All Wiki
            v-btn(
              v-if='currentPageLocale'
              size='small'
              prepend-icon='mdi-translate'
              :variant='searchRestrictLocale ? `tonal` : `text`'
              :color='searchRestrictLocale ? `primary` : undefined'
              :aria-pressed='searchRestrictLocale'
              @click='searchRestrictLocale = !searchRestrictLocale'
            ) {{ currentPageLocale.toLocaleUpperCase() }}
            v-btn(
              v-if='currentPagePath'
              size='small'
              prepend-icon='mdi-file-tree-outline'
              :variant='searchRestrictPath ? `tonal` : `text`'
              :color='searchRestrictPath ? `primary` : undefined'
              :aria-pressed='searchRestrictPath'
              @click='searchRestrictPath = !searchRestrictPath'
            ) This page tree
        .search-results-content
          .search-results-help(v-if='normalizedSearch.length < 2')
            .search-results-help-mark
              v-icon(icon='mdi-text-search' size='34')
            h2 Search your knowledge base
            p Type at least two characters to find pages by title, content, path, or tag.
          .search-results-loader(v-else-if='searchIsLoading')
            async-state(
              state='loading'
              :title='$t(`common:header.searchLoading`)'
              message='Searching the pages you can access.'
            )
          .search-results-none(v-else-if='searchError')
            async-state(
              state='error'
              title='Search is temporarily unavailable'
              :message='searchError'
              retry-label='Try again'
              @retry='retrySearch'
            )
          template(v-else)
            .search-results-summary(v-if='normalizedSearch.length >= 2')
              div(aria-live='polite')
                .search-results-eyebrow Direct matches
                .search-results-count(v-if='results.length')
                  span {{$t('common:header.searchResultsCount', { total: response.totalHits })}}
                  span.search-results-window(v-if='response.results.length < response.totalHits')  · Showing the top {{ response.results.length }}
              v-btn.search-results-ask(
                v-if='canAsk'
                color='primary'
                variant='tonal'
                prepend-icon='mdi-auto-fix'
                @click='askCurrentQuery'
                data-modal-focus-key='search-ask-query'
              ) Ask Wiki
            .search-results-none(v-if='normalizedSearch.length >= 2 && results.length < 1')
              async-state(
                state='empty'
                :title='$t(`common:header.searchNoResult`)'
                :message='canAsk ? `Ask Wiki for a grounded answer, or try a different term or scope.` : `Try a different term or broader scope.`'
              )
            template(v-if='results.length > 0')
              v-list.search-results-items(
                id='wiki-search-results'
                role='listbox'
                :aria-busy='searchIsLoading'
                aria-label='Search results'
                lines='three'
              )
                template(v-for='(item, idx) of results' :key='item.id')
                  v-list-item.search-results-item(
                    :id='`wiki-search-result-${item.id}`'
                    role='option'
                    :aria-selected='idx === cursor'
                    :href='pageHref(item)'
                    :class='idx === cursor ? `highlighted` : ``'
                    @click='closeSearch'
                  )
                    template(v-slot:prepend)
                      .search-results-item-mark
                        v-icon(icon='mdi-file-document-outline' size='21')
                    v-list-item-title {{ item.title }}
                    v-list-item-subtitle {{ item.description }}
                    .search-results-path
                      v-icon(icon='mdi-source-branch' size='14')
                      span {{ item.path }}
                    .search-results-tags(v-if='item.tags.length')
                      v-chip(
                        v-for='tag of item.tags.slice(0, 3)'
                        :key='tag'
                        size='x-small'
                        variant='tonal'
                      ) {{ tag }}
                      span.text-caption.text-medium-emphasis(v-if='item.tags.length > 3') +{{ item.tags.length - 3 }}
                    template(v-slot:append)
                      .search-results-item-meta
                        v-chip(size='x-small' label variant='outlined') {{ item.locale.toLocaleUpperCase() }}
                        v-icon.search-results-item-chevron(icon='mdi-chevron-right' size='19')
                  v-divider(v-if='idx < results.length - 1')
              v-pagination.search-results-pagination(
                v-if='paginationLength > 1'
                v-model='pagination'
                :length='paginationLength'
                density='comfortable'
                :total-visible='$vuetify.display.xs ? 3 : 7'
                rounded
              )
            .search-results-suggestion-block(v-if='suggestions.length')
              .search-results-eyebrow Suggested searches
              v-list.search-results-suggestions(
                id='wiki-search-suggestions'
                role='listbox'
                :aria-busy='searchIsLoading'
                aria-label='Search suggestions'
                density='compact'
              )
                template(v-for='(term, idx) of suggestions' :key='term')
                  v-list-item(
                    :id='`wiki-search-suggestion-${idx}`'
                    role='option'
                    :aria-selected='idx + results.length === cursor'
                    :class='idx + results.length === cursor ? `highlighted` : ``'
                    prepend-icon='mdi-magnify'
                    @click='setSearchTerm(term)'
                  )
                    v-list-item-title {{ term }}
                  v-divider(v-if='idx < suggestions.length - 1')
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import AsyncState from '@/components/common/async-state.vue'
import InlineAgentChat from '../agents/inline-agent-chat.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import { onSearchEnter, onSearchMove, offSearchEnter, offSearchMove } from '../../helpers/search-navigation-events'
import { searchPages, type PageSearchResult, type PageSearchRow } from '../../helpers/pages-api'
import { createModalFocusScope, type ModalFocusScope } from './modal-focus-scope'
import { navigateToWikiPage } from '../../helpers/wiki-navigation'

type InlineAgentChatRef = {
  focusComposer: () => Promise<void>
  sendPrompt: (prompt: string) => Promise<boolean>
  focusConversation: () => Promise<void>
}

const emptySearchResponse = (): PageSearchResult => ({
  results: [],
  suggestions: [],
  totalHits: 0
})


export default defineComponent({
  components: {
    AsyncState,
    InlineAgentChat
  },
  data() {
    return {
      cursor: 0,
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
      directPromptHandoffId: 0,
      directPromptHandoffPending: false
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
    searchRestrictPath: {
      get(): boolean { return wikiStore.site.searchRestrictPath },
      set(value: boolean) { wikiStore.site.searchRestrictPath = value }
    },
    results(): PageSearchRow[] {
      const currentIndex = (this.pagination - 1) * this.perPage
      return _.slice(this.response.results, currentIndex, currentIndex + this.perPage)
    },
    normalizedSearch(): string {
      return this.search.trim()
    },
    suggestions(): string[] {
      return this.response.suggestions ? this.response.suggestions : []
    },
    canAsk(): boolean {
      return siteConfig.agentsEnabled && wikiStore.user.authenticated && wikiStore.user.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')
    },
    isAgentOpen(): boolean {
      return this.canAsk && this.searchMode === 'ask'
    },
    agentCsrfToken(): string { return siteConfig.agentCsrfToken },
    agentProviderEnabled(): boolean { return siteConfig.agentProviderEnabled },
    agentSkillsEnabled(): boolean { return siteConfig.agentSkillsEnabled },
    agentGoalsEnabled(): boolean { return siteConfig.agentGoalsEnabled },
    currentPageId(): number { return wikiStore.page.id },
    currentPageLocale(): string { return wikiStore.page.locale },
    currentPagePath(): string { return wikiStore.page.path },
    currentPageUpdatedAt(): string { return wikiStore.page.updatedAt },
    searchRequestKey(): string {
      return JSON.stringify([
        this.normalizedSearch,
        this.searchRestrictLocale ? wikiStore.page.locale : '',
        this.searchRestrictPath ? wikiStore.page.path : ''
      ])
    },
    hasFreshResponse(): boolean {
      return this.responseKey === this.searchRequestKey && this.normalizedSearch.length >= 2
    },
    activeDescendant(): string | undefined {
      if (!this.hasFreshResponse || this.cursor < 0) return undefined
      if (this.cursor < this.results.length) return `wiki-search-result-${this.results[this.cursor]?.id}`
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
      this.queueSearch(query)
    },
    searchMode(mode: 'search' | 'ask') {
      if (mode === 'search') {
        if (!this.hasFreshResponse) this.queueSearch(this.search)
        return
      }
      this.searchRequestId += 1
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      this.searchIsLoading = false
    },
    isAgentOpen(open: boolean) {
      if (open) {
        void this.activateAgentModal()
        return
      }
      if (this.directPromptHandoffPending) this.directPromptHandoffId += 1
      if (this.searchIsFocused) void this.reactivateSearchModal()
      else this.deactivateAgentModal(false)
    },
    searchIsFocused(open: boolean) {
      if (open) void this.activateAgentModal()
      else this.deactivateModalLayers(true)
    },
    canAsk(allowed: boolean) {
      if (!allowed && this.searchMode === 'ask') this.searchMode = 'search'
    },
    searchRestrictLocale() {
      this.queueSearch(this.search)
    },
    searchRestrictPath() {
      this.queueSearch(this.search)
    },
    results() {
      this.cursor = 0
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
    if (this.searchMode === 'search' && this.normalizedSearch.length >= 2) {
      this.searchIsFocused = true
      this.queueSearch(this.search)
    }
    onSearchMove(this.handleSearchMove)
    onSearchEnter(this.handleSearchEnter)
    void this.$nextTick(this.syncSearchInputA11y)
    if (this.searchIsFocused) void this.activateAgentModal()
  },
  beforeUnmount() {
    this.searchRequestId += 1
    this.directPromptHandoffId += 1
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    this.searchTimer = null
    this.searchIsLoading = false
    offSearchMove(this.handleSearchMove)
    offSearchEnter(this.handleSearchEnter)
    this.deactivateModalLayers(false)
  },
  methods: {
    async activateAgentModal(): Promise<void> {
      const opener = this.pendingAskRestoreTarget ?? this.activeModalOpener() ?? this.findSearchControl()
      await this.$nextTick()
      if (!this.searchIsFocused && !this.isAgentOpen) return
      this.activateSearchModal(opener ?? this.findSearchControl())
      if (!this.isAgentOpen || this.modalFocusScope) return
      const root = this.$el
      if (!(root instanceof HTMLElement)) return
      const focusScope = createModalFocusScope({
        root,
        restoreTarget: this.restoreTargetFor(opener),
        onEscape: this.returnToSearch
      })
      this.pendingAskRestoreTarget = null
      this.modalFocusScope = focusScope
      await (this.$refs.inlineAgent as InlineAgentChatRef | undefined)?.focusComposer()
      if (this.modalFocusScope === focusScope && !focusScope.containsFocus()) focusScope.focusFirst()
    },
    activateSearchModal(restoreTarget: HTMLElement | null): void {
      if (this.searchModalFocusScope) return
      const root = this.$el
      if (!(root instanceof HTMLElement)) return
      this.searchModalFocusScope = createModalFocusScope({
        root,
        restoreTarget: this.restoreTargetFor(restoreTarget),
        additionalRoots: () => this.syncSearchInputA11y(),
        onEscape: this.closeSearch
      })
    },
    async reactivateSearchModal(): Promise<void> {
      await this.$nextTick()
      if (this.isAgentOpen || !this.searchIsFocused) return
      this.deactivateAgentModal(true)
      this.activateSearchModal(this.findSearchControl())
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
    activeModalOpener(): HTMLElement | null {
      const active = document.activeElement
      return active instanceof HTMLElement && active !== document.body && active.tabIndex >= 0 ? active : null
    },
    restoreTargetFor(target: HTMLElement | null): () => HTMLElement | null {
      const key = target?.dataset.modalFocusKey
      return () => {
        if (target?.isConnected && target.tabIndex >= 0 && !target.matches(':disabled')) return target
        if (key) {
          const replacement = document.querySelector<HTMLElement>(`[data-modal-focus-key="${key}"]`)
          if (replacement && replacement.tabIndex >= 0 && !replacement.matches(':disabled')) return replacement
        }
        return this.findSearchControl()
      }
    },
    findSearchControls(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>('.nav-header-search-control input'))
        .filter(control => !control.matches(':disabled'))
    },
    findSearchControl(): HTMLElement | null {
      return this.findSearchControls().find(control => control.getClientRects().length > 0) ?? null
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
    openAsk(): void {
      if (!this.canAsk) return
      this.directPromptHandoffId += 1
      this.pendingAskRestoreTarget = this.activeModalOpener()
      this.searchIsFocused = true
      this.searchMode = 'ask'
    },
    returnToSearch(): void {
      this.pendingAskRestoreTarget = null
      this.directPromptHandoffId += 1
      this.searchMode = 'search'
      this.searchIsFocused = true
    },
    queueSearch(query: string): void {
      this.cursor = -1
      this.searchRequestId += 1
      const requestId = this.searchRequestId
      const normalizedQuery = query.trim()
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      if (this.searchMode !== 'search') {
        this.searchIsLoading = false
        return
      }
      if (normalizedQuery.length < 2) {
        this.searchError = ''
        this.responseKey = ''
        this.response = emptySearchResponse()
        this.pagination = 1
        this.searchIsLoading = false
        return
      }
      const requestKey = this.searchRequestKey
      if (this.responseKey === requestKey && !this.searchError) {
        this.searchIsLoading = false
        return
      }
      this.searchError = ''
      this.responseKey = ''
      this.response = emptySearchResponse()
      this.pagination = 1
      this.searchIsLoading = true
      this.searchTimer = window.setTimeout(() => this.runSearch(normalizedQuery, requestKey, requestId), 300)
    },
    handleSearchMove(dir: string): void {
      if (this.searchMode === 'ask' || this.searchIsLoading || !this.hasFreshResponse) return
      const lastIndex = this.results.length + this.suggestions.length - 1
      if (lastIndex < 0) {
        this.cursor = -1
        return
      }
      this.cursor = Math.min(Math.max(this.cursor + (dir === 'up' ? -1 : 1), 0), lastIndex)
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
        const result = _.nth(this.results, this.cursor)
        if (result) this.navigateToPage(result)
      } else if (this.cursor >= this.results.length && this.cursor < this.results.length + this.suggestions.length) {
        this.setSearchTerm(_.nth(this.suggestions, this.cursor - this.results.length))
      }
    },
    async submitAskPrompt(): Promise<void> {
      if (!this.canAsk || this.searchMode !== 'ask') return
      await this.sendAskPrompt(this.normalizedSearch)
    },
    async askCurrentQuery(): Promise<void> {
      if (!this.canAsk || this.normalizedSearch.length < 2 || this.directPromptHandoffPending) return
      const prompt = this.normalizedSearch
      this.pendingAskRestoreTarget = this.activeModalOpener()
      this.searchMode = 'ask'
      await this.sendAskPrompt(prompt)
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
      this.directPromptHandoffId += 1
      this.pendingAskRestoreTarget = null
      this.deactivateModalLayers(true)
      this.searchIsFocused = false
      this.searchMode = 'search'
      this.search = ''
      this.approvalId = ''
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
    pageHref(item: PageSearchRow): string {
      const visibilityScope = item.visibility === 'private' ? '/_private' : ''
      return `${visibilityScope}/${item.locale}/${item.path}`
    },
    navigateToPage(item: PageSearchRow): void {
      navigateToWikiPage(this.pageHref(item))
    },
    retrySearch(): void {
      const query = this.normalizedSearch
      if (query.length < 2) return
      this.searchRequestId += 1
      this.searchError = ''
      this.responseKey = ''
      this.response = emptySearchResponse()
      this.cursor = -1
      this.pagination = 1
      this.searchIsLoading = true
      void this.runSearch(query, this.searchRequestKey, this.searchRequestId)
    },
    async runSearch(query: string, requestKey: string, requestId: number): Promise<void> {
      try {
        const response = await searchPages(window.fetch.bind(window), query, {
          locale: this.searchRestrictLocale ? wikiStore.page.locale : undefined,
          path: this.searchRestrictPath ? wikiStore.page.path : undefined
        })
        if (requestId !== this.searchRequestId) return
        this.response = response
        this.responseKey = requestKey
        this.pagination = 1
      } catch (err) {
        if (requestId !== this.searchRequestId) return
        this.searchError = getErrorMessage(err)
        this.responseKey = ''
        this.response = emptySearchResponse()
      } finally {
        if (requestId === this.searchRequestId) this.searchIsLoading = false
      }
    }
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
  animation: searchResultsReveal var(--wiki-motion-normal) var(--wiki-motion-ease-out);
  background:
    radial-gradient(ellipse 52rem 28rem at 50% -10rem, color-mix(in srgb, var(--wiki-ambient-accent) 20%, transparent), transparent),
    color-mix(in srgb, rgb(var(--v-theme-background)) 92%, transparent);
  box-sizing: border-box;
  height: 100dvh;
  inset: 0;
  &:not(.search-results--ask) {
    padding-top: var(--v-layout-top, 72px);
  }
  overflow-x: hidden;
  overflow-y: auto;
  position: fixed;
  text-align: center;
  width: 100%;
  z-index: 1006;


  &--ask {
    animation: none;
    background:
      radial-gradient(ellipse 68rem 34rem at 50% -16rem, color-mix(in srgb, var(--wiki-ambient-accent) 30%, transparent), transparent),
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--wiki-ambient-accent) 5%, rgb(var(--v-theme-background))),
        rgb(var(--v-theme-background))
      );
    overflow: hidden;
    isolation: isolate;
    z-index: 1009;
  }

  &-container {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 68rem;
    padding: 0 clamp(var(--wiki-space-3), 2vw, var(--wiki-space-6)) clamp(var(--wiki-space-4), 3vw, var(--wiki-space-8));
    width: 100%;

    &--ask {
      animation: agentWorkspaceReveal var(--wiki-motion-slow) var(--wiki-motion-ease-out);
      align-items: center;
      display: flex;
      flex-direction: column;
      height: 100%;
      max-width: none;
      padding: 0 clamp(var(--wiki-space-3), 2vw, var(--wiki-space-6));
    }
  }

  &-agent-nav {
    align-items: center;
    box-sizing: border-box;
    color: var(--search-overlay-ink);
    display: grid;
    flex: 0 0 auto;
    grid-template-columns: 1fr auto 1fr;
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-8) + max(0px, env(safe-area-inset-top)));
    padding-block-start: max(0px, env(safe-area-inset-top));
    width: min(72rem, 100%);
  }

  &-agent-back {
    justify-self: start;
    letter-spacing: 0;
    text-transform: none;
  }

  &-agent-context {
    align-items: center;
    display: flex;
    gap: var(--wiki-space-2);
    color: color-mix(in srgb, currentColor 80%, transparent);
    font-size: var(--wiki-label-size);
    font-weight: var(--wiki-label-weight);
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  &-agent-mark {
    align-items: center;
    display: flex;
    width: var(--wiki-space-8);
    height: var(--wiki-space-8);
    justify-content: center;
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    border-radius: var(--wiki-control-radius);
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  &-agent-close { justify-self: end; }

  &-controls {
    position: relative;
    display: flex;
    width: min(64rem, 100%);
    min-height: calc(var(--wiki-control-height) + var(--wiki-space-5));
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    padding: var(--wiki-space-1) calc(var(--wiki-control-height) + var(--wiki-space-2));
    color: var(--search-overlay-ink);
  }

  &-controls-title {
    align-items: center;
    display: flex;
    font-size: .82rem;
    font-weight: 650;
    gap: .45rem;
    letter-spacing: .04em;
  }

  &-mode {
    max-width: 100%;
    margin: 0;
  }

  &-close {
    position: absolute !important;
    inset-inline-end: var(--wiki-space-1);
  }

  &-keyboard-hint {
    position: absolute;
    inset-inline-end: calc(var(--wiki-control-height) + var(--wiki-space-3));
    display: inline-flex;
    align-items: center;
    gap: var(--wiki-space-1);
    color: color-mix(in srgb, currentColor 76%, transparent);

    kbd {
      min-width: calc(var(--wiki-space-6) + var(--wiki-space-1));
      padding: var(--wiki-space-1) var(--wiki-space-2);
      border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
      border-radius: var(--wiki-radius-xs);
      background: color-mix(in srgb, currentColor 8%, transparent);
      box-shadow: var(--wiki-shadow-inset);
      font-family: var(--wiki-font-mono);
      font-size: var(--wiki-label-size);
      font-weight: var(--wiki-label-weight);
      line-height: 1.25;
      text-align: center;
    }

    @media #{map-get($display-breakpoints, 'md-and-down')} {
      display: none;
    }
  }

  &-shortcut {
    position: absolute !important;
    inset-inline-start: var(--wiki-space-1);

    @media #{map-get($display-breakpoints, 'md-and-down')} {
      display: none !important;
    }
  }

  &-search {
    margin-inline: auto;
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
    align-items: center;
    justify-content: space-between;
    gap: var(--wiki-space-5);
    padding: var(--wiki-space-4) var(--wiki-space-5);
    border-bottom: 1px solid var(--wiki-surface-border);
    background:
      radial-gradient(circle at 100% 0, color-mix(in srgb, var(--wiki-ambient-accent) 14%, transparent), transparent 42%),
      var(--wiki-surface-sunken);
  }

  &-scope-copy { min-width: 12rem; }
  &-scope-title { font-size: .9rem; font-weight: 550; margin-top: .12rem; }

  &-scope-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .35rem;
    justify-content: flex-end;
  }

  &-eyebrow {
    color: rgb(var(--v-theme-primary));
    font-size: .68rem;
    font-weight: 750;
    letter-spacing: .11em;
    line-height: 1.3;
    text-transform: uppercase;
  }

  &-content {
    min-width: 0;
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
    overflow-wrap: anywhere;
    line-height: 1.4;
    white-space: normal;
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
    max-width: 112rem;
    min-height: 0;
    padding: 0;
  }

  &--ask .inline-agent__card {
    height: 100%;
    min-height: 0;
  }

  @media #{map-get($display-breakpoints, 'sm-and-down')} {
    &:not(.search-results--ask) {
      --search-mobile-app-bar-extension-height: 48px;
      padding-top: calc(var(--v-layout-top, 72px) + var(--search-mobile-app-bar-extension-height));
    }
    &-container { padding-inline: var(--wiki-space-2); }
    &-container--ask { padding: 0 var(--wiki-space-2); }
    &-agent-nav { min-height: calc(var(--wiki-control-height) + var(--wiki-space-6) + max(0px, env(safe-area-inset-top))); padding-inline: var(--wiki-space-2); }
    &-scope { align-items: flex-start; flex-direction: column; gap: var(--wiki-space-3); }
    &-scope-actions { justify-content: flex-start; }
    &-content { padding: var(--wiki-space-3); }
  }
  @media (max-width: 639.98px) {
    &--ask .search-results-agent-nav { display: none; }
  }

  @media (max-width: 599.98px) {
    &-search { border-radius: var(--wiki-panel-radius); }
    &-scope-copy { min-width: 0; }
    &-scope-actions .v-btn { max-width: 100%; padding-inline: var(--wiki-space-3); }
    &-summary { align-items: flex-start; flex-wrap: wrap; }
    &-mode .v-btn { min-width: 0; padding-inline: var(--wiki-space-2); }
    &-mode .v-btn__content { overflow: hidden; text-overflow: ellipsis; }
    &-ask .v-btn__content { font-size: .78rem; }
    &-item { padding-inline: var(--wiki-space-1); }
    &-item-chevron { display: none; }
    &-item-mark { height: var(--wiki-control-height); width: var(--wiki-control-height); }
    &-agent-context span { display: none; }
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

@media (forced-colors: active) {
  .search-results-search { border: 1px solid CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  .search-results,
  .search-results-container--ask,
  .search-results-item { animation: none; transition: none; }
}
</style>
