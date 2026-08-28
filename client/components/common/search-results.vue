<template lang="pug">
  .search-results(
    v-if='isAgentOpen || searchIsFocused || normalizedSearch.length > 1'
    :class='{ "search-results--ask": isAgentOpen }'
    :role='isAgentOpen ? `dialog` : `region`'
    :aria-label='isAgentOpen ? `Wiki Agent workspace` : `Wiki search`'
    :aria-modal='isAgentOpen ? `true` : undefined'
  )
    .search-results-container(:class='{ "search-results-container--ask": isAgentOpen }')
      .search-results-agent-nav(v-if='isAgentOpen')
        v-btn.search-results-agent-back(
          prepend-icon='mdi-arrow-left'
          variant='text'
          color='white'
          @click='returnToSearch'
        ) Search
        .search-results-agent-context
          .search-results-agent-mark
            v-icon(icon='mdi-auto-fix' size='17')
          span Agent workspace
        v-btn.search-results-agent-close(
          icon='mdi-close'
          variant='text'
          color='white'
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
          v-btn(value='ask' prepend-icon='mdi-auto-fix' @click='openAsk') {{$t('common:header.askMode')}}
        .search-results-controls-title(v-else)
          v-icon(icon='mdi-magnify' size='19')
          span Search the Wiki
        v-chip.search-results-shortcut(
          v-if='canAsk'
          color='white'
          variant='text'
          size='small'
          prepend-icon='mdi-keyboard-outline'
        ) Ctrl/⌘ + Shift + A
        v-btn.search-results-close(
          icon='mdi-close'
          variant='text'
          color='white'
          :aria-label='$t(`common:header.searchClose`)'
          @click='closeSearch'
        )
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
      )
      .search-results-search(v-else)
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
          .search-results-loader(v-else-if='searchIsLoading && results.length < 1')
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
                .search-results-count(v-else) No direct matches for “{{ normalizedSearch }}”
              v-btn.search-results-ask(
                v-if='canAsk'
                color='primary'
                variant='tonal'
                prepend-icon='mdi-auto-fix'
                @click='askCurrentQuery'
              ) Ask Wiki
            .search-results-none(v-if='normalizedSearch.length >= 2 && results.length < 1')
              async-state(
                state='empty'
                :title='$t(`common:header.searchNoResult`)'
                :message='canAsk ? `Ask Wiki for a grounded answer, or try a different term or scope.` : `Try a different term or broader scope.`'
              )
            template(v-if='results.length > 0')
              v-list.search-results-items(lines='three')
                template(v-for='(item, idx) of results' :key='item.id')
                  v-list-item.search-results-item(
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
                rounded
              )
            .search-results-suggestion-block(v-if='suggestions.length > 0')
              .search-results-eyebrow {{$t('common:header.searchDidYouMean')}}
              v-list.search-results-suggestions(density='compact')
                template(v-for='(term, idx) of suggestions' :key='term')
                  v-list-item(
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

const emptySearchResponse = (): PageSearchResult => ({
  results: [],
  suggestions: [],
  totalHits: 0
})
interface InlineAgentChatRef {
  sendPrompt(content: string): Promise<boolean>
  focusComposer(): Promise<void>
  focusConversation(): Promise<void>
}


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
      response: emptySearchResponse()
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
    paginationLength(): number {
      return this.response.results.length > 0 ? Math.ceil(this.response.results.length / this.perPage) : 0
    }
  },
  watch: {
    search(newValue: string | null) {
      this.queueSearch(newValue ?? '')
    },
    async searchMode(newMode: 'search' | 'ask') {
      this.queueSearch(this.search)
      if (newMode !== 'ask' || !this.canAsk) return
      this.searchIsFocused = true
      await this.$nextTick()
      await (this.$refs.inlineAgent as InlineAgentChatRef | undefined)?.focusComposer()
    },
    searchRestrictLocale() {
      this.queueSearch(this.search)
    },
    searchRestrictPath() {
      this.queueSearch(this.search)
    },
    results() {
      this.cursor = 0
    }
  },
  mounted() {
    const approvalId = new URL(window.location.href).searchParams.get('agentApproval')
    if (approvalId && /^[0-9a-f-]{36}$/i.test(approvalId) && this.canAsk) {
      this.approvalId = approvalId
      this.searchMode = 'ask'
      this.searchIsFocused = true
    }
    onSearchMove(this.handleSearchMove)
    onSearchEnter(this.handleSearchEnter)
  },
  beforeUnmount() {
    this.searchRequestId += 1
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    offSearchMove(this.handleSearchMove)
    offSearchEnter(this.handleSearchEnter)
  },
  methods: {
    openAsk(): void {
      if (!this.canAsk) return
      this.searchIsFocused = true
      this.searchMode = 'ask'
    },
    returnToSearch(): void {
      this.searchMode = 'search'
      this.searchIsFocused = true
    },
    queueSearch(query: string): void {
      this.cursor = 0
      this.searchRequestId += 1
      const requestId = this.searchRequestId
      const normalizedQuery = query.trim()
      this.searchError = ''
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      if (this.searchMode !== 'search' || normalizedQuery.length < 2) {
        this.searchIsLoading = false
        this.response = emptySearchResponse()
        return
      }
      this.searchIsLoading = true
      this.searchTimer = window.setTimeout(() => this.runSearch(normalizedQuery, requestId), 300)
    },
    handleSearchMove(dir: string): void {
      if (this.searchMode === 'ask') return
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
      if (!this.canAsk || this.normalizedSearch.length < 2) return
      const prompt = this.normalizedSearch
      this.searchMode = 'ask'
      await this.sendAskPrompt(prompt)
    },
    async sendAskPrompt(prompt: string): Promise<void> {
      if (!prompt) return
      await this.$nextTick()
      const inlineAgent = this.$refs.inlineAgent as InlineAgentChatRef | undefined
      if (!inlineAgent) return
      if (await inlineAgent.sendPrompt(prompt)) {
        this.search = ''
        await this.$nextTick()
        await inlineAgent.focusConversation()
      }
    },
    closeSearch(): void {
      this.search = ''
      this.searchMode = 'search'
      this.searchIsFocused = false
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
      if (term !== undefined) this.search = term
    },
    pageHref(item: PageSearchRow): string {
      const visibilityScope = item.visibility === 'private' ? '/_private' : ''
      return `${visibilityScope}/${item.locale}/${item.path}`
    },
    navigateToPage(item: PageSearchRow): void {
      window.location.assign(this.pageHref(item))
    },
    retrySearch(): void {
      const query = this.normalizedSearch
      if (query.length < 2) return
      this.searchRequestId += 1
      this.searchError = ''
      this.searchIsLoading = true
      void this.runSearch(query, this.searchRequestId)
    },
    async runSearch(query: string, requestId: number): Promise<void> {
      try {
        const response = await searchPages(window.fetch.bind(window), query, {
          locale: this.searchRestrictLocale ? wikiStore.page.locale : undefined,
          path: this.searchRestrictPath ? wikiStore.page.path : undefined
        })
        if (requestId !== this.searchRequestId) return
        this.response = response
        this.pagination = 1
      } catch (err) {
        if (requestId !== this.searchRequestId) return
        this.searchError = getErrorMessage(err)
        this.response = emptySearchResponse()
      } finally {
        if (requestId === this.searchRequestId) this.searchIsLoading = false
      }
    }
  }
})
</script>

<style lang="scss">
.search-results {
  animation: searchResultsReveal .2s ease-out;
  background:
    radial-gradient(ellipse 52rem 28rem at 50% -10rem, rgba(82, 113, 255, .2), transparent),
    rgba(8, 10, 17, .92);
  box-sizing: border-box;
  height: calc(100dvh - var(--v-layout-top, 72px));
  inset: var(--v-layout-top, 72px) 0 0;
  overflow-y: auto;
  position: fixed;
  text-align: center;
  width: 100%;
  z-index: 1006;


  &--ask {
    animation: agentWorkspaceReveal .28s cubic-bezier(.2, .8, .2, 1);
    background:
      radial-gradient(ellipse 68rem 34rem at 50% -16rem, rgba(82, 113, 255, .3), transparent),
      linear-gradient(180deg, rgba(7, 9, 17, .98), rgba(8, 10, 17, .96));
    height: 100dvh;
    inset: 0;
    overflow: hidden;
    z-index: 1009;
  }

  &-container {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 68rem;
    padding: 0 clamp(.75rem, 2vw, 1.5rem) clamp(1rem, 3vw, 2rem);
    width: 100%;

    &--ask {
      align-items: center;
      display: flex;
      flex-direction: column;
      height: 100%;
      max-width: none;
      padding: 0 clamp(.75rem, 2vw, 1.5rem) clamp(.75rem, 2vw, 1.5rem);
    }
  }

  &-agent-nav {
    align-items: center;
    color: #fff;
    display: grid;
    flex: 0 0 auto;
    grid-template-columns: 1fr auto 1fr;
    min-height: 4.75rem;
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
    font-size: .74rem;
    font-weight: 700;
    gap: .55rem;
    letter-spacing: .08em;
    opacity: .8;
    text-transform: uppercase;
  }

  &-agent-mark {
    align-items: center;
    background: rgba(255, 255, 255, .08);
    border: 1px solid rgba(255, 255, 255, .13);
    border-radius: .65rem;
    display: flex;
    height: 2rem;
    justify-content: center;
    width: 2rem;
  }

  &-agent-close { justify-self: end; }

  &-controls {
    align-items: center;
    color: #fff;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
    min-height: 4rem;
    padding: .4rem 0;
    position: relative;
    width: min(64rem, 100%);
  }

  &-controls-title {
    align-items: center;
    display: flex;
    font-size: .82rem;
    font-weight: 650;
    gap: .45rem;
    letter-spacing: .04em;
  }

  &-mode { margin: 0; }

  &-close {
    position: absolute !important;
    right: clamp(.25rem, 1.5vw, 1rem);
  }

  &-shortcut {
    left: clamp(.25rem, 1.5vw, 1rem);
    position: absolute !important;

    @media #{map-get($display-breakpoints, 'sm-and-down')} {
      display: none !important;
    }
  }

  &-search {
    background: color-mix(in srgb, rgb(var(--v-theme-surface)) 98%, rgb(var(--v-theme-background)));
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 16%, transparent);
    border-radius: 1.5rem;
    box-shadow: 0 1.25rem 4rem rgba(0, 0, 0, .28);
    color: rgb(var(--v-theme-on-surface));
    margin-inline: auto;
    overflow: hidden;
    text-align: start;
  }

  &-scope {
    align-items: center;
    background:
      radial-gradient(circle at 100% 0, color-mix(in srgb, rgb(var(--v-theme-primary)) 14%, transparent), transparent 42%),
      color-mix(in srgb, rgb(var(--v-theme-surface-variant)) 35%, rgb(var(--v-theme-surface)));
    border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 11%, transparent);
    display: flex;
    gap: 1.25rem;
    justify-content: space-between;
    padding: 1rem 1.2rem;
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

  &-content { padding: 1rem; }

  &-summary {
    align-items: center;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    min-height: 3.25rem;
    padding: 0 .25rem .8rem;
  }

  &-count { font-size: .95rem; font-weight: 600; margin-top: .2rem; }
  &-window {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 58%, transparent);
    font-size: .78rem;
    font-weight: 450;
  }
  &-ask { flex: 0 0 auto; letter-spacing: 0; text-transform: none; }

  &-help,
  &-loader,
  &-none {
    align-items: center;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 19rem;
    padding: 2.5rem 1rem;
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
    background: transparent;
    border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent);
    border-radius: 1rem;
    overflow: hidden;
    padding: 0;
    text-align: start;
  }

  &-item {
    min-height: 5.65rem;
    padding-block: .55rem;
    transition: background-color .14s ease;

    &:hover,
    &.highlighted {
      background: color-mix(in srgb, rgb(var(--v-theme-primary)) 10%, rgb(var(--v-theme-surface)));
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

  &-item :deep(.v-list-item-title) { font-size: .98rem; font-weight: 650; }
  &-item :deep(.v-list-item-subtitle) { line-height: 1.4; margin-top: .14rem; white-space: normal; }

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
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .3rem;
    margin-top: .4rem;
  }

  &-item-meta {
    align-items: center;
    display: flex;
    gap: .3rem;
  }

  &-item-chevron { color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 44%, transparent); }

  &-pagination { margin: .85rem 0 .2rem; }

  &-suggestion-block {
    border-top: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
    margin-top: 1rem;
    padding: 1rem .25rem .1rem;
  }

  &-suggestions { margin-top: .55rem; }

  &-suggestions .highlighted {
    background: color-mix(in srgb, rgb(var(--v-theme-primary)) 12%, rgb(var(--v-theme-surface)));
  }

  &--ask .inline-agent {
    box-sizing: border-box;
    flex: 1 1 auto;
    max-width: 72rem;
    min-height: 0;
    padding: 0;
  }

  &--ask .inline-agent__card {
    height: 100%;
    min-height: 0;
  }

  @media #{map-get($display-breakpoints, 'sm-and-down')} {
    &:not(.search-results--ask) {
      height: auto;
      top: calc(var(--v-layout-top, 72px) + 48px);
    }
    &-container { padding-inline: .5rem; }
    &-container--ask { padding: 0; }
    &-agent-nav { min-height: 4.25rem; padding-inline: .5rem; }
    &-scope { align-items: flex-start; flex-direction: column; gap: .75rem; }
    &-scope-actions { justify-content: flex-start; }
    &-content { padding: .75rem; }
  }

  @media (max-width: 599.98px) {
    &-search { border-radius: 1.15rem; }
    &-scope-copy { min-width: 0; }
    &-scope-actions :deep(.v-btn) { padding-inline: .65rem; }
    &-summary { align-items: flex-start; }
    &-ask :deep(.v-btn__content) { font-size: .78rem; }
    &-item { padding-inline: .2rem; }
    &-item-chevron { display: none; }
    &-item-mark { height: 2.35rem; width: 2.35rem; }
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
  .search-results-item { animation: none; transition: none; }
}
</style>
