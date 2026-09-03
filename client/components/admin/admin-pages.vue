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
            v-btn.animated.fadeInDown(color='primary' variant="flat" size="large" to='/pages/visualize' :icon='$vuetify.display.smAndDown' aria-label='Visualize pages')
              v-icon(:start='$vuetify.display.mdAndUp') mdi-graph
              span(v-if='$vuetify.display.mdAndUp') Visualize
        v-card.mt-3.animated.fadeInUp
          .admin-filter-bar.admin-pages-filter-bar.pa-2
            v-text-field.admin-pages-filter-search(variant="solo" flat v-model='search' prepend-inner-icon='mdi-file-search-outline' label='Search pages' hide-details density="compact" @update:model-value='pagination = 1')
            v-select.admin-pages-filter-select(variant="solo" flat hide-details density="compact" label='Locale' :items='langs' v-model='selectedLang' @update:model-value='pagination = 1')
            v-select.admin-pages-filter-select(variant="solo" flat hide-details density="compact" label='Publish state' :items='states' v-model='selectedState' @update:model-value='pagination = 1')
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
            item-value='id'
            :hide-default-header='$vuetify.display.smAndDown'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            must-sort
            :sort-by='sortBy'
            hide-default-footer
            aria-label='Pages'
          )
            template(v-slot:item='props')
              tr(v-if='$vuetify.display.mdAndUp')
                td.text-end {{ props.item.id }}
                td
                  router-link.admin-record-link(:to='`/pages/${props.item.id}`') {{ props.item.title }}
                  .admin-pages-description {{ props.item.description }}
                td
                  .admin-pages-path
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
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

type PageFilterOption<T> = { title: string, value: T }

export default {
  components: { AsyncState },
  data() {
    return {
      pagination: 1,
      pages: [] as PageListRow[],
      headers: [
        { title: 'ID', key: 'id', value: 'id', width: 80, sortable: true },
        { title: 'Title', key: 'title', value: 'title' },
        { title: 'Path', key: 'path', value: 'path' },
        { title: 'Status', key: 'isPublished', value: 'isPublished', sortable: false, width: 120 },
        { title: 'Created', key: 'createdAt', value: 'createdAt', width: 250 },
        { title: 'Last Updated', key: 'updatedAt', value: 'updatedAt', width: 250 }
      ],
      sortBy: [{ key: 'updatedAt', order: 'desc' as const }],
      search: '',
      selectedLang: null as string | null,
      selectedState: null as boolean | null,
      states: [
        { title: 'All Publishing States', value: null },
        { title: 'Published', value: true },
        { title: 'Draft', value: false }
      ] as PageFilterOption<boolean | null>[],
      errorMessage: '',
      loading: false,
      loadRequestId: 0
    }
  },
  computed: {
    responsiveHeaders() {
      return this.$vuetify.display.smAndDown ? this.headers.filter(header => (header.key ?? header.value) === 'title') : this.headers
    },
    filteredPages(): PageListRow[] {
      const query = this.search.trim().toLocaleLowerCase()
      return this.pages.filter(pg => {
        if (this.selectedLang !== null && this.selectedLang !== pg.locale) return false
        if (this.selectedState !== null && this.selectedState !== pg.isPublished) return false
        if (!query) return true
        return [
          String(pg.id),
          pg.title ?? '',
          pg.description ?? '',
          pg.locale,
          `/${pg.path}`,
          `${pg.locale}/${pg.path}`,
          pg.isPublished ? 'published' : 'draft'
        ].some(value => value.toLocaleLowerCase().includes(query))
      })
    },
    hasActiveFilters() {
      return Boolean(this.search.trim() || this.selectedLang !== null || this.selectedState !== null)
    },
    langs(): PageFilterOption<string | null>[] {
      const locales = new Set<string>()
      for (const page of this.pages) locales.add(page.locale)
      return [{ title: 'All Locales', value: null }, ...Array.from(locales).sort((a, b) => a.localeCompare(b)).map(locale => ({ title: locale, value: locale }))]
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

.admin-pages-filter-bar {
  display: grid;
  grid-template-columns: minmax(14rem, 2fr) minmax(10rem, 1fr) minmax(10rem, 1fr) auto;
  align-items: center;

  > .admin-pages-filter-search,
  > .admin-pages-filter-select {
    width: 100%;
    min-width: 0;
    max-width: none;
    margin-inline-start: 0 !important;
  }
}

@media (min-width: 600px) and (max-width: 1199px) {
  .admin-pages-filter-bar {
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
  .admin-pages-filter-bar {
    grid-template-columns: minmax(0, 1fr);
  }

  .admin-pages .admin-pages-description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
}
</style>
