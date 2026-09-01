<template lang='pug'>
  v-container.admin-pages(fluid)
    v-row
      v-col(cols='12')
        admin-hero(
          title='Pages'
          description='Manage pages'
          icon='/_assets/svg/icon-file.svg'
        )
          template(v-slot:actions)
            v-btn.animated.fadeInDown.wait-p1s(icon color='grey' variant="outlined" @click='refresh' :loading='loading' :disabled='loading' aria-label='Refresh pages')
              v-icon.text-grey mdi-refresh
            v-btn.animated.fadeInDown(color='primary' variant="flat" size="large" to='pages/visualize' :icon='$vuetify.display.smAndDown' aria-label='Visualize pages')
              v-icon(:start='$vuetify.display.mdAndUp') mdi-graph
              span(v-if='$vuetify.display.mdAndUp') Visualize
        v-card.mt-3.animated.fadeInUp
          .admin-filter-bar.pa-2.d-flex.align-center
            v-text-field.admin-pages-filter-search(variant="solo" flat v-model='search' prepend-inner-icon='mdi-file-search-outline' label='Search pages' hide-details density="compact" @update:model-value='pagination = 1')
            v-spacer
            v-select.admin-pages-filter-select(variant="solo" flat hide-details density="compact" label='Locale' :items='langs' item-title='text' v-model='selectedLang' @update:model-value='pagination = 1')
            v-select.admin-pages-filter-select(variant="solo" flat hide-details density="compact" label='Publish state' :items='states' item-title='text' v-model='selectedState' @update:model-value='pagination = 1')
            v-btn.admin-pages-filter-clear(v-if='hasActiveFilters' variant='text' size='small' color='primary' @click='clearFilters') Clear filters
          v-alert(v-if='errorMessage && pages.length' type='error' variant='tonal' class='ma-3')
            .d-flex.align-center
              span {{ errorMessage }}
              v-spacer
              v-btn(variant='text' color='primary' @click='loadPages') Try again
          v-divider
          v-data-table.admin-responsive-table(
            :items='filteredPages'
            :headers='responsiveHeaders'
            :search='search'
            :hide-default-header='$vuetify.display.smAndDown'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            must-sort
            :sort-by='sortBy'
            hide-default-footer
          )
            template(v-slot:item='props')
              tr(v-if='$vuetify.display.mdAndUp')
                td.text-end {{ props.item.id }}
                td
                  router-link.admin-record-link(:to='`/pages/${props.item.id}`') {{ props.item.title }}
                  .admin-pages-description {{ props.item.description }}
                td.admin-pages-path
                  v-chip(label size="small" color='primary' variant='tonal') {{ props.item.locale }}
                  span.ms-2.text-medium-emphasis /{{ props.item.path }}
                td
                  v-chip(size='small' :color='props.item.isPublished ? `success` : `warning`' variant='tonal') {{ props.item.isPublished ? 'Published' : 'Draft' }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
              tr.admin-mobile-table-row(v-else)
                td(:colspan='responsiveHeaders.length')
                  .admin-mobile-record
                    router-link.admin-mobile-record-title(:to='`/pages/${props.item.id}`') {{ props.item.title }}
                    .admin-pages-description.text-body-small.text-medium-emphasis {{ props.item.description }}
                    .admin-mobile-record-meta
                      v-chip.me-2(label size="x-small" color='primary' variant='tonal') {{ props.item.locale }}
                      span /{{ props.item.path }}
                    .d-flex.align-center.ga-2.mt-2
                      v-chip(size='x-small' :color='props.item.isPublished ? `success` : `warning`' variant='tonal') {{ props.item.isPublished ? 'Published' : 'Draft' }}
                      .text-body-small.text-medium-emphasis Updated {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              async-state(v-if='loading' state='loading' title='Loading pages' message='Fetching the latest page list.')
              async-state(v-else-if='errorMessage' state='error' title='Pages could not be loaded' :message='errorMessage' retry-label='Try again' @retry='loadPages')
              async-state(v-else-if='hasActiveFilters' state='empty' title='No pages match these filters' message='Clear the filters to see all pages.')
              async-state(v-else state='empty' title='No pages to display' message='There are no pages yet.')
            template(v-slot:bottom='{ pageCount }')
              .text-center.py-2.animated.fadeInDown(v-if='pageCount > 1')
                v-pagination(v-model='pagination' :length='pageCount' aria-label='Pages pagination')
</template>

<script lang='ts'>
import _ from 'lodash'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

type PageFilterOption<T> = { text: string, value: T }

export default {
  components: { AsyncState },
  data() {
    return {
      pagination: 1,
      pages: [] as PageListRow[],
      headers: [
        { title: 'ID', value: 'id', width: 80, sortable: true },
        { title: 'Title', value: 'title' },
        { title: 'Path', value: 'path' },
        { title: 'Status', value: 'status', sortable: false, width: 120 },
        { title: 'Created', value: 'createdAt', width: 250 },
        { title: 'Last Updated', value: 'updatedAt', width: 250 }
      ],
      sortBy: [{ key: 'updatedAt', order: 'desc' as const }],
      search: '',
      selectedLang: null as string | null,
      selectedState: null as boolean | null,
      states: [
        { text: 'All Publishing States', value: null },
        { text: 'Published', value: true },
        { text: 'Not Published', value: false }
      ] as PageFilterOption<boolean | null>[],
      errorMessage: '',
      loading: false,
      loadRequestId: 0
    }
  },
  computed: {
    responsiveHeaders() {
      return this.$vuetify.display.smAndDown ? this.headers.filter(header => header.value === 'title') : this.headers
    },
    filteredPages(): PageListRow[] {
      return this.pages.filter(pg =>
        (this.selectedLang === null || this.selectedLang === pg.locale) &&
        (this.selectedState === null || this.selectedState === pg.isPublished)
      )
    },
    hasActiveFilters() {
      return Boolean(this.search.trim() || this.selectedLang !== null || this.selectedState !== null)
    },
    langs(): PageFilterOption<string | null>[] {
      return [{ text: 'All Locales', value: null }, ..._.uniqBy(this.pages, 'locale').map(pg => ({ text: pg.locale, value: pg.locale }))]
    }
  },
  methods: {
    clearFilters() {
      this.search = ''
      this.selectedLang = null
      this.selectedState = null
      this.pagination = 1
    },
    async loadPages(): Promise<boolean> {
      const requestId = ++this.loadRequestId
      this.errorMessage = ''
      this.loading = true
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const pages = await fetchPageList(window.fetch.bind(window))
        if (requestId !== this.loadRequestId) return false
        this.pages = pages
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
      if (await this.loadPages()) wikiStore.showNotification({ message: 'Page list has been refreshed.', style: 'success', icon: 'cached' })
    }
  },
  mounted() {
    this.loadPages()
  },
  beforeUnmount() {
    this.loadRequestId++
  }
}
</script>

<style lang='scss'>
.admin-responsive-table {
  min-height: min(45rem, calc(100dvh - 16rem));
}

.admin-pages-path {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  font-family: 'Roboto Mono', monospace;
}

.v-application.admin .admin-main > .v-container.admin-pages .admin-filter-bar {
  display: grid !important;
  grid-template-columns: minmax(14rem, 2fr) minmax(10rem, 1fr) minmax(10rem, 1fr) auto;
  align-items: center;

  > .v-spacer {
    display: none;
  }

  > .v-input {
    width: 100%;
    min-width: 0;
    max-width: none;
    margin-inline-start: 0 !important;
  }
}

@media (min-width: 600px) and (max-width: 1199px) {
  .v-application.admin .admin-main > .v-container.admin-pages .admin-filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));

    > .admin-pages-filter-search,
    > .admin-pages-filter-clear {
      grid-column: 1 / -1;
    }

    > .admin-pages-filter-clear {
      justify-self: start;
    }
  }
}

@media (max-width: 599px) {
  .v-application.admin .admin-main > .v-container.admin-pages .admin-filter-bar {
    grid-template-columns: minmax(0, 1fr);
  }

  .v-application.admin .admin-main > .v-container.admin-pages .admin-pages-description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
}
</style>
