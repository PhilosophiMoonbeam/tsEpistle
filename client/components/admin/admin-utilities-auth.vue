<template lang="pug">
v-card
  v-card-title {{ $t(`admin:utilitiesAuth.authenticationCleanup`) }}
  v-card-subtitle {{ $t(`admin:utilitiesAuth.reviewedActionsChangeSign`) }}
  v-card-text
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesAuth.regenerateCertificates`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesAuth.replaceKeysUsedSign`) }}
          v-alert.mt-3(color='error' variant='tonal' density='compact') {{ $t(`admin:utilitiesAuth.actionEndsSessionAfter`) }}
          v-btn.mt-4(color='error' variant='outlined' :disabled='busy' @click='openReview(`auth-certificates`)') {{ $t(`admin:utilitiesAuth.reviewCertificateRegeneration`) }}
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesAuth.resetGuestAccess`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesAuth.restoreReservedGuestIdentity`) }}
          v-btn.mt-4(color='warning' variant='outlined' :disabled='busy' @click='openReview(`auth-guest-reset`)') {{ $t(`admin:utilitiesAuth.reviewGuestReset`) }}
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
              title: this.$t('admin:utilitiesAuth.reviewCertificateRegeneration'),
              effect:
                this.$t('admin:utilitiesAuth.replacesAuthenticationSigningKeys'),
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: this.$t('admin:utilitiesAuth.credentialAction'), value: this.$t('admin:utilitiesAuth.replaceAuthenticationSigningCertificates') },
                { label: this.$t('admin:utilitiesAuth.browserSessions'), value: this.$t('admin:utilitiesAuth.endEverySignedBrowser') },
                { label: this.$t('admin:utilitiesAuth.storedApiCredentials'), value: this.$t('admin:utilitiesAuth.revokeEveryStoredApi') },
                { label: this.$t('admin:utilitiesAuth.encryptionRoot'), value: this.$t('admin:utilitiesAuth.preserved') }
              ],
              payload: {}
            }
          : {
              kind,
              title: this.$t('admin:utilitiesAuth.reviewGuestReset'),
              effect:
                this.$t('admin:utilitiesAuth.restoresReservedGuestIdentity'),
              confirmation: utilityOperationConfirmation(kind),
              parameters: [
                { label: this.$t('admin:utilitiesAuth.guestIdentity'), value: this.$t('admin:utilitiesAuth.restoreAssignExistingGuests') },
                { label: this.$t('admin:utilitiesAuth.guestsGroupPolicy'), value: this.$t('admin:utilitiesAuth.preserveCurrentPermissionsPage') }
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
