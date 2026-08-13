<template lang='pug'>
  v-card
    v-toolbar(flat, color='primary', dark, dense)
      .subtitle-1 {{ $t('admin:utilities.cacheTitle') }}
    v-card-text
      .subtitle-1.pb-3.primary--text Flush Pages and Assets Cache
      .body-2 Pages and Assets are cached to disk for better performance. You can flush the cache to force all content to be fetched from the DB again.
      v-btn(outlined, color='primary', @click='flushCache', :disabled='loading').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed
      v-divider.my-5
      .subtitle-1.pb-3.primary--text Flush Temporary Uploads
      .body-2 New uploads are temporarily saved to disk while they are being processed. They are automatically deleted after processing, but you can force an immediate cleanup using this tool.
      .body-2.red--text Note that performing this action while an upload is in progress can result in a failed upload.
      v-btn(outlined, color='primary', @click='flushUploads', :disabled='loading').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed
      v-divider.my-5
      .subtitle-1.pb-3.primary--text Flush Client-Side Locale Cache
      .body-2 Locale strings are cached in the browser local storage for 24h. You can delete your current cache in order to fetch the latest data during the next page load.
      .body-2 Note that this affects only #[strong your own browser] and not everyone.
      v-btn(outlined, color='primary', @click='flushClientLocaleCache', :disabled='loading').ml-0.mt-3
        v-icon(left) mdi-gesture-double-tap
        span Proceed
</template>

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
