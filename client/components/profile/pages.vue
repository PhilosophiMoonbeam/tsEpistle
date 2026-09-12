<template lang='pug'>
  v-container(fluid)
    v-row
      v-col(cols='12')
        .profile-header
          .profile-header-icon-box
            v-avatar(size='64', color='primary', variant='tonal')
              v-icon(size='36', color='primary') mdi-file-document-multiple-outline
          .profile-header-title
            h1.text-headline-medium.font-weight-bold {{$t('profile:pages.title')}}
            .text-body-large.text-medium-emphasis {{$t('profile:pages.subtitle')}}
          v-spacer
          v-btn(
            icon
            color='grey'
            variant="outlined"
            @click='refresh'
            :loading='loading'
            :disabled='loading'
            rounded='lg'
            :aria-label='$t("profile:pages.refresh", { defaultValue: "Refresh pages" })'
          )
            v-icon.text-grey mdi-refresh
      v-col(cols='12')
        v-card
          .profile-pages-toolbar(v-if='!errorMessage')
            v-text-field.profile-pages-search(
              v-model='search'
              :label='$t("profile:pages.find", { defaultValue: "Find your pages" })'
              prepend-inner-icon='mdi-magnify'
              variant='outlined'
              density='compact'
              hide-details
              clearable
              :disabled='loading && pages.length === 0'
              autocomplete='off'
              aria-describedby='profile-pages-result-count'
            )
            p#profile-pages-result-count.profile-pages-result-count(role='status', aria-live='polite', aria-atomic='true')
              template(v-if='!loading') {{ $t('profile:pages.resultCount', { defaultValue: '{{count}} of {{total}} pages', count: filteredPages.length, total: pages.length }) }}
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
            :items='filteredPages'
            :headers='headers'
            v-model:page='pagination'
            :items-per-page='15'
            :loading='loading'
            :hide-default-header='$vuetify.display.smAndDown'
            must-sort
            :sort-by="[{ key: 'updatedAt', order: 'desc' }]"
            hide-default-footer
          )
            template(v-slot:caption)
              span.profile-pages-table-caption {{ $t('profile:pages.title') }}
            template(v-slot:item='{ item }')
              tr(v-if='$vuetify.display.mdAndUp')
                td
                  .text-body-medium
                    a.profile-page-link(:href='pageHref(item)')
                      strong {{ item.title }}
                    v-chip.ms-2(v-if="item.visibility === 'private'", size="x-small", color='warning') {{ $t('profile:pages.private', { defaultValue: 'Private' }) }}
                  .text-body-small {{ item.description }}
                td.profile-pages-path
                  v-chip(label, size="small", variant="tonal") {{ item.locale }}
                  span.ms-2.text-medium-emphasis / {{ item.path }}
                td {{ $helpers.formatMoment(item.createdAt, 'calendar') }}
                td {{ $helpers.formatMoment(item.updatedAt, 'calendar') }}
              tr.profile-pages-mobile-row(v-else)
                td(:colspan='headers.length')
                  .profile-pages-mobile-record
                    a.profile-page-link.profile-pages-mobile-title(:href='pageHref(item)')
                      strong {{ item.title }}
                    .text-body-small {{ item.description }}
                    .profile-pages-mobile-meta
                      v-chip.me-2(label, size="x-small", color='warning', v-if="item.visibility === 'private'") {{ $t('profile:pages.private', { defaultValue: 'Private' }) }}
                      v-chip.me-2(label, size="x-small", variant="tonal") {{ item.locale }}
                      span /{{ item.path }}
                    .text-body-small.mt-2.text-medium-emphasis {{ $t('profile:pages.headerUpdatedAt') }} {{ $helpers.formatMoment(item.updatedAt, 'calendar') }}
            template(v-slot:no-data)
              async-state(
                v-if='loading'
                state='loading'
                :title='$t("profile:pages.loading", { defaultValue: "Loading pages" })'
                :message='$t("profile:pages.loadingMessage", { defaultValue: "Fetching your contributions." })'
              )
              async-state(
                v-else-if='pages.length > 0 && normalizedSearch'
                state='empty'
                :title='$t("profile:pages.noMatches", { defaultValue: "No matching pages" })'
                :message='$t("profile:pages.noMatchesMessage", { defaultValue: "Try another title, description, path, or language, or clear your search." })'
              )
              async-state(
                v-else
                state='empty'
                :title='$t("profile:pages.emptyList", { defaultValue: "No pages to display" })'
                :message='$t("profile:pages.noContributions", { defaultValue: "Pages you create or contribute to will appear here." })'
              )
          .text-center.py-2(v-if='pageTotal > 1')
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
      search: '' as string | null,
      pages: [] as PageListRow[],
      loading: false,
      errorMessage: ''
    }
  },
  computed: {
    normalizedSearch (): string {
      return (this.search ?? '').trim().toLocaleLowerCase()
    },
    filteredPages (): PageListRow[] {
      const query = this.normalizedSearch
      if (!query) return this.pages
      return this.pages.filter(page => [page.title, page.description, page.path, page.locale]
        .some(value => (value ?? '').toLocaleLowerCase().includes(query)))
    },
    headers () {
      return [
        { title: this.$t('profile:pages.headerTitle'), key: 'title', value: 'title' },
        { title: this.$t('profile:pages.headerPath'), key: 'path', value: 'path' },
        { title: this.$t('profile:pages.headerCreatedAt'), key: 'createdAt', value: 'createdAt', width: 250 },
        { title: this.$t('profile:pages.headerUpdatedAt'), key: 'updatedAt', value: 'updatedAt', width: 250 }
      ]
    },
    pageTotal () {
      return Math.ceil(this.filteredPages.length / 15)
    }
  },
  watch: {
    normalizedSearch () {
      this.pagination = 1
    },
    pageTotal (total: number) {
      this.pagination = Math.min(this.pagination, Math.max(1, total))
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
    pageHref(item: PageListRow): string {
      const scope = item.visibility === 'private' ? '/_private' : ''
      return `${scope}/${item.locale}/${item.path}`
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
        this.pagination = Math.min(this.pagination, Math.max(1, this.pageTotal))
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
.profile-pages-toolbar {
  display: flex;
  align-items: center;
  gap: var(--wiki-space-4);
  padding: var(--wiki-space-4);
  border-bottom: 1px solid var(--wiki-surface-border);
}

.profile-pages-search {
  flex: 1 1 20rem;
  min-width: 0;
  max-width: 30rem;
}

.profile-pages-result-count {
  margin: 0;
  color: var(--wiki-purpose-neutral-ink);
  font-size: .8125rem;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 599.98px) {
  .profile-pages-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: var(--wiki-space-2);
  }

  .profile-pages-search {
    flex-basis: auto;
    max-width: none;
  }
}

.profile-pages-table-caption {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

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

.profile-header-icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
</style>
