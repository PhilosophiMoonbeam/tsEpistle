<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.contentTitle') }}
    v-card-text
      .text-body-large.pb-3.text-primary Rebuild Page Tree
      .text-body-medium The virtual structure of your wiki is automatically inferred from all page paths. You can trigger a full rebuild of the tree if some virtual folders are missing or not valid anymore.
      v-btn(variant="outlined", color='primary', @click='rebuildTree', :disabled='loading', :loading='loading && activeAction === "rebuild"').ml-0.mt-3
        v-icon(start) mdi-file-tree
        span Rebuild Page Tree

      v-divider.my-5

      .text-body-large.pb-3.text-primary Rerender All Pages
      .text-body-medium All pages will be rendered again. Useful if internal links are broken or the rendering pipeline has changed.
      v-btn(variant="outlined", color='primary', @click='rerenderPages', :disabled='loading', :loading='isRerendering').ml-0.mt-3
        v-icon(start) mdi-refresh
        span Rerender All Pages
      v-dialog(
        v-model='isRerendering'
        persistent
        max-width='450'
        )
        v-card(color="blue-darken-2" role="dialog" aria-labelledby="rerender-dialog-title")
          v-card-text.pa-10.text-center
            semipolar-spinner.animated.fadeIn(
              :animation-duration='1500'
              :size='65'
              color='#FFF'
              style='margin: 0 auto;'
              aria-hidden='true'
            )
            .mt-5.text-body-large.text-white#rerender-dialog-title Rerendering all pages...
            .text-body-small(role="status" aria-live="polite" v-if='renderIndex > 0') Rendering {{renderCurrentPath}}... ({{renderIndex}}/{{renderTotal}}, {{renderProgress}}%)
            .text-body-small.mt-4 Do not leave this page.
            v-progress-linear.mt-5(
              color='white'
              :model-value='renderProgress'
              stream
              rounded
              :buffer-value='0'
              aria-label='Rerender progress'
              :aria-valuetext='`${renderProgress}% complete`'
            )

      v-divider.my-5

      .text-body-large.pb-3.pl-0.text-primary Migrate all pages to target locale
      .text-body-medium Move eligible pages from the source locale into the target locale. Existing target pages are not overwritten.
      .text-body-medium.text-error: strong This operation is destructive and cannot be reversed! Make sure you have proper backups!
      v-row.mt-5.align-center
        v-col(cols='12', sm='5')
          v-select(
            label='Source Locale'
            variant="outlined"
            :items='locales'
            item-title='name'
            item-value='code'
            v-model='sourceLocale'
            :disabled='loading || locales.length < 2'
            :error-messages='migrationLocaleError'
          )
        v-col.d-none.d-sm-flex(cols='auto')
          v-icon(size="large", aria-hidden='true') mdi-chevron-right-box-outline
        v-col(cols='12', sm='5')
          v-select(
            label='Target Locale'
            variant="outlined"
            :items='locales'
            item-title='name'
            item-value='code'
            v-model='targetLocale'
            :disabled='loading || locales.length < 2'
            :error-messages='migrationLocaleError'
          )
      .text-body-medium.mt-2(v-if='migrationLocaleError') {{ migrationLocaleError }}
      v-btn(variant="outlined", color='error', @click='requestMigration', :disabled='loading || !isMigrationValid', :loading='loading && activeAction === "migrate"').ml-0.mt-3
        v-icon(start) mdi-database-export
        span Review Migration

      v-divider.my-5

      .text-body-large.pb-3.pl-0.text-primary Purge Page History
      .text-body-medium You may want to purge old history for pages to reduce database usage.
      .text-body-medium This operation only affects the database and not any history saved by a storage module (e.g. git version history)
      v-row.mt-5
        v-col(cols='12', sm='6', md='5')
          v-select(
            label='Delete history older than...'
            variant="outlined"
            :items='purgeHistoryOptions'
            item-title='title'
            item-value='key'
            v-model='purgeHistorySelection'
            :disabled='loading'
          )
      v-btn(variant="outlined", color='error', @click='requestPurge', :disabled='loading || !purgeHistorySelection', :loading='loading && activeAction === `purge`').ml-0.mt-3
        v-icon(start) mdi-delete-clock
        span Review Purge
      v-dialog(v-model='isConfirmShown', persistent, max-width='520')
        v-card(role="dialog" aria-labelledby="content-confirm-title")
          v-card-title#content-confirm-title Confirm destructive operation
          v-card-text
            .text-body-medium(v-if='pendingConfirmation === `migrate`') This will migrate all eligible pages from {{ sourceLocale }} to {{ targetLocale }}. Existing target pages are not overwritten.
            .text-body-medium(v-else) This will permanently delete page history older than {{ selectedPurgeTitle }} from the database. Storage-module history is not affected.
            .text-body-medium.mt-3.text-error This action cannot be undone.
          v-card-actions
            v-spacer
            v-btn(variant="text", @click='cancelConfirmation', :disabled='loading') Cancel
            v-btn(color='error', variant="flat", @click='confirmDestructiveAction', :loading='loading') {{ pendingConfirmation === `migrate` ? 'Migrate Pages' : 'Purge History' }}</template>


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
      isConfirmShown: false,
      pendingConfirmation: '' as '' | 'migrate' | 'purge',
      activeAction: '' as '' | 'rebuild' | 'rerender' | 'migrate' | 'purge',
      loading: false,
      renderProgress: 0,
      renderIndex: 0,
      renderTotal: 0,
      renderCurrentPath: '',
      sourceLocale: '',
      targetLocale: '',
      purgeHistorySelection: 'P1Y',
      purgeHistoryOptions: [
        { key: 'P1D', title: '1 day' },
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
    },
    isMigrationValid () {
      return Boolean(this.sourceLocale && this.targetLocale && this.sourceLocale !== this.targetLocale)
    },
    migrationLocaleError () {
      if (!this.sourceLocale || !this.targetLocale) {
        return 'Select both a source and target locale.'
      }
      if (this.sourceLocale === this.targetLocale) {
        return 'Source and target locales must be different.'
      }
      return ''
    },
    selectedPurgeTitle () {
      return this.purgeHistoryOptions.find(option => option.key === this.purgeHistorySelection)?.title || this.purgeHistorySelection
    }
  },
  methods: {
    requestMigration () {
      if (this.isMigrationValid) {
        this.pendingConfirmation = 'migrate'
        this.isConfirmShown = true
      }
    },
    requestPurge () {
      if (this.purgeHistorySelection) {
        this.pendingConfirmation = 'purge'
        this.isConfirmShown = true
      }
    },
    cancelConfirmation () {
      if (!this.loading) {
        this.isConfirmShown = false
        this.pendingConfirmation = ''
      }
    },
    async confirmDestructiveAction () {
      if (this.loading) {
        return
      }
      const action = this.pendingConfirmation
      this.isConfirmShown = false
      this.pendingConfirmation = ''
      if (action === 'migrate') {
        await this.migrateToLocale()
      } else if (action === 'purge') {
        await this.purgeHistory()
      }
    },
    async rebuildTree () {
      this.loading = true
      this.activeAction = 'rebuild'
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
      } finally {
        wikiStore.stopLoading('admin-utilities-content-rebuildtree')
        this.loading = false
        this.activeAction = ''
      }
    },
    async rerenderPages () {
      this.loading = true
      this.activeAction = 'rerender'
      this.isRerendering = true
      wikiStore.startLoading('admin-utilities-content-rerender')
      try {
        const pages = await fetchPageList(window.fetch.bind(window))
        if (pages.length < 1) {
          throw new Error('Could not find any page to render!')
        }

        this.renderIndex = 0
        this.renderProgress = 0
        this.renderTotal = pages.length
        let failed = 0
        for (const page of pages) {
          this.renderCurrentPath = `${page.locale}/${page.path}`
          try {
            await renderPage(window.fetch.bind(window), page.id)
          } catch (err) {
            failed++
          } finally {
            this.renderIndex++
            this.renderProgress = Math.round(this.renderIndex / this.renderTotal * 100)
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
      } finally {
        wikiStore.stopLoading('admin-utilities-content-rerender')
        this.isRerendering = false
        this.loading = false
        this.activeAction = ''
      }
    },
    async migrateToLocale () {
      if (!this.isMigrationValid) {
        return
      }
      this.loading = true
      this.activeAction = 'migrate'
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
      } finally {
        wikiStore.stopLoading('admin-utilities-content-migratelocale')
        this.loading = false
        this.activeAction = ''
      }
    },
    async purgeHistory () {
      if (!this.purgeHistorySelection) {
        return
      }
      this.loading = true
      this.activeAction = 'purge'
      wikiStore.startLoading('admin-utilities-content-purgehistory')
      try {
        await purgePageHistory(window.fetch.bind(window), this.purgeHistorySelection)
        wikiStore.showNotification({
          message: 'Purged history successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-utilities-content-purgehistory')
        this.loading = false
        this.activeAction = ''
      }
    }
  }

})
</script>
<style lang='scss'>

</style>
