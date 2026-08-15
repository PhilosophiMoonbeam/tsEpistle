<template lang="pug">
  .search-results(v-if='searchIsFocused || (search && search.length > 1)')
    .search-results-container
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
        v-list-subheader.white--text {{$t('common:header.searchResultsCount', { total: response.totalHits })}}
        v-list.search-results-items.radius-7.py-0(two-line, dense)
          template(v-for='(item, idx) of results', :key='item.id')
            v-list-item(@click='goToPage(item)', @click.middle="goToPageInNewTab(item)", :class='idx === cursor ? `highlighted` : ``')
              v-avatar(tile)
                img(src='/_assets/svg/icon-selective-highlighting.svg')
              div.v-list-item-content
                v-list-item-title(v-text='item.title')
                v-list-item-subtitle.caption(v-text='item.description')
                .caption.grey--text(v-text='item.path')
              div.v-list-item-action
                v-chip(label, outlined) {{item.locale.toUpperCase()}}
            v-divider(v-if='idx < results.length - 1')
        v-pagination.mt-3(
          v-if='paginationLength > 1'
          dark
          v-model='pagination'
          :length='paginationLength'
          circle
        )
      template(v-if='suggestions && suggestions.length > 0')
        v-list-subheader.white--text.mt-3 {{$t('common:header.searchDidYouMean')}}
        v-list.search-results-suggestions.radius-7(dense, dark)
          template(v-for='(term, idx) of suggestions', :key='term')
            v-list-item(@click='setSearchTerm(term)', :class='idx + results.length === cursor ? `highlighted` : ``')
              v-avatar
                v-icon mdi-magnify
              div.v-list-item-content
                v-list-item-title(v-text='term')
            v-divider(v-if='idx < suggestions.length - 1')
      .text-xs-center.pt-5(v-if='search && search.length > 1')
        //- v-btn.mx-2(outlined, color='orange', @click='search = ``', v-if='results.length > 0')
        //-   v-icon(left) mdi-content-save
        //-   span {{$t('common:header.searchCopyLink')}}
        v-btn.mx-2(outlined, color='pink', @click='search = ``')
          v-icon(left) mdi-close
          span {{$t('common:header.searchClose')}}
</template>

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
      if (this.cursor < -1) {
        this.cursor = -1
      } else if (this.cursor > this.results.length + this.suggestions.length - 1) {
        this.cursor = this.results.length + this.suggestions.length - 1
      }
    },
    handleSearchEnter() {
      if (!this.results) {
        return
      }

      if (this.cursor >= 0 && this.cursor < this.results.length) {
        const result = _.nth(this.results, this.cursor)
        if (result) this.goToPage(result)
      } else if (this.cursor >= 0) {
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

      @at-root .theme--dark & {
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
