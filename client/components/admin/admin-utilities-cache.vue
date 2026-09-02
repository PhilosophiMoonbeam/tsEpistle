<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.cacheTitle') }}
    v-card-text
      .text-body-large.pb-3.text-primary Flush Pages and Assets Cache
      .text-body-medium Pages and Assets are cached to disk for better performance. You can flush the cache to force all content to be fetched from the DB again.
      v-btn(variant="outlined", color='primary', @click='flushCache', :loading='activeOperation === "cache"', :disabled='loading && activeOperation !== "cache"').ml-0.mt-3
        v-icon(start) mdi-cached
        span Flush pages and assets cache
      v-divider.my-5
      .text-body-large.pb-3.text-primary Flush Temporary Uploads
      v-alert.mb-3(variant="outlined", color='warning', icon='mdi-alert')
        .text-body-medium Deleting temporary uploads during an in-progress upload can cause that upload to fail.
      v-btn(variant="outlined", color='error', @click='confirmationDialog = true', :loading='activeOperation === "uploads"', :disabled='loading && activeOperation !== "uploads"').ml-0.mt-3
        v-icon(start) mdi-delete-sweep
        span Delete temporary uploads
      v-divider.my-5
      .text-body-large.pb-3.text-primary Flush Client-Side Locale Cache
      .text-body-medium Locale strings are cached in the browser local storage for 24h. You can delete your current cache in order to fetch the latest data during the next page load.
      .text-body-medium Note that this affects only #[strong your own browser] and not everyone.
      v-btn(variant="outlined", color='primary', @click='flushClientLocaleCache', :loading='activeOperation === "locale"', :disabled='loading && activeOperation !== "locale"').ml-0.mt-3
        v-icon(start) mdi-translate
        span Clear this browser's locale cache
    v-dialog(v-model='confirmationDialog', max-width='520', persistent, aria-labelledby='temporary-uploads-confirmation-title', aria-describedby='temporary-uploads-confirmation-description')
      v-card
        v-card-title.text-wrap#temporary-uploads-confirmation-title Delete temporary uploads?
        v-card-text#temporary-uploads-confirmation-description Deleting temporary files while an upload is in progress can cause that upload to fail. Continue only if no uploads are currently being processed.
        v-card-actions
          v-btn(variant="text", @click='confirmationDialog = false', :disabled='loading') Cancel
          v-spacer
          v-btn(color='error', @click='confirmationDialog = false; flushUploads()', :loading='activeOperation === "uploads"') Delete temporary uploads
</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { flushSystemCache, flushSystemTemporaryUploads } from '../../helpers/system-api'

type CacheOperation = '' | 'cache' | 'uploads' | 'locale'

export default defineComponent({
  data() {
    return {
      loading: false,
      activeOperation: '' as CacheOperation,
      confirmationDialog: false
    }
  },
  methods: {
    async flushCache () {
      if (this.loading) return
      this.loading = true
      this.activeOperation = 'cache'
      wikiStore.startLoading('admin-utilities-cache-flushCache')
      try {
        await flushSystemCache(window.fetch.bind(window))
        wikiStore.showNotification({ message: 'Pages and assets cache flushed successfully.', style: 'success', icon: 'check' })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-utilities-cache-flushCache')
        this.loading = false
        this.activeOperation = ''
      }
    },
    async flushUploads () {
      if (this.loading) return
      this.loading = true
      this.activeOperation = 'uploads'
      wikiStore.startLoading('admin-utilities-cache-flushUploads')
      try {
        await flushSystemTemporaryUploads(window.fetch.bind(window))
        wikiStore.showNotification({ message: 'Temporary uploads deleted successfully.', style: 'success', icon: 'check' })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        wikiStore.stopLoading('admin-utilities-cache-flushUploads')
        this.loading = false
        this.activeOperation = ''
      }
    },
    flushClientLocaleCache () {
      if (this.loading) return
      this.loading = true
      this.activeOperation = 'locale'
      try {
        const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
          .filter((key): key is string => key?.startsWith('i18next_res') === true)
        keys.forEach(key => window.localStorage.removeItem(key))
        wikiStore.showNotification({
          message: 'This browser’s locale cache was cleared successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      } finally {
        this.loading = false
        this.activeOperation = ''
      }
    }
  }
})
</script>
