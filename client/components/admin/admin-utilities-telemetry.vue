<template lang="pug">
v-card
  v-card-title {{ $t(`admin:utilitiesTelemetry.telemetryPrivacy`) }}
  v-card-subtitle {{ $t(`admin:utilitiesTelemetry.savedPreferenceSeparateSuccessful`) }}
  v-card-text
    v-alert(color='info' variant='tonal' icon='mdi-information-outline')
      .text-body-medium {{ $t(`admin:utilitiesTelemetry.whenEnabledTelemetrySends`) }}
    v-switch.mt-6(v-model='enabled' :label='$t(`admin:utilitiesTelemetry.enableTelemetry`)' color='primary' :disabled='busy' persistent-hint :hint='$t(`admin:utilitiesTelemetry.changingPreferenceRecordedPersisted`)')
    v-btn.mt-4(color='primary' variant='flat' :disabled='busy || !preferenceChanged' @click='openSaveReview') {{ $t(`admin:utilitiesTelemetry.reviewTelemetryPreference`) }}
    v-divider.my-6
    h2.text-title-medium {{ $t(`admin:utilitiesTelemetry.anonymousClientId`) }}
    p.text-body-medium.mt-2 {{ $t(`admin:utilitiesTelemetry.identifierGroupsTelemetryRequests`) }}
    v-sheet.pa-3.rounded.border
      code.telemetry-client-id {{ workspace.telemetry.clientId ?? $t(`admin:utilitiesTelemetry.noClientIdCurrently`) }}
    .d-flex.flex-wrap.ga-2.mt-4
      v-btn(variant='outlined' :disabled='!workspace.telemetry.clientId || busy' @click='copyClientId') {{ $t(`admin:utilitiesTelemetry.copyId`) }}
      v-btn(color='warning' variant='outlined' :disabled='busy' @click='openResetReview') {{ $t(`admin:utilitiesTelemetry.reviewClientIdReset`) }}
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
        title: this.$t('admin:utilitiesTelemetry.reviewTelemetryPreference'),
        effect: this.$t('admin:utilitiesTelemetry.savesTelemetryThenReconciles', { enabled: payload.enabled ? 'enabled' : 'disabled', interpolation: { escapeValue: false } }),
        confirmation: utilityOperationConfirmation('telemetry-save'),
        parameters: [{ label: this.$t('admin:utilitiesTelemetry.telemetryPreference'), value: payload.enabled ? this.$t('admin:utilitiesTelemetry.enabled') : this.$t('admin:utilitiesTelemetry.disabled') }],
        payload
      }
      this.reviewError = ''
    },
    openResetReview() {
      if (this.busy) return
      this.review = {
        open: true,
        kind: 'telemetry-reset-client-id',
        title: this.$t('admin:utilitiesTelemetry.reviewTelemetryClientId'),
        effect: this.$t('admin:utilitiesTelemetry.createsSavesNewAnonymous'),
        confirmation: utilityOperationConfirmation('telemetry-reset-client-id'),
        parameters: [{ label: this.$t('admin:utilitiesTelemetry.clientIdAction'), value: this.$t('admin:utilitiesTelemetry.replaceCurrentAnonymousClient') }],
        payload: Object.freeze({}) as Record<string, boolean>
      }
      this.reviewError = ''
    },
    async copyClientId() {
      const clientId = this.workspace.telemetry.clientId
      if (!clientId) return
      try {
        await navigator.clipboard.writeText(clientId)
        this.$emit('notice', { message: this.$t('admin:utilitiesTelemetry.telemetryClientIdCopied'), color: 'success' })
      } catch {
        this.$emit('notice', { message: this.$t('admin:utilitiesTelemetry.browserCouldNotCopy'), color: 'warning' })
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
