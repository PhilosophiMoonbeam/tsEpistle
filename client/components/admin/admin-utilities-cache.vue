<template lang="pug">
v-card
  v-card-title Cache maintenance
  v-card-subtitle Clear a specific cache only when a cached result is the diagnosed problem.
  v-card-text
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Pages and assets
          p.text-body-medium.mt-2 Drop the local page and asset cache, then notify connected application processes to refresh their cache.
          v-btn.mt-4(color='primary' variant='outlined' :disabled='busy' @click='openReview(`cache-pages`)') Review cache flush
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Temporary uploads
          p.text-body-medium.mt-2 Delete temporary upload files. An upload that is still in progress can fail after this action.
          v-alert.mt-3(color='warning' variant='tonal' density='compact') Confirm there are no active uploads before continuing.
          v-btn.mt-4(color='error' variant='outlined' :disabled='busy' @click='openReview(`cache-temporary-uploads`)') Review deletion
    v-divider.my-6
    v-sheet.pa-4.rounded.border
      h2.text-title-medium This browser’s locale cache
      p.text-body-medium.mt-2 Locale strings cached by this browser are separate from server cache and are not sent to the server.
      v-btn.mt-3(variant='outlined' :disabled='busy' @click='clearLocaleCache') Clear this browser cache
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
              title: 'Review cache flush',
              effect: 'This clears shared in-process page and asset caches. It does not change pages or assets.',
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: 'Cache', value: 'Pages and assets' },
                { label: 'Effect', value: 'Clear shared in-process cache' }
              ],
              payload: {}
            }
          : {
              kind,
              title: 'Review temporary-upload deletion',
              effect: 'This permanently deletes temporary upload files. Active uploads can fail.',
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: 'Cache', value: 'Temporary uploads' },
                { label: 'Effect', value: 'Permanently delete temporary upload files' }
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
        this.$emit('notice', { message: 'This browser’s locale cache was cleared.', color: 'success' })
      } catch {
        this.$emit('notice', {
          message: 'This browser blocked access to its locale cache. No cache-cleared result can be confirmed.',
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
