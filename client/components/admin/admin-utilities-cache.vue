<template lang="pug">
v-card
  v-card-title {{ $t(`admin:utilitiesCache.cacheMaintenance`) }}
  v-card-subtitle {{ $t(`admin:utilitiesCache.clearSpecificCacheOnly`) }}
  v-card-text
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesCache.pagesAssets`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesCache.dropLocalPageAsset`) }}
          v-btn.mt-4(color='primary' variant='outlined' :disabled='busy' @click='openReview(`cache-pages`)') {{ $t(`admin:utilitiesCache.reviewCacheFlush`) }}
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesCache.temporaryUploads`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesCache.deleteTemporaryUploadFiles`) }}
          v-alert.mt-3(color='warning' variant='tonal' density='compact') {{ $t(`admin:utilitiesCache.confirmThereNoActive`) }}
          v-btn.mt-4(color='error' variant='outlined' :disabled='busy' @click='openReview(`cache-temporary-uploads`)') {{ $t(`admin:utilitiesCache.reviewDeletion`) }}
    v-divider.my-6
    v-sheet.pa-4.rounded.border
      h2.text-title-medium {{ $t(`admin:utilitiesCache.browsersLocaleCache`) }}
      p.text-body-medium.mt-2 {{ $t(`admin:utilitiesCache.localeStringsCachedBrowser`) }}
      v-btn.mt-3(variant='outlined' :disabled='busy' @click='clearLocaleCache') {{ $t(`admin:utilitiesCache.clearBrowserCache`) }}
  utility-review(
    v-model:open='review.open'
    :title='review.title'
    :effect='review.effect'
    :confirm-text='review.confirmation'
    :parameters='review.parameters'
    :submission-error='reviewError'
    :busy='busy'
    :uncertain-receipt='uncertainReceipt'
    @dirty-state='setReviewDirty'
    @confirm='submit'
  )
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  utilityOperationConfirmation,
  type UtilitiesWorkspace,
  type UtilityOperation,
  type UtilityOperationKind
} from '../../../shared/utilities-workspace.ts'
import UtilityReview from './admin-utilities-review.vue'

type CacheKind = Extract<UtilityOperationKind, 'cache-pages' | 'cache-temporary-uploads'>
type ReviewSnapshot = {
  kind: CacheKind
  title: string
  effect: string
  confirmation: string
  parameters: Array<{ label: string; value: string }>
  payload: Record<string, never>
}

export default defineComponent({
  components: { UtilityReview },
  props: {
    workspace: { type: Object as PropType<UtilitiesWorkspace>, required: true },
    busy: { type: Boolean, default: false },
    uncertainReceipt: { type: Object as PropType<UtilityOperation | null>, default: null }
  },
  emits: ['notice', 'request', 'draft-state'],
  data: () => ({
    review: {
      open: false,
      kind: 'cache-pages' as CacheKind,
      title: '',
      effect: '',
      confirmation: '',
      parameters: [] as Array<{ label: string; value: string }>,
      payload: {} as Record<string, never>
    },
    reviewError: '',
    reviewDirty: false
  }),
  methods: {
    openReview(kind: CacheKind) {
      if (this.busy) return
      const snapshot: ReviewSnapshot =
        kind === 'cache-pages'
          ? {
              kind,
              title: this.$t('admin:utilitiesCache.reviewCacheFlush'),
              effect: this.$t('admin:utilitiesCache.clearsSharedProcessPage'),
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: this.$t('admin:utilitiesCache.cache'), value: this.$t('admin:utilitiesCache.pagesAssets') },
                { label: this.$t('admin:utilitiesCache.effect'), value: this.$t('admin:utilitiesCache.clearSharedProcessCache') }
              ],
              payload: {}
            }
          : {
              kind,
              title: this.$t('admin:utilitiesCache.reviewTemporaryUploadDeletion'),
              effect: this.$t('admin:utilitiesCache.permanentlyDeletesTemporaryUpload'),
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: this.$t('admin:utilitiesCache.cache'), value: this.$t('admin:utilitiesCache.temporaryUploads') },
                { label: this.$t('admin:utilitiesCache.effect'), value: this.$t('admin:utilitiesCache.permanentlyDeleteTemporaryUpload') }
              ],
              payload: {}
            }
      this.review = { ...snapshot, open: true }
      this.reviewError = ''
    },
    clearLocaleCache() {
      try {
        const storage = window.localStorage
        const keys: string[] = []
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (key?.startsWith('i18next_res') === true) keys.push(key)
        }
        for (const key of keys) storage.removeItem(key)
        this.$emit('notice', { message: this.$t('admin:utilitiesCache.browsersLocaleCacheWas'), color: 'success' })
      } catch {
        this.$emit('notice', {
          message: this.$t('admin:utilitiesCache.browserBlockedAccessLocale'),
          color: 'warning'
        })
      }
    },
    setReviewDirty(dirty: boolean) {
      this.reviewDirty = dirty
      this.$emit('draft-state', dirty)
    },
    submit({ reason, acknowledgedUncertainId }: { reason: string; acknowledgedUncertainId?: string }) {
      const snapshot = this.review
      if (!snapshot.open || this.busy) return
      this.$emit('request', {
        kind: snapshot.kind,
        reason,
        acknowledgedUncertainId,
        payload: snapshot.payload,
        onRecorded: () => {
          this.review.open = false
          this.reviewError = ''
          this.setReviewDirty(false)
        },
        onRejected: (message: string) => {
          this.reviewError = message
        }
      })
    }
  }
})
</script>
