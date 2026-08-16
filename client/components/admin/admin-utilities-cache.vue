<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', density="compact")
      .text-body-large {{ $t('admin:utilities.cacheTitle') }}
    v-card-text
      .text-body-large.pb-3.text-primary Flush Pages and Assets Cache
      .text-body-medium Pages and Assets are cached to disk for better performance. You can flush the cache to force all content to be fetched from the DB again.
      v-btn(variant="outlined", color='primary', @click='flushCache', :disabled='loading').ml-0.mt-3
        v-icon(start) mdi-gesture-double-tap
        span Proceed
      v-divider.my-5
      .text-body-large.pb-3.text-primary Flush Temporary Uploads
      .text-body-medium New uploads are temporarily saved to disk while they are being processed. They are automatically deleted after processing, but you can force an immediate cleanup using this tool.
      .text-body-medium.text-red Note that performing this action while an upload is in progress can result in a failed upload.
      v-btn(variant="outlined", color='primary', @click='flushUploads', :disabled='loading').ml-0.mt-3
        v-icon(start) mdi-gesture-double-tap
        span Proceed
      v-divider.my-5
      .text-body-large.pb-3.text-primary Flush Client-Side Locale Cache
      .text-body-medium Locale strings are cached in the browser local storage for 24h. You can delete your current cache in order to fetch the latest data during the next page load.
      .text-body-medium Note that this affects only #[strong your own browser] and not everyone.
      v-btn(variant="outlined", color='primary', @click='flushClientLocaleCache', :disabled='loading').ml-0.mt-3
        v-icon(start) mdi-gesture-double-tap
        span Proceed</template>

<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import { flushSystemCache, flushSystemTemporaryUploads } from '../../helpers/system-api'

export default defineComponent({
  data() {
    return {
      loading: false
    }
  },
  methods: {
    async flushCache() {
      this.loading = true
      wikiStore.startLoading('admin-utilities-cache-flushCache')

      try {
        await flushSystemCache(window.fetch.bind(window))
        wikiStore.showNotification({
          message: 'Cache flushed successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-cache-flushCache')
      this.loading = false
    },
    async flushUploads() {
      this.loading = true
      wikiStore.startLoading('admin-utilities-cache-flushUploads')

      try {
        await flushSystemTemporaryUploads(window.fetch.bind(window))
        wikiStore.showNotification({
          message: 'Temporary Uploads flushed successfully.',
          style: 'success',
          icon: 'check'
        })
      } catch (err) {
        wikiStore.showError(err)
      }

      wikiStore.stopLoading('admin-utilities-cache-flushUploads')
      this.loading = false
    },
    async flushClientLocaleCache () {
      for (let i = 0; i < window.localStorage.length; i++) {
        const lsKey = window.localStorage.key(i)
        if (lsKey?.startsWith('i18next_res')) {
          window.localStorage.removeItem(lsKey)
        }
      }
      wikiStore.showNotification({
        message: 'Locale Client-Side Cache flushed successfully.',
        style: 'success',
        icon: 'check'
      })
    }
  }
})
</script>

<style lang='scss'>

</style>
