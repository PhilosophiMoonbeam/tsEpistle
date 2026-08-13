<template lang='pug'>
  v-container(fluid, grid-list-lg)
    v-row
      v-col(cols='12')
        .profile-header
          img.animated.fadeInUp(src='/_assets/svg/icon-file.svg', alt='Users', style='width: 80px;')
          .profile-header-title
            .headline.primary--text.animated.fadeInLeft {{$t('profile:pages.title')}}
            .subheading.grey--text.animated.fadeInLeft {{$t('profile:pages.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown.wait-p1s(color='grey', outlined, @click='refresh', large)
            v-icon.grey--text mdi-refresh
      v-col(cols='12')
        v-card.animated.fadeInUp
          v-data-table(
            :items='pages'
            :headers='headers'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            must-sort,
            sort-by='updatedAt',
            sort-desc,
            hide-default-footer
          )
            template(v-slot:item='props')
              tr.is-clickable(:active='props.selected', @click='goToPage(props.item.id)')
                td
                  .body-2: strong {{ props.item.title }}
                  .caption {{ props.item.description }}
                td.admin-pages-path
                  v-chip(label, small, :color='$vuetify.theme.current.dark ? `grey darken-4` : `grey lighten-4`') {{ props.item.locale }}
                  span.ml-2.grey--text(:class='$vuetify.theme.current.dark ? `text--lighten-1` : `text--darken-2`') / {{ props.item.path }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              v-alert.ma-3(icon='mdi-alert', :value='true', outlined, color='grey')
                em.caption {{$t('profile:pages.emptyList')}}
          .text-center.py-2.animated.fadeInDown(v-if='this.pageTotal > 1')
            v-pagination(v-model='pagination', :length='pageTotal')
</template>

<script lang='ts'>
import { fetchPages, type PageListRow } from '../../helpers/pages-api'
import { showNotification, setLoading } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  data() {
    return {
      selectedPage: null as PageListRow | null,
      pagination: 1,
      pages: [] as PageListRow[],
      loading: false
    }
  },
  computed: {
    headers () {
      return [
        { text: this.$t('profile:pages.headerTitle'), value: 'title' },
        { text: this.$t('profile:pages.headerPath'), value: 'path' },
        { text: this.$t('profile:pages.headerCreatedAt'), value: 'createdAt', width: 250 },
        { text: this.$t('profile:pages.headerUpdatedAt'), value: 'updatedAt', width: 250 }
      ]
    },
    pageTotal () {
      return Math.ceil(this.pages.length / 15)
    }
  },
  mounted() {
    this.loadPages()
  },
  methods: {
    async refresh() {
      await this.loadPages()
      showNotification(wikiStore, {
        message: this.$t('profile:pages.refreshSuccess'),
        style: 'success',
        icon: 'cached'
      })
    },
    goToPage(id: number) {
      window.location.assign(`/i/` + id)
    },
    async loadPages() {
      this.loading = true
      setLoading(wikiStore, 'profile-pages-refresh', true)
      try {
        const userId = wikiStore.user.id
        this.pages = await fetchPages(window.fetch.bind(window), {
          creatorId: userId,
          authorId: userId
        })
      } finally {
        this.loading = false
        setLoading(wikiStore, 'profile-pages-refresh', false)
      }
    }
  }

}
</script>

<style lang='scss'>

</style>
