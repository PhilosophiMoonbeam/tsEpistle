<template lang='pug'>
  v-container(fluid)
    v-row(v-if='page')
      v-col(cols='12')
        .admin-header
          img.animated.fadeInUp(src='/_assets/svg/icon-view-details.svg', alt='Edit Page', style='width: 80px;')
          .admin-header-title
            .text-headline-medium.text-primary.animated.fadeInLeft Page Details
            .text-body-large.text-medium-emphasis.animated.fadeInLeft.wait-p2s
              v-chip.ml-0.mr-2(label, size="small").text-body-small ID {{page.id}}
              span /{{page.locale}}/{{page.path}}
          v-spacer
          template(v-if='page.isPublished')
            status-indicator.mr-3(positive, pulse)
            .text-body-small.text-green {{$t('common:page.published')}}
          template(v-else)
            status-indicator.mr-3(negative, pulse)
            .text-body-small.text-red {{$t('common:page.unpublished')}}
          template(v-if="page.visibility === 'private'")
            status-indicator.mr-3.ml-4(intermediary, pulse)
            .text-body-small.text-deep-orange {{$t('common:page.private')}}
          template(v-else)
            status-indicator.mr-3.ml-4(active, pulse)
            .text-body-small.text-blue {{$t('common:page.global')}}
          v-spacer
          v-btn.animated.fadeInDown.wait-p3s(color='grey', icon, variant="outlined", to='/pages')
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
              //- v-list-item(@click='', disabled)
              //-   template(v-slot:prepend)
              //-     v-icon(color='grey') mdi-cube-scan
              //-   v-list-item-title Re-Render
              //- v-list-item(@click='', disabled)
              //-   template(v-slot:prepend)
              //-     v-icon(color='grey') mdi-earth-remove
              //-   v-list-item-title Unpublish
              v-list-item(:href='`/s` + (page.visibility === `private` ? `/_private` : ``) + `/` + page.locale + `/` + page.path')
                template(v-slot:prepend)
                  v-icon(color='indigo') mdi-code-tags
                v-list-item-title View Source
              v-list-item(:href='`/h` + (page.visibility === `private` ? `/_private` : ``) + `/` + page.locale + `/` + page.path')
                template(v-slot:prepend)
                  v-icon(color='indigo') mdi-history
                v-list-item-title View History
              //- v-list-item(@click='', disabled)
              //-   template(v-slot:prepend)
              //-     v-icon(color='grey') mdi-content-duplicate
              //-   v-list-item-title Duplicate
              //- v-list-item(@click='', disabled)
              //-   template(v-slot:prepend)
              //-     v-icon(color='grey') mdi-content-save-move-outline
              //-   v-list-item-title Move / Rename
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
                    v-chip.mt-3.ml-0.mr-1(label, color="red-lighten-4", disabled, size="small")
                      .text-body-small.text-red-darken-2 {{page.locale.toUpperCase()}}
                    v-chip.mt-3.mx-0(label, color="red-lighten-5", disabled, size="small")
                      span.text-red-darken-2 /{{page.path}}
                  div.v-card-chin
                    v-spacer
                    v-btn(variant="text", @click='deletePageDialog = false', :disabled='loading') {{$t('common:actions.cancel')}}
                    v-btn(color="red-darken-2", @click='deletePage', :loading='loading').text-white {{$t('common:actions.delete')}}
          v-btn.animated.fadeInDown(color='success', size="large", variant="flat", disabled)
            v-icon(start) mdi-check
            span Save Changes
      v-col(cols='12', lg='6')
        v-card.animated.fadeInUp
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-text-subject
            span Properties
          v-list.py-0(lines="two", density="compact")
            v-list-item
              v-list-item-title: .text-label-small.text-grey Title
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.title }}
            v-divider
            v-list-item
              v-list-item-title: .text-label-small.text-grey Description
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.description || '-' }}
            v-divider
            v-list-item
              v-list-item-title: .text-label-small.text-grey Locale
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.locale }}
            v-divider
            v-list-item
              v-list-item-title: .text-label-small.text-grey Path
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.path }}
            v-divider
            v-list-item
              v-list-item-title: .text-label-small.text-grey Editor
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.editor || '?' }}
            v-divider
            v-list-item
              v-list-item-title: .text-label-small.text-grey Content Type
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.contentType || '?' }}
            v-divider
            v-list-item
              v-list-item-title: .text-label-small.text-grey Page Hash
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.hash }}

      v-col(cols='12', lg='6')
        v-card.animated.fadeInUp.wait-p2s
          v-toolbar(color='primary', density="compact", flat)
            v-icon.mr-2 mdi-account-multiple
            span Users
          v-list.py-0(lines="two", density="compact")
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='24')
                  v-btn(icon, :to='`/users/` + page.creatorId')
                    v-icon(color='grey') mdi-account
              v-list-item-title: .text-label-small.text-grey Creator
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.creatorName }} #[em.text-body-small ({{ page.creatorEmail }})]
              template(v-slot:append)
                span.text-body-small {{ $helpers.formatMoment(page.createdAt, 'calendar') }}
            v-divider
            v-list-item
              template(v-slot:prepend)
                v-avatar(size='24')
                  v-btn(icon, :to='`/users/` + page.authorId')
                    v-icon(color='grey') mdi-account
              v-list-item-title: .text-label-small.text-grey Last Editor
              v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') {{ page.authorName }} #[em.text-body-small ({{ page.authorEmail }})]
              template(v-slot:append)
                span.text-body-small {{ $helpers.formatMoment(page.updatedAt, 'calendar') }}
            template(v-if="page.visibility === 'private'")
              v-divider
              v-list-item
                template(v-slot:prepend)
                  v-avatar(size='24')
                    v-icon(color='deep-orange') mdi-lock-account
                v-list-item-title: .text-label-small.text-grey Private Owner
                v-list-item-subtitle.text-body-medium(:class='$vuetify.theme.current.dark ? `text-grey-lighten-2` : `text-grey-darken-3`') User ID: {{ page.ownerId }}

    v-row.align-center(v-else)
      v-progress-circular(indeterminate, width='2', color='grey', :aria-label='$t(`common:page.loading`)')
      .text-body-medium.pl-3.text-grey {{ $t('common:page.loading') }}
</template>
<script lang='ts'>
import _ from 'lodash'
import StatusIndicator from '@/components/common/status-indicator.vue'

import { deletePage as deletePageById, fetchPage, type PageDetails } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'

export default {
  components: {
    StatusIndicator
  },
  data() {
    return {
      deletePageDialog: false,
      page: null as PageDetails | null,
      loading: false
    }
  },
  methods: {
    async loadPage () {
      this.loading = true
      wikiStore.startLoading('admin-pages-refresh')
      try {
        this.page = await fetchPage(
          window.fetch.bind(window),
          _.toSafeInteger(this.$route.params.id),
          this.$t('common:error.unexpected')
        )
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('admin-pages-refresh')
      this.loading = false
    },
    async deletePage() {
      const page = this.page
      if (!page) {
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
        wikiStore.showNotification({
          style: 'green',
          message: `Page deleted successfully.`,
          icon: 'check'
        })
        this.$router.replace('/pages')
      } catch (err) {
        wikiStore.showError(err)
      }
      wikiStore.stopLoading('page-delete')
    }
  },
  mounted () {
    this.loadPage()
  }
}
</script>

<style lang='scss'>

</style>
