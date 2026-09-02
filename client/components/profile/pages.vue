<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .profile-header
          img.animated.fadeInUp(src='/_assets/svg/icon-file.svg', alt='', style='width: 80px;')
          .profile-header-title
            h1.text-headline-medium.text-primary.animated.fadeInLeft {{$t('profile:pages.title')}}
            .text-body-large.text-grey.animated.fadeInLeft {{$t('profile:pages.subtitle')}}
          v-spacer
          v-btn.animated.fadeInDown.wait-p1s(
            icon
            color='grey'
            variant="outlined"
            @click='refresh'
            :loading='loading'
            :disabled='loading'
            size="large"
            :aria-label='$t("profile:pages.refresh", { defaultValue: "Refresh pages" })'
          )
            v-icon.text-grey mdi-refresh
      v-col(cols='12')
        v-card.animated.fadeInUp
          async-state(
            v-if='errorMessage'
            state='error'
            :title='$t("profile:pages.loadError", { defaultValue: "Pages could not be loaded" })'
            :message='errorMessage'
            :retry-label='$t("common:actions.retry", { defaultValue: "Try again" })'
            @retry='loadPages'
          )
          v-data-table.profile-pages-table(
            v-else
            :items='pages'
            :headers='headers'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            :hide-default-header='$vuetify.display.smAndDown'
            must-sort
            :sort-by="[{ key: 'updatedAt', order: 'desc' }]"
            hide-default-footer
          )
            template(v-slot:item='props')
              tr(v-if='$vuetify.display.mdAndUp')
                td
                  .text-body-medium
                    a.profile-page-link(:href='pageHref(props.item)')
                      strong {{ props.item.title }}
                    v-chip.ml-2(v-if="props.item.visibility === 'private'", size="x-small", color='warning') {{ $t('profile:pages.private', { defaultValue: 'Private' }) }}
                  .text-body-small {{ props.item.description }}
                td.profile-pages-path
                  v-chip(label, size="small", :color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-4`') {{ props.item.locale }}
                  span.ml-2(:class='$vuetify.theme.current.dark ? `text-grey-lighten-1` : `text-grey-darken-2`') / {{ props.item.path }}
                td {{ $helpers.formatMoment(props.item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
              tr.profile-pages-mobile-row(v-else)
                td(:colspan='headers.length')
                  .profile-pages-mobile-record
                    a.profile-page-link.profile-pages-mobile-title(:href='pageHref(props.item)')
                      strong {{ props.item.title }}
                    .text-body-small {{ props.item.description }}
                    .profile-pages-mobile-meta
                      v-chip.mr-2(label, size="x-small", color='warning', v-if="props.item.visibility === 'private'") {{ $t('profile:pages.private', { defaultValue: 'Private' }) }}
                      v-chip.mr-2(label, size="x-small", :color='$vuetify.theme.current.dark ? `grey-darken-4` : `grey-lighten-4`') {{ props.item.locale }}
                      span /{{ props.item.path }}
                    .text-body-small.mt-2.text-medium-emphasis {{ $t('profile:pages.headerUpdatedAt') }} {{ $helpers.formatMoment(props.item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              async-state(
                v-if='loading'
                state='loading'
                :title='$t("profile:pages.loading", { defaultValue: "Loading pages" })'
                :message='$t("profile:pages.loadingMessage", { defaultValue: "Fetching your contributions." })'
              )
              async-state(
                v-else
                state='empty'
                :title='$t("profile:pages.emptyList", { defaultValue: "No pages to display" })'
              )
          .text-center.py-2.animated.fadeInDown(v-if='pageTotal > 1')
            v-pagination(v-model='pagination', :length='pageTotal')
</template>

<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import { fetchPages, type PageListRow } from '../../helpers/pages-api'
import { getErrorMessage, showNotification, setLoading } from '../../helpers/root-ui-store'
import { wikiStore } from '@/store/index.ts'

export default {
  components: {
    AsyncState
  },

  data() {
    return {
      pagination: 1,
      pages: [] as PageListRow[],
      loading: false,
      errorMessage: ''
    }
  },
  computed: {
    headers () {
      return [
        { title: this.$t('profile:pages.headerTitle'), value: 'title' },
        { title: this.$t('profile:pages.headerPath'), value: 'path' },
        { title: this.$t('profile:pages.headerCreatedAt'), value: 'createdAt', width: 250 },
        { title: this.$t('profile:pages.headerUpdatedAt'), value: 'updatedAt', width: 250 }
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
      const loaded = await this.loadPages()
      if (loaded) {
        showNotification(wikiStore, {
          message: this.$t('profile:pages.refreshSuccess'),
          style: 'success',
          icon: 'cached'
        })
      }
    },
    pageHref(page: PageListRow): string {
      const scope = page.visibility === 'private' ? '/_private' : ''
      return `${scope}/${page.locale}/${page.path}`
    },
    async loadPages(): Promise<boolean> {
      this.errorMessage = ''
      this.loading = true
      setLoading(wikiStore, 'profile-pages-refresh', true)
      try {
        const userId = wikiStore.user.id
        this.pages = await fetchPages(window.fetch.bind(window), {
          creatorId: userId,
          authorId: userId
        })
        this.pagination = Math.min(this.pagination, Math.max(1, Math.ceil(this.pages.length / 15)))
        return true
      } catch (err) {
        this.errorMessage = getErrorMessage(err)
        wikiStore.showError(err)
        return false
      } finally {
        this.loading = false
        setLoading(wikiStore, 'profile-pages-refresh', false)
      }
    }
  }

}
</script>

<style lang='scss'>
.profile-page-link {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
}

.profile-page-link:hover,
.profile-page-link:focus-visible {
  text-decoration: underline;
}

.profile-pages-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.profile-pages-mobile-row td {
  padding: 14px 16px !important;
}

.profile-pages-mobile-record {
  min-width: 0;
}

.profile-pages-mobile-title {
  display: block;
  margin-bottom: 4px;
  overflow-wrap: anywhere;
}

.profile-pages-mobile-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
</style>
