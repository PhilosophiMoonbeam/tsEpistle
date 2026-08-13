<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-file.svg', alt='Page', style='width: 80px;')
          .admin-header-title
            .headline.blue--text.text--darken-2.animated.fadeInLeft Pages
            .subtitle-1.grey--text.animated.fadeInLeft.wait-p2s Manage pages
          v-spacer
          v-btn.animated.fadeInDown.wait-p1s(icon, color='grey', outlined, @click='refresh')
            v-icon.grey--text mdi-refresh
          //- v-btn.animated.fadeInDown.mx-3(color='primary', outlined, @click='recyclebin', disabled)
          //-   v-icon(left) mdi-delete-outline
          //-   span Recycle Bin
          v-btn.animated.fadeInDown(color='primary', depressed, large, to='pages/visualize')
            v-icon(left) mdi-graph
            span Visualize
        v-card.mt-3.animated.fadeInUp
          .pa-2.d-flex.align-center(:class='$vuetify.theme.current.dark ? `grey darken-3-d5` : `grey lighten-3`')
            v-text-field(
              solo
              flat
              v-model='search'
              prepend-inner-icon='mdi-file-search-outline'
              label='Search Pages...'
              hide-details
              dense
              style='max-width: 400px;'
              )
            v-spacer
            v-select.ml-2(
              solo
              flat
              hide-details
              dense
              label='Locale'
              :items='langs'
              v-model='selectedLang'
              style='max-width: 250px;'
            )
            v-select.ml-2(
              solo
              flat
              hide-details
              dense
              label='Publish State'
              :items='states'
              v-model='selectedState'
              style='max-width: 250px;'
            )
          v-divider
          v-data-table(
            :items='filteredPages'
            :headers='headers'
            :search='search'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            must-sort,
            sort-by='updatedAt',
            sort-desc,
            hide-default-footer
            @page-count="pageTotal = $event"
          )
            template(v-slot:item='props')
              tr.is-clickable(:active='props.selected', @click='$router.push(`/pages/` + props.item.id)')
                td.text-xs-right {{ props.item.id }}
                td
                  .body-2: strong {{ props.item.title }}
                  .caption {{ props.item.description }}
                td.admin-pages-path
                  v-chip(label, small, :color='$vuetify.theme.current.dark ? `grey darken-4` : `grey lighten-4`') {{ props.item.locale }}
                  span.ml-2.grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-1` : `text--darken-2`') / {{ props.item.path }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              v-alert.ma-3(icon='mdi-alert', :value='true', outlined) No pages to display.
          .text-center.py-2.animated.fadeInDown(v-if='this.pageTotal > 1')
            v-pagination(v-model='pagination', :length='pageTotal')
</template>

<script lang='ts'>
import _ from 'lodash'
import { fetchPageList, type PageListRow } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

type PageFilterOption<T> = {
  text: string
  value: T
}

export default {
  data() {
    return {
      pagination: 1,
      pages: [] as PageListRow[],
      pageTotal: 0,
      headers: [
        { text: 'ID', value: 'id', width: 80, sortable: true },
        { text: 'Title', value: 'title' },
        { text: 'Path', value: 'path' },
        { text: 'Created', value: 'createdAt', width: 250 },
        { text: 'Last Updated', value: 'updatedAt', width: 250 }
      ],
      search: '',
      selectedLang: null as string | null,
      selectedState: null as boolean | null,
      states: [
        { text: 'All Publishing States', value: null },
        { text: 'Published', value: true },
        { text: 'Not Published', value: false }
      ] as PageFilterOption<boolean | null>[],
      loading: false
    }
  },
  computed: {
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
      this.loading = true
      wikiStore.startLoading('admin-pages-refresh')
      try {
        this.pages = await fetchPageList(window.fetch.bind(window))
        return true
      } catch (err) {
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
.admin-pages-path {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  font-family: 'Roboto Mono', monospace;
}
</style>
