<template lang="pug">
  .search-results(v-if='searchIsFocused || (search && search.length > 1)')
    .search-results-container
      v-btn-toggle.search-results-mode(
        v-if='canAsk'
        v-model='searchMode'
        mandatory
        density='compact'
        color='primary'
        :aria-label='$t(`common:header.searchModeLabel`)'
      )
        v-btn(value='search') {{$t('common:header.searchMode')}}
        v-btn(value='ask') {{$t('common:header.askMode')}}
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
        v-list.search-results-items.radius-7.py-0(lines="two", density="compact")
          template(v-for='(item, idx) of results', :key='item.id')
            v-list-item(@click='goToPage(item)', @click.middle="goToPageInNewTab(item)", :class='idx === cursor ? `highlighted` : ``')
              template(v-slot:prepend)
                v-avatar(tile)
                  img(src='/_assets/svg/icon-selective-highlighting.svg')
              v-list-item-title {{ item.title }}
              v-list-item-subtitle.text-body-small {{ item.description }}
              .text-body-small.text-grey(v-text='item.path')
              template(v-slot:append)
                v-chip(label, variant="outlined") {{item.locale.toUpperCase()}}
            v-divider(v-if='idx < results.length - 1')
        v-pagination.mt-3(
          v-if='paginationLength > 1'
          v-model='pagination'
          :length='paginationLength'
          rounded
        )
      template(v-if='suggestions && suggestions.length > 0')
        v-list-subheader.text-white.mt-3 {{$t('common:header.searchDidYouMean')}}
        v-list.search-results-suggestions.radius-7(density="compact")
          template(v-for='(term, idx) of suggestions', :key='term')
            v-list-item(@click='setSearchTerm(term)', :class='idx + results.length === cursor ? `highlighted` : ``')
              template(v-slot:prepend)
                v-avatar
                  v-icon mdi-magnify
              v-list-item-title {{ term }}
            v-divider(v-if='idx < suggestions.length - 1')
      form.search-results-ask(
        v-if='canAsk && search && search.length >= 2'
        ref='askForm'
        method='post'
        action='/_api/agents/launch'
        target='_blank'
        rel='noopener'
      )
        input(type='hidden', name='csrfToken', :value='agentLaunchCsrfToken')
        template(v-if='currentPageId > 0')
          input(type='hidden', name='pageId', :value='currentPageId')
          input(type='hidden', name='pageLocale', :value='currentPageLocale')
          input(type='hidden', name='pagePath', :value='currentPagePath')
          input(type='hidden', name='pageUpdatedAt', :value='currentPageUpdatedAt')
        v-btn.search-results-ask-command(
          type='submit'
          block
          variant='tonal'
          color='primary'
          prepend-icon='mdi-creation'
          :class='askCursorIndex === cursor ? `highlighted` : ``'
          @click='searchMode = `ask`'
        ) {{$t('common:header.askWikiAbout', { query: search })}}
        v-btn.mt-2(
          type='submit'
          formtarget='_self'
          variant='text'
          size='small'
          @click='searchMode = `ask`'
        ) {{$t('common:header.askOpenSameTab')}}
      .text-xs-center.pt-5(v-if='search && search.length > 1')
        //- v-btn.mx-2(outlined, color='orange', @click='search = ``', v-if='results.length > 0')
        //-   v-icon(left) mdi-content-save
        //-   span {{$t('common:header.searchCopyLink')}}
        v-btn.mx-2(variant="outlined", color='pink', @click='search = ``')
          v-icon(start) mdi-close
          span {{$t('common:header.searchClose')}}</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import _ from 'lodash'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'
import { onSearchEnter, onSearchMove, offSearchEnter, offSearchMove } from '../../helpers/search-navigation-events'
import { searchPages, type PageSearchResult, type PageSearchRow } from '../../helpers/pages-api'

const emptySearchResponse = (): PageSearchResult => ({
  results: [],
  suggestions: [],
  totalHits: 0
})

export default defineComponent({
  components: {
    AsyncState
  },
  data() {
    return {
      cursor: 0,
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
    agentLaunchCsrfToken(): string { return siteConfig.agentLaunchCsrfToken },
    currentPageId(): number { return wikiStore.page.id },
    currentPageLocale(): string { return wikiStore.page.locale },
    currentPagePath(): string { return wikiStore.page.path },
    currentPageUpdatedAt(): string { return wikiStore.page.updatedAt },
    askCursorIndex(): number { return this.results.length + this.suggestions.length },
    paginationLength() {
      return (this.response.totalHits > 0) ? Math.ceil(this.response.totalHits / this.perPage) : 0
    }
  },
  watch: {
    search(newValue: string | null) {
      this.cursor = 0
      this.searchRequestId += 1
      const requestId = this.searchRequestId
      this.searchError = ''
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      if (!newValue || newValue.length < 2) {
        this.searchIsLoading = false
        this.response = emptySearchResponse()
        return
      }
      this.searchIsLoading = true
      this.searchTimer = window.setTimeout(() => this.runSearch(newValue, requestId), 300)
    },
    results() {
      this.cursor = 0
    }
  },
  mounted() {
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
    handleSearchMove(dir: string): void {
      this.cursor += ((dir === 'up') ? -1 : 1)
      const lastIndex = this.results.length + this.suggestions.length + (this.canAsk && this.search.length >= 2 ? 1 : 0) - 1
      if (this.cursor < -1) {
        this.cursor = -1
      } else if (this.cursor > lastIndex) {
        this.cursor = lastIndex
      }
    },
    handleSearchEnter() {
      if (this.canAsk && this.search.length >= 2 && (this.searchMode === 'ask' || this.cursor === this.askCursorIndex)) {
        ;(this.$refs.askForm as HTMLFormElement).requestSubmit()
        return
      }
      if (this.cursor >= 0 && this.cursor < this.results.length) {
        const result = _.nth(this.results, this.cursor)
        if (result) this.goToPage(result)
      } else if (this.cursor >= 0 && this.cursor < this.askCursorIndex) {
        this.setSearchTerm(_.nth(this.suggestions, this.cursor - this.results.length))
      }
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
  z-index: 100;
  text-align: center;
  animation: searchResultsReveal .6s ease;

  @media #{map-get($display-breakpoints, 'sm-and-down')} {
    top: 112px;
  }

  &-container {
    margin: 12px auto;
    width: 90vw;
    max-width: 1024px;
  }
  &-mode {
    margin-bottom: 12px;
  }

  &-ask {
    margin: 12px auto 0;
    max-width: 48rem;

    .highlighted {
      outline: 3px solid currentColor;
      outline-offset: 2px;
    }
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

  &-suggestions {
    .highlighted {
      background: transparent linear-gradient(to bottom, mc('blue', '500'), mc('blue', '700'));
    }
  }
}

@keyframes searchResultsReveal {
  0% {
    background-color: rgba(0,0,0,0);
    padding-top: 32px;
  }
  100% {
    background-color: rgba(0,0,0,.9);
    padding-top: 0;
  }
}
</style>
