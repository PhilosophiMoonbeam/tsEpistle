<template lang="pug">
  .search-results(v-if='searchIsFocused || (search && search.length > 1)' :class='canAsk && searchMode === `ask` ? `search-results--ask` : ``' role='region' aria-label='Wiki search and agent')
    .search-results-container(:class='canAsk && searchMode === `ask` ? `search-results-container--ask` : ``')
      .search-results-controls
        v-btn-toggle.search-results-mode(
          v-if='canAsk'
          v-model='searchMode'
          mandatory
          density='compact'
          color='primary'
          :aria-label='$t(`common:header.searchModeLabel`)'
        )
          v-btn(value='search' prepend-icon='mdi-magnify') {{$t('common:header.searchMode')}}
          v-btn(value='ask' prepend-icon='mdi-auto-fix') {{$t('common:header.askMode')}}
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
        v-if='canAsk && searchMode === `ask`'
        ref='inlineAgent'
        :csrf-token='agentCsrfToken'
        :approval-id='approvalId'
        :provider-enabled='agentProviderEnabled'
        :skills-enabled='agentSkillsEnabled'
        :page-id='currentPageId'
        :page-locale='currentPageLocale'
        :page-path='currentPagePath'
        :page-updated-at='currentPageUpdatedAt'
      )
      template(v-else)
        .search-results-help(v-if='!search || (search && search.length < 2)')
          img(src='/_assets/svg/icon-search-alt.svg')
          .mt-4 {{$t('common:header.searchHint')}}
        .search-results-loader(v-else-if='searchIsLoading && (!results || results.length < 1)')
          async-state(
            state='loading'
            :title='$t(`common:header.searchLoading`)'
            message='Searching visible pages.'
          )
        .search-results-none(v-else-if='searchError')
          async-state(
            state='error'
            title='Search is temporarily unavailable'
            :message='searchError'
            retry-label='Try again'
            @retry='retrySearch'
          )
        .search-results-none(v-else-if='!results || results.length < 1')
          async-state(
            state='empty'
            :title='$t(`common:header.searchNoResult`)'
            message='Try a different term or broader scope.'
          )
        template(v-if='search && search.length >= 2 && results && results.length > 0')
          v-list-subheader.text-white {{$t('common:header.searchResultsCount', { total: response.totalHits })}}
          v-list.search-results-items.radius-7.py-0(lines='two' density='compact')
            template(v-for='(item, idx) of results' :key='item.id')
              v-list-item(
                :class='idx === cursor ? `highlighted` : ``'
                @click='goToPage(item)'
                @click.middle='goToPageInNewTab(item)'
              )
                template(v-slot:prepend)
                  v-avatar(rounded='0')
                    img(src='/_assets/svg/icon-selective-highlighting.svg')
                v-list-item-title {{ item.title }}
                v-list-item-subtitle.text-body-small {{ item.description }}
                .text-body-small.text-grey(v-text='item.path')
                .search-results-tags(v-if='item.tags.length')
                  v-chip(
                    v-for='tag of item.tags.slice(0, 3)'
                    :key='tag'
                    size='x-small'
                    variant='tonal'
                    color='blue-grey-lighten-2'
                  ) {{ tag }}
                  span.text-caption.text-medium-emphasis(v-if='item.tags.length > 3') +{{ item.tags.length - 3 }}
                template(v-slot:append)
                  v-chip(label variant='outlined') {{item.locale.toUpperCase()}}
              v-divider(v-if='idx < results.length - 1')
          v-pagination.mt-3(
            v-if='paginationLength > 1'
            v-model='pagination'
            :length='paginationLength'
            rounded
          )
        template(v-if='suggestions && suggestions.length > 0')
          v-list-subheader.text-white.mt-3 {{$t('common:header.searchDidYouMean')}}
          v-list.search-results-suggestions.radius-7(density='compact')
            template(v-for='(term, idx) of suggestions' :key='term')
              v-list-item(
                :class='idx + results.length === cursor ? `highlighted` : ``'
                @click='setSearchTerm(term)'
              )
                template(v-slot:prepend)
                  v-avatar
                    v-icon mdi-magnify
                v-list-item-title {{ term }}
              v-divider(v-if='idx < suggestions.length - 1')
        .text-center.pt-5(v-if='search && search.length > 1')
          v-btn.mx-2(variant='outlined' color='pink' @click='closeSearch')
            v-icon(start) mdi-close
            span {{$t('common:header.searchClose')}}
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
      return this.response.results ? _.slice(this.response.results, currentIndex, currentIndex + this.perPage) : []
    },
    hits() {
      return this.response.totalHits ? this.response.totalHits : 0
    },
    suggestions(): string[] {
      return this.response.suggestions ? this.response.suggestions : []
    },
    canAsk(): boolean {
      return siteConfig.agentsEnabled && wikiStore.user.authenticated && wikiStore.user.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')
    },
    agentCsrfToken(): string { return siteConfig.agentCsrfToken },
    agentProviderEnabled(): boolean { return siteConfig.agentProviderEnabled },
    agentSkillsEnabled(): boolean { return siteConfig.agentSkillsEnabled },
    currentPageId(): number { return wikiStore.page.id },
    currentPageLocale(): string { return wikiStore.page.locale },
    currentPagePath(): string { return wikiStore.page.path },
    currentPageUpdatedAt(): string { return wikiStore.page.updatedAt },
    paginationLength() {
      return (this.response.totalHits > 0) ? Math.ceil(this.response.totalHits / this.perPage) : 0
    }
  },
  watch: {
    search(newValue: string | null) {
      this.queueSearch(newValue ?? '')
    },
    searchMode() {
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
    queueSearch(query: string): void {
      this.cursor = 0
      this.searchRequestId += 1
      const requestId = this.searchRequestId
      this.searchError = ''
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = null
      if (this.searchMode !== 'search' || query.length < 2) {
        this.searchIsLoading = false
        this.response = emptySearchResponse()
        return
      }
      this.searchIsLoading = true
      this.searchTimer = window.setTimeout(() => this.runSearch(query, requestId), 300)
    },
    handleSearchMove(dir: string): void {
      if (this.searchMode === 'ask') return
      this.cursor += dir === 'up' ? -1 : 1
      const lastIndex = this.results.length + this.suggestions.length - 1
      if (this.cursor < -1) this.cursor = -1
      else if (this.cursor > lastIndex) this.cursor = lastIndex
    },
    async handleSearchEnter(): Promise<void> {
      if (this.canAsk && this.searchMode === 'ask') {
        await this.submitAskPrompt()
        return
      }
      if (this.cursor >= 0 && this.cursor < this.results.length) {
        const result = _.nth(this.results, this.cursor)
        if (result) this.goToPage(result)
      } else if (this.cursor >= this.results.length && this.cursor < this.results.length + this.suggestions.length) {
        this.setSearchTerm(_.nth(this.suggestions, this.cursor - this.results.length))
      }
    },
    async submitAskPrompt(): Promise<void> {
      const prompt = this.search.trim()
      if (!this.canAsk || this.searchMode !== 'ask' || !prompt) return
      await this.$nextTick()
      const inlineAgent = this.$refs.inlineAgent as InlineAgentChatRef | undefined
      if (await inlineAgent?.sendPrompt(prompt)) this.search = ''
    },
    closeSearch(): void {
      this.search = ''
      this.searchIsFocused = false
      this.approvalId = ''
      const url = new URL(window.location.href)
      url.searchParams.delete('agentApproval')
      window.history.replaceState(window.history.state, '', url)
    },
    setSearchTerm(term: string | undefined): void {
      if (term !== undefined) this.search = term
    },
    goToPage(item: PageSearchRow): void {
      window.location.assign(`/${item.locale}/${item.path}`)
    },
    goToPageInNewTab(item: PageSearchRow): void {
      window.open(`/${item.locale}/${item.path}`, '_blank')
    },
    retrySearch(): void {
      if (!this.search || this.search.length < 2) return
      this.searchRequestId += 1
      this.searchError = ''
      this.searchIsLoading = true
      void this.runSearch(this.search, this.searchRequestId)
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
  position: fixed;
  top: 64px;
  left: 0;
  overflow-y: auto;
  width: 100%;
  height: calc(100% - 64px);
  background-color: rgba(0,0,0,.9);
  z-index: 1006;
  text-align: center;
  animation: searchResultsReveal .2s ease-out;

  @media #{map-get($display-breakpoints, 'sm-and-down')} {
    height: calc(100% - 112px);
    top: 112px;
  }

  &--ask {
    background:
      radial-gradient(ellipse 44rem 24rem at 50% -8rem, rgba(82, 113, 255, .22), transparent),
      rgba(8, 10, 17, .9);
    box-sizing: border-box;
    overflow: hidden;

    @media #{map-get($display-breakpoints, 'sm-and-down')} {
      height: calc(100% - 56px);
      top: 56px;
    }
  }

  &-container {
    margin: 12px auto;
    width: 90vw;
    max-width: 1024px;

    &--ask {
      align-items: center;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      height: 100%;
      margin: 0 auto;
      padding: 0 clamp(.75rem, 2vw, 1.5rem) clamp(.75rem, 2vw, 1.5rem);
      width: 100%;
    }
  }

  &-controls {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
    min-height: 3.5rem;
    padding: .4rem 0;
    position: relative;
    width: min(64rem, 100%);
  }

  &-mode {
    margin: 0;
  }

  &-close {
    position: absolute !important;
    right: clamp(.5rem, 2vw, 1.5rem);
  }

  &-shortcut {
    left: clamp(.5rem, 2vw, 1.5rem);
    position: absolute !important;

    @media #{map-get($display-breakpoints, 'sm-and-down')} {
      display: none !important;
    }
  }

  &--ask .inline-agent {
    box-sizing: border-box;
    flex: 1 1 auto;
    max-width: 64rem;
    min-height: 0;
    padding: 0;
  }

  &--ask .inline-agent__card {
    height: 100%;
    min-height: 0;
  }

  @media #{map-get($display-breakpoints, 'sm-and-down')} {
    &-container--ask { padding: 0; }
    &--ask &-controls { padding-inline: .75rem; }
  }


  &-help {
    text-align: center;
    padding: 32px 0;
    font-size: 18px;
    font-weight: 300;
    color: #FFF;

    img {
      width: 104px;
    }
  }

  &-loader {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    padding: 32px 0;
    color: #FFF;
  }

  &-none {
    color: #FFF;

    img {
      width: 200px;
    }
  }

  &-items {
    text-align: left;

    .highlighted {
      background: #FFF linear-gradient(to bottom, #FFF, mc('orange', '100'));

      @at-root .v-theme--dark & {
        background: mc('grey', '900') linear-gradient(to bottom, mc('orange', '900'), darken(mc('orange', '900'), 15%));
      }
    }
  }

  &-tags {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .3rem;
    margin-top: .35rem;
  }

  &-suggestions {
    .highlighted {
      background: transparent linear-gradient(to bottom, mc('blue', '500'), mc('blue', '700'));
    }
  }
}

@keyframes searchResultsReveal {
  from {
    opacity: 0;
    transform: translateY(-.75rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .search-results { animation: none; }
}
</style>
