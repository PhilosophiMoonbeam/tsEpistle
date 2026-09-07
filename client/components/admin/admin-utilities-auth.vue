<template lang="pug">
v-card
  v-card-title Authentication cleanup
  v-card-subtitle Reviewed actions that change sign-in capability. Each action is recorded before it starts.
  v-card-text
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Regenerate certificates
          p.text-body-medium.mt-2 Replace the keys used to sign authentication tokens. This ends browser sessions, revokes stored API credentials and preserves the existing encryption root.
          v-alert.mt-3(color='error' variant='tonal' density='compact') This action ends your session after its receipt is recorded. You will be sent to sign in again, then returned to this receipt.
          v-btn.mt-4(color='error' variant='outlined' :disabled='busy' @click='openReview(`auth-certificates`)') Review certificate regeneration
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Reset guest access
          p.text-body-medium.mt-2 Restore the reserved Guest identity and assign it to the existing Guests group. That group’s current permissions and page-rule policy are not reset.
          v-btn.mt-4(color='warning' variant='outlined' :disabled='busy' @click='openReview(`auth-guest-reset`)') Review guest reset
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

type AuthKind = Extract<UtilityOperationKind, 'auth-certificates' | 'auth-guest-reset'>
type ReviewSnapshot = {
  kind: AuthKind
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
  emits: ['request', 'draft-state'],
  data: () => ({
    review: {
      open: false,
      kind: 'auth-certificates' as AuthKind,
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
    openReview(kind: AuthKind) {
      if (this.busy) return
      const snapshot: ReviewSnapshot =
        kind === 'auth-certificates'
          ? {
              kind,
              title: 'Review certificate regeneration',
              effect:
                'This replaces authentication signing keys, ends browser sessions and revokes stored API credentials. The encryption root is preserved and the request cannot be undone.',
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: 'Credential action', value: 'Replace authentication signing certificates' },
                { label: 'Browser sessions', value: 'End every signed-in browser session' },
                { label: 'Stored API credentials', value: 'Revoke every stored API credential' },
                { label: 'Encryption root', value: 'Preserved' }
              ],
              payload: {}
            }
          : {
              kind,
              title: 'Review guest reset',
              effect:
                'This restores the reserved Guest identity and assigns it to the existing Guests group. The group’s current permissions and page-rule policy are not reset.',
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: 'Guest identity', value: 'Restore and assign to the existing Guests group' },
                { label: 'Guests group policy', value: 'Preserve current permissions and page rules' }
              ],
              payload: {}
            }
      this.review = { ...snapshot, open: true }
      this.reviewError = ''
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
