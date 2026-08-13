<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', dark, dense)
      .subtitle-1 {{ $t('admin:utilities.contentTitle') }}
    v-card-text
      .subtitle-1.pb-3.primary--text Rebuild Page Tree
      .body-2 The virtual structure of your wiki is automatically inferred from all page paths. You can trigger a full rebuild of the tree if some virtual folders are missing or not valid anymore.
      v-btn(outlined, color='primary', @click='rebuildTree', :disabled='loading').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed

      v-divider.my-5

      .subtitle-1.pb-3.primary--text Rerender All Pages
      .body-2 All pages will be rendered again. Useful if internal links are broken or the rendering pipeline has changed.
      v-btn(outlined, color='primary', @click='rerenderPages', :disabled='loading', :loading='isRerendering').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed
      v-dialog(
        v-model='isRerendering'
        persistent
        max-width='450'
        )
        v-card(color='blue darken-2', dark)
          v-card-text.pa-10.text-center
            semipolar-spinner.animated.fadeIn(
              :animation-duration='1500'
              :size='65'
              color='#FFF'
              style='margin: 0 auto;'
            )
            .mt-5.body-1.white--text Rendering all pages...
            .caption(v-if='renderIndex > 0') Rendering {{renderCurrentPath}}... ({{renderIndex}}/{{renderTotal}}, {{renderProgress}}%)
            .caption.mt-4 Do not leave this page.
            v-progress-linear.mt-5(
              color='white'
              :value='renderProgress'
              stream
              rounded
              :buffer-value='0'
            )

      v-divider.my-5

      .subtitle-1.pb-3.pl-0.primary--text Migrate all pages to target locale
      .body-2 If you created content before selecting a different locale and activating the namespacing capabilities, you may want to transfer all content to the base locale.
      .body-2.red--text: strong This operation is destructive and cannot be reversed! Make sure you have proper backups!
      v-toolbar.radius-7.mt-5(flat, :color='$vuetify.theme.current.dark ? `grey darken-3-d5` : `grey lighten-4`', height='80')
        v-select(
          label='Source Locale'
          outlined
          hide-details
          :items='locales'
          item-title='name'
          item-value='code'
          v-model='sourceLocale'
        )
        v-icon.mx-3(large) mdi-chevron-right-box-outline
        v-select(
          label='Target Locale'
          outlined
          hide-details
          :items='locales'
          item-title='name'
          item-value='code'
          v-model='targetLocale'
        )
      .body-2.mt-5 Pages that are already in the target locale will not be touched. If a page already exists at the target, the source page will not be modified as it would create a conflict. If you want to overwrite the target page, you must first delete it.
      v-btn(outlined, color='primary', @click='migrateToLocale', :disabled='loading').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed

      v-divider.my-5

      .subtitle-1.pb-3.pl-0.primary--text Purge Page History
      .body-2 You may want to purge old history for pages to reduce database usage.
      .body-2 This operation only affects the database and not any history saved by a storage module (e.g. git version history)
      v-toolbar.radius-7.mt-5(flat, :color='$vuetify.theme.current.dark ? `grey darken-3-d5` : `grey lighten-4`', height='80')
        v-select(
          label='Delete history older than...'
          outlined
          hide-details
          :items='purgeHistoryOptions'
          item-title='title'
          item-value='key'
          v-model='purgeHistorySelection'
        )
      v-btn(outlined, color='primary', @click='purgeHistory', :disabled='loading').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { fetchPageList } from '../../helpers/pages-api'
import { wikiStore } from '@/store/index.ts'
import { migratePagesToLocale, purgePageHistory, rebuildPageTree, renderPage } from '../../helpers/system-api'

import { SemipolarSpinner } from 'epic-spinners'

/* global siteLangs, siteConfig */

export default defineComponent({
  components: {
    SemipolarSpinner
  },
  data: () => {
    return {
      isRerendering: false,
      loading: false,
      renderProgress: 0,
      renderIndex: 0,
      renderTotal: 0,
      renderCurrentPath: '',
      sourceLocale: '',
      targetLocale: '',
      purgeHistorySelection: 'P1Y',
      purgeHistoryOptions: [
        { key: 'P1D', title: 'Today' },
        { key: 'P1M', title: '1 month' },
        { key: 'P3M', title: '3 months' },
        { key: 'P6M', title: '6 months' },
        { key: 'P1Y', title: '1 year' },
        { key: 'P2Y', title: '2 years' },
        { key: 'P3Y', title: '3 years' },
        { key: 'P5Y', title: '5 years' }
      ]
    }
  },
  computed: {
    currentLocale () {
      return siteConfig.lang
    },
    locales () {
      return siteLangs
    }
  },
  methods: {
    async rebuildTree () {
      this.loading = true
      wikiStore.startLoading('admin-utilities-content-rebuildtree')

      try {
        await rebuildPageTree(window.fetch.bind(window))
        wikiStore.showNotification({
          message: 'Page Tree rebuilt successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-content-rebuildtree')
      this.loading = false
    },
    async rerenderPages () {
      this.loading = true
      this.isRerendering = true
      wikiStore.startLoading('admin-utilities-content-rerender')

      try {
        const pages = await fetchPageList(window.fetch.bind(window))
        if (pages.length < 1) {
          throw new Error('Could not find any page to render!')
        }

        this.renderIndex = 0
        this.renderTotal = pages.length
        let failed = 0
        for (const page of pages) {
          this.renderCurrentPath = `${page.locale}/${page.path}`
          this.renderIndex++
          this.renderProgress = Math.round(this.renderIndex / this.renderTotal * 100)
          try {
            await renderPage(window.fetch.bind(window), page.id)
          } catch (err) {
            failed++
          }
        }
        if (failed > 0) {
          wikiStore.showNotification({
            message: `Completed with ${failed} pages that failed to render. Check server logs for details.`,
            style: 'error',
            icon: 'alert'
          })
        } else {
          wikiStore.showNotification({
            message: 'All pages have been rendered successfully.',
            style: 'success',
            icon: 'check'
          })
        }
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-content-rerender')
      this.isRerendering = false
      this.loading = false
    },
    async migrateToLocale () {
      this.loading = true
      wikiStore.startLoading('admin-utilities-content-migratelocale')

      try {
        const resp = await migratePagesToLocale(window.fetch.bind(window), this.sourceLocale, this.targetLocale)
        wikiStore.showNotification({
          message: `Migrated ${resp.count} page(s) to target locale successfully.`,
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-content-migratelocale')
      this.loading = false
    },
    async purgeHistory () {
      this.loading = true
      wikiStore.startLoading('admin-utilities-content-purgehistory')

      try {
        await purgePageHistory(window.fetch.bind(window), this.purgeHistorySelection)
        wikiStore.showNotification({
          message: `Purged history successfully.`,
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-content-purgehistory')
      this.loading = false
    }
  }
})
</script>

<style lang='scss'>

</style>
