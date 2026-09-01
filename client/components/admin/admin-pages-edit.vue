<template lang='pug'>
  v-container.admin-pages-edit(fluid)
    v-row(v-if='page')
      v-col(cols='12')
        admin-hero(
          title='Page Details'
          icon='/_assets/svg/icon-view-details.svg'
        )
          template(v-slot:extra)
            v-chip.ml-0.mr-2(label, size="small").text-body-small ID {{page.id}}
            span /{{page.locale}}/{{page.path}}
          template(v-slot:status)
            .page-status-group
              .page-status
                status-indicator(positive, pulse)
                .text-body-small.text-green(v-if='page.isPublished') {{$t('common:page.published')}}
                .text-body-small.text-red(v-else) {{$t('common:page.unpublished')}}
              .page-status
                status-indicator(intermediary, pulse, v-if="page.visibility === 'private'")
                status-indicator(active, pulse, v-else)
                .text-body-small.text-deep-orange(v-if="page.visibility === 'private'") {{$t('common:page.private')}}
                .text-body-small.text-blue(v-else) {{$t('common:page.global')}}
          template(v-slot:actions)
            .page-action-group
              v-btn.animated.fadeInDown.wait-p3s(color='grey', icon, variant="outlined", to='/pages', aria-label='Back to pages')
                v-icon mdi-arrow-left
              v-menu(origin='top right')
                template(v-slot:activator='{ props }')
                  v-btn.mx-3.animated.fadeInDown.wait-p2s(color='black', v-bind='props', variant="flat")
                    span Actions
                    v-icon(end) mdi-chevron-down
                v-list(density="compact", nav)
                  v-list-item(:href='(page.visibility === `private` ? `/_private` : ``) + `/` + page.locale + `/` + page.path')
                    template(v-slot:prepend)
                      v-icon(color='indigo') mdi-text-subject
                    v-list-item-title View
                  v-list-item(:href='`/e` + (page.visibility === `private` ? `/_private` : ``) + `/` + page.locale + `/` + page.path')
                    template(v-slot:prepend)
                      v-icon(color='indigo') mdi-pencil
                    v-list-item-title Edit
                  v-list-item(:href='`/s` + (page.visibility === `private` ? `/_private` : ``) + `/` + page.locale + `/` + page.path')
                    template(v-slot:prepend)
                      v-icon(color='indigo') mdi-code-tags
                    v-list-item-title View Source
                  v-list-item(:href='`/h` + (page.visibility === `private` ? `/_private` : ``) + `/` + page.locale + `/` + page.path')
                    template(v-slot:prepend)
                      v-icon(color='indigo') mdi-history
                    v-list-item-title View History
                  v-dialog(v-model='deletePageDialog', max-width='500')
                    template(v-slot:activator='{ props }')
                      v-list-item(v-bind='props')
                        template(v-slot:prepend)
                          v-icon(color='red') mdi-trash-can-outline
                        v-list-item-title Delete
                    v-card
                      .dialog-header.is-short.is-red
                        v-icon.mr-2(color='white') mdi-file-document-box-remove-outline
                        span {{$t('common:page.delete')}}
                      v-card-text.pt-5
                        i18next.text-body-medium(path='common:page.deleteTitle', tag='div')
                          span.text-red-darken-2(place='title') {{page.title}}
                        .text-body-small {{$t('common:page.deleteSubtitle')}}
                        v-chip.mt-3.ml-0.mr-1(label, color="red-lighten-4", size="small")
                          .text-body-small.text-red-darken-2 {{page.locale.toUpperCase()}}
                        v-chip.mt-3.mx-0(label, color="red-lighten-5", size="small")
                          span.text-red-darken-2 /{{page.path}}
                      div.v-card-chin
                        v-spacer
                        v-btn(variant="text", @click='deletePageDialog = false', :disabled='loading') {{$t('common:actions.cancel')}}
                        v-btn(color="red-darken-2", @click='deletePage', :loading='loading').text-white {{$t('common:actions.delete')}}
      v-col(cols='12', lg='6')
        v-card.animated.fadeInUp
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-text-subject
            span Properties
          dl.admin-page-metadata
            div
              dt.text-label-small.text-medium-emphasis Title
              dd.text-body-medium {{ page.title }}
            div
              dt.text-label-small.text-medium-emphasis Description
              dd.text-body-medium {{ page.description || '-' }}
            div
              dt.text-label-small.text-medium-emphasis Locale
              dd.text-body-medium {{ page.locale }}
            div
              dt.text-label-small.text-medium-emphasis Path
              dd.text-body-medium {{ page.path }}
            div
              dt.text-label-small.text-medium-emphasis Editor
              dd.text-body-medium {{ page.editor || '?' }}
            div
              dt.text-label-small.text-medium-emphasis Content Type
              dd.text-body-medium {{ page.contentType || '?' }}
            div
              dt.text-label-small.text-medium-emphasis Page Hash
              dd.text-body-medium {{ page.hash }}

      v-col(cols='12', lg='6')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-account-multiple
            span Users
          dl.admin-page-metadata
            div
              dt.text-label-small.text-medium-emphasis Creator
              dd.text-body-medium
                v-btn.pa-0(icon, variant='text', :to='`/users/` + page.creatorId', :aria-label='`View creator ` + page.creatorName')
                  v-icon(color='grey') mdi-account
                span {{ page.creatorName }}
                em.text-body-small.ml-1 ({{ page.creatorEmail }})
                small.text-body-small.text-medium-emphasis.ml-2 {{ $helpers.formatMoment(page.createdAt, 'calendar') }}
            div
              dt.text-label-small.text-medium-emphasis Last Editor
              dd.text-body-medium
                v-btn.pa-0(icon, variant='text', :to='`/users/` + page.authorId', :aria-label='`View last editor ` + page.authorName')
                  v-icon(color='grey') mdi-account
                span {{ page.authorName }}
                em.text-body-small.ml-1 ({{ page.authorEmail }})
                small.text-body-small.text-medium-emphasis.ml-2 {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
            div(v-if="page.visibility === 'private'")
              dt.text-label-small.text-medium-emphasis Private Owner
              dd.text-body-medium
                v-icon.mr-2(color='deep-orange') mdi-lock-account
                span User ID: {{ page.ownerId }}
    v-row.align-center(v-else)
      v-col(cols='12')
        async-state(
          v-if='loading'
          state='loading'
          title='Loading page details'
          message='Fetching the latest page information.'
        )
        async-state(
          v-else-if='errorMessage'
          state='error'
          title='Page details could not be loaded'
          :message='errorMessage'
          retry-label='Try again'
          @retry='loadPage'
        )

</template>
<script lang='ts'>
import AsyncState from '@/components/common/async-state.vue'
import { getErrorMessage } from '../../helpers/root-ui-store'
import _ from 'lodash'
import StatusIndicator from '@/components/common/status-indicator.vue'
import { deletePage as deletePageById, fetchPage, type PageDetails } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

export default {


  components: {
    AsyncState,
    StatusIndicator
  },
  data() {
    return {
      deletePageDialog: false,
      page: null as PageDetails | null,
      resolvedPageRouteId: null as number | null,
      loadGeneration: 0,
      loading: false,
      errorMessage: ''
    }
  },
  methods: {
    async loadPage () {
      const requestGeneration = ++this.loadGeneration
      const routePageId = _.toSafeInteger(this.$route.params.id)
      this.deletePageDialog = false
      this.page = null
      this.resolvedPageRouteId = null
      this.loading = true
      this.errorMessage = ''
      wikiStore.startLoading('admin-pages-refresh')
      try {
        const page = await fetchPage(
          window.fetch.bind(window),
          routePageId,
          this.$t('common:error.unexpected')
        )
        if (requestGeneration !== this.loadGeneration) {
          return
        }
        this.resolvedPageRouteId = routePageId
        this.page = page
      } catch (err) {
        if (requestGeneration !== this.loadGeneration) {
          return
        }
        this.errorMessage = getErrorMessage(err) || this.$t('common:error.unexpected')
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-pages-refresh')
        if (requestGeneration === this.loadGeneration) {
          this.loading = false
        }
      }
    },
    async deletePage() {
      const routePageId = _.toSafeInteger(this.$route.params.id)
      const requestGeneration = this.loadGeneration
      const page = this.page
      if (!page || this.resolvedPageRouteId !== routePageId) {
        return
      }

      this.loading = true
      wikiStore.startLoading('page-delete')
      try {
        await deletePageById(
          window.fetch.bind(window),
          page.id,
          page.sourceRevision,
          this.$t('common:error.unexpected')
        )
        if (
          requestGeneration !== this.loadGeneration ||
          routePageId !== _.toSafeInteger(this.$route.params.id)
        ) {
          return
        }
        this.deletePageDialog = false
        wikiStore.showNotification({
          style: 'green',
          message: `Page deleted successfully.`,
          icon: 'check'
        })
        this.$router.replace('/pages')
      } catch (err) {
        if (
          requestGeneration !== this.loadGeneration ||
          routePageId !== _.toSafeInteger(this.$route.params.id)
        ) {
          return
        }
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('page-delete')
        if (
          requestGeneration === this.loadGeneration &&
          routePageId === _.toSafeInteger(this.$route.params.id)
        ) {
          this.loading = false
        }
      }
    }
  },
  watch: {
    '$route.params.id' () {
      return this.loadPage()
    }
  },
  mounted () {
    this.loadPage()
  }
}
</script>

<style lang='scss' scoped>
.page-status-group,
.page-action-group {
  display: flex;
  align-items: center;
  gap: .75rem;
  flex-wrap: wrap;
}

.page-status {
  display: inline-flex;
  align-items: center;
  gap: .4rem;
  white-space: nowrap;
}

.admin-page-metadata {
  margin: 0;
  padding: .5rem 1rem;

  > div {
    display: grid;
    grid-template-columns: minmax(7rem, 30%) minmax(0, 1fr);
    gap: 1rem;
    padding: .75rem 0;
    border-bottom: 1px solid rgba(var(--v-border-color), .12);
  }

  > div:last-child { border-bottom: 0; }
  dt, dd { margin: 0; min-width: 0; }
  dd { overflow-wrap: anywhere; }
}

@media (max-width: 599.98px) {
  .page-action-group {
    flex-basis: 100%;
    justify-content: flex-end;
  }

  .admin-page-metadata > div {
    grid-template-columns: 1fr;
    gap: .25rem;
  }
}
</style>

