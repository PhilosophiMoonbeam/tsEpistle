<template lang="pug">
v-card
  v-card-title Telemetry and privacy
  v-card-subtitle Saved preference is separate from a successful external telemetry delivery. This workspace does not infer delivery health.
  v-card-text
    v-alert(color='info' variant='tonal' icon='mdi-information-outline')
      .text-body-medium When enabled, telemetry sends anonymized installation and platform information to the configured endpoint. It does not include wiki content or personal data.
    v-switch.mt-6(v-model='enabled' label='Enable telemetry' color='primary' :disabled='busy' persistent-hint hint='Changing this preference is recorded and persisted before local runtime state is updated.')
    v-btn.mt-4(color='primary' variant='flat' :disabled='busy || !preferenceChanged' @click='openSaveReview') Review telemetry preference
    v-divider.my-6
    h2.text-title-medium Anonymous client ID
    p.text-body-medium.mt-2 This identifier groups telemetry requests. Resetting it breaks continuity with prior telemetry. It is not evidence that a request was delivered.
    v-sheet.pa-3.rounded.border
      code.telemetry-client-id {{ workspace.telemetry.clientId ?? 'No client ID is currently configured.' }}
    .d-flex.flex-wrap.ga-2.mt-4
      v-btn(variant='outlined' :disabled='!workspace.telemetry.clientId || busy' @click='copyClientId') Copy ID
      v-btn(color='warning' variant='outlined' :disabled='busy' @click='openResetReview') Review client-ID reset
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

type TelemetryKind = Extract<UtilityOperationKind, 'telemetry-save' | 'telemetry-reset-client-id'>
type ReviewSnapshot = {
  kind: TelemetryKind
  title: string
  effect: string
  confirmation: string
  parameters: Array<{ label: string; value: string }>
  payload: Record<string, boolean>
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
    enabled: false,
    telemetryLoaded: false,
    review: {
      open: false,
      kind: 'telemetry-save' as TelemetryKind,
      title: '',
      effect: '',
      confirmation: '',
      parameters: [] as Array<{ label: string; value: string }>,
      payload: {} as Record<string, boolean>
    },
    reviewError: '',
    reviewDirty: false
  }),
  computed: {
    preferenceChanged(): boolean {
      return this.enabled !== this.workspace.telemetry.enabled
    },
    formDirty(): boolean {
      return this.preferenceChanged
    }
  },
  watch: {
    'workspace.telemetry.enabled': {
      immediate: true,
      handler(enabled: boolean) {
        if (!this.telemetryLoaded || (!this.review.open && !this.preferenceChanged)) this.enabled = enabled
        this.telemetryLoaded = true
      }
    },
    enabled() {
      this.publishDraftState()
    }
  },
  methods: {
    openSaveReview() {
      if (!this.preferenceChanged || this.busy) return
      const payload = Object.freeze({ enabled: this.enabled }) as Record<string, boolean>
      this.review = {
        open: true,
        kind: 'telemetry-save',
        title: 'Review telemetry preference',
        effect: `This saves telemetry as ${payload.enabled ? 'enabled' : 'disabled'} and then reconciles this process with the saved preference.`,
        confirmation: utilityOperationConfirmation('telemetry-save'),
        parameters: [{ label: 'Telemetry preference', value: payload.enabled ? 'Enabled' : 'Disabled' }],
        payload
      }
      this.reviewError = ''
    },
    openResetReview() {
      if (this.busy) return
      this.review = {
        open: true,
        kind: 'telemetry-reset-client-id',
        title: 'Review telemetry client-ID reset',
        effect: 'This creates and saves a new anonymous client ID. The previous ID cannot be recovered from the Utilities receipt.',
        confirmation: utilityOperationConfirmation('telemetry-reset-client-id'),
        parameters: [{ label: 'Client ID action', value: 'Replace the current anonymous client ID' }],
        payload: Object.freeze({}) as Record<string, boolean>
      }
      this.reviewError = ''
    },
    async copyClientId() {
      const clientId = this.workspace.telemetry.clientId
      if (!clientId) return
      try {
        await navigator.clipboard.writeText(clientId)
        this.$emit('notice', { message: 'Telemetry client ID copied.', color: 'success' })
      } catch {
        this.$emit('notice', { message: 'The browser could not copy the telemetry client ID.', color: 'warning' })
      }
    },
    setReviewDirty(dirty: boolean) {
      this.reviewDirty = dirty
      this.publishDraftState()
    },
    publishDraftState() {
      this.$emit('draft-state', this.formDirty || this.reviewDirty)
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

<style lang="scss">
.telemetry-client-id {
  display: block;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
