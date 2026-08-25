<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-file.svg', alt='Page', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft Pages
            .text-body-large.text-medium-emphasis.animated.fadeInLeft.wait-p2s Manage pages
          v-spacer
          v-btn.animated.fadeInDown.wait-p1s(icon, color='grey', variant="outlined", @click='refresh', aria-label='Refresh pages')
            v-icon.text-grey mdi-refresh
          //- v-btn.animated.fadeInDown.mx-3(color='primary', variant='outlined', @click='recyclebin', disabled)
          //-   v-icon(start) mdi-delete-outline
          //-   span Recycle Bin
          v-btn.animated.fadeInDown(
            color='primary'
            variant="flat"
            size="large"
            to='pages/visualize'
            :icon='$vuetify.display.smAndDown'
            aria-label='Visualize pages'
          )
            v-icon(:start='$vuetify.display.mdAndUp') mdi-graph
            span(v-if='$vuetify.display.mdAndUp') Visualize
        v-card.mt-3.animated.fadeInUp
          .admin-filter-bar.pa-2.d-flex.align-center(:class='$vuetify.theme.current.dark ? `bg-grey-darken-3` : `bg-grey-lighten-3`')
            v-text-field(
              variant="solo"
              flat
              v-model='search'
              prepend-inner-icon='mdi-file-search-outline'
              label='Search Pages...'
              hide-details
              density="compact"
              style='max-width: 400px;'
              )
            v-spacer
            v-select.ml-2(
              variant="solo"
              flat
              hide-details
              density="compact"
              label='Locale'
              :items='langs'
              item-title='text'
              v-model='selectedLang'
              style='max-width: 250px;'
            )
            v-select.ml-2(
              variant="solo"
              flat
              hide-details
              density="compact"
              label='Publish State'
              :items='states'
              item-title='text'
              v-model='selectedState'
              style='max-width: 250px;'
            )
          v-divider
          v-data-table.admin-responsive-table(
            :items='filteredPages'
            :headers='responsiveHeaders'
            :search='search'
            :hide-default-header='$vuetify.display.smAndDown'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            must-sort,
            :sort-by="[{ key: 'updatedAt', order: 'desc' }]"
            hide-default-footer
            @page-count="pageTotal = $event"
          )
            template(v-slot:item='props')
              tr.is-clickable(v-if='$vuetify.display.mdAndUp', :active='props.selected', @click='$router.push(`/pages/` + props.item.id)')
                td.text-right {{ props.item.id }}
                td
                  .text-body-medium: strong {{ props.item.title }}
                  .text-body-small {{ props.item.description }}
                td.admin-pages-path
                  v-chip(label, size="small", :color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-4`') {{ props.item.locale }}
                  span.ml-2(:class='$vuetify.theme.current.dark ? `text-grey-lighten-1` : `text-grey-darken-2`') / {{ props.item.path }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
              tr.admin-mobile-table-row.is-clickable(v-else, @click='$router.push(`/pages/` + props.item.id)')
                td(:colspan='responsiveHeaders.length')
                  .admin-mobile-record
                    .admin-mobile-record-title {{ props.item.title }}
                    .text-body-small.text-grey {{ props.item.description }}
                    .admin-mobile-record-meta
                      v-chip.mr-2(label, size="x-small", :color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-4`') {{ props.item.locale }}
                      span /{{ props.item.path }}
                    .text-body-small.text-grey.mt-2 Updated {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              async-state(
                v-if='loading'
                state='loading'
                title='Loading pages'
                message='Fetching the latest page list.'
              )
              async-state(
                v-else-if='errorMessage'
                state='error'
                title='Pages could not be loaded'
                :message='errorMessage'
                retry-label='Try again'
                @retry='loadPages'
              )
              async-state(
                v-else
                state='empty'
                title='No pages to display'
                message='Change the filters or create a page.'
              )
          .text-center.py-2.animated.fadeInDown(v-if='this.pageTotal > 1')
            v-pagination(v-model='pagination', :length='pageTotal')</template>

<script lang='ts'>
import _ from 'lodash'
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

type PageFilterOption<T> = {
  text: string
  value: T
}

export default {
  components: {
    AsyncState
  },
  data() {
    return {
      pagination: 1,
      pages: [] as PageListRow[],
      pageTotal: 0,
      headers: [
        { title: 'ID', value: 'id', width: 80, sortable: true },
        { title: 'Title', value: 'title' },
        { title: 'Path', value: 'path' },
        { title: 'Created', value: 'createdAt', width: 250 },
        { title: 'Last Updated', value: 'updatedAt', width: 250 }
      ],
      search: '',
      selectedLang: null as string | null,
      selectedState: null as boolean | null,
      states: [
        { text: 'All Publishing States', value: null },
        { text: 'Published', value: true },
        { text: 'Not Published', value: false }
      ] as PageFilterOption<boolean | null>[],
      errorMessage: '',
      loading: false
    }
  },
  computed: {
    responsiveHeaders () {
      return this.$vuetify.display.smAndDown
        ? this.headers.filter(header => header.value === 'title')
        : this.headers
    },
    filteredPages (): PageListRow[] {
      return this.pages.filter(pg => {
        if (this.selectedLang !== null && this.selectedLang !== pg.locale) {
          return false
        }
        if (this.selectedState !== null && this.selectedState !== pg.isPublished) {
          return false
        }
        return true
      })
    },
    langs (): PageFilterOption<string | null>[] {
      return [{
        text: 'All Locales',
        value: null
      }, ..._.uniqBy(this.pages, 'locale').map(pg => ({
        text: pg.locale,
        value: pg.locale
      }))]
    }
  },
  methods: {
    async loadPages (): Promise<boolean> {
      this.errorMessage = ''
      this.loading = true
      wikiStore.startLoading('admin-pages-refresh')
      try {
        this.pages = await fetchPageList(window.fetch.bind(window))
        return true
      } catch (err) {
        this.errorMessage = getErrorMessage(err)
        wikiStore.showError(err)
        return false
      } finally {
        this.loading = false
        wikiStore.stopLoading('admin-pages-refresh')
      }
    },
    async refresh() {
      const isLoaded = await this.loadPages()
      if (isLoaded) {
        wikiStore.showNotification({
          message: 'Page list has been refreshed.',
          style: 'success',
          icon: 'cached'
        })
      }
    },
    recyclebin () { }
  },
  mounted () {
    this.loadPages()
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
</style>
