<template lang="pug">
v-card
  v-card-title Export workspace data
  v-card-subtitle Prepare a local export through a recorded request. The receipt never stores its filesystem destination.
  v-card-text
    v-alert(color='info' variant='tonal' icon='mdi-information-outline')
      .text-body-medium This creates portable safe projections of selected shared content and administration metadata. It is not a full or restorable backup.
      .text-body-small.mt-1 Credentials, signing and session material, API tokens, user hashes and TFA data, IPs, private-owner content and protected assets are excluded.
    h2.text-title-medium.mt-6 Select portable projections
    v-checkbox(v-for='choice in choices' :key='choice.key' v-model='entities' :value='choice.key' :label='choice.title' :hint='choice.hint' persistent-hint hide-details :disabled='busy')
    v-text-field.utility-export-destination.mt-6(v-model='path' label='Empty destination within the application root' hint='Relative paths are supported. The server requires an empty, symlink-safe folder inside the application root.' persistent-hint variant='outlined' :error-messages='pathError' :disabled='busy')
    v-btn.mt-4(color='primary' variant='flat' :disabled='busy || !valid' @click='openReview') Review export
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
import { utilityOperationConfirmation, type UtilitiesWorkspace, type UtilityOperation } from '../../../shared/utilities-workspace.ts'
import UtilityReview from './admin-utilities-review.vue'

const choices = [
  { key: 'pages', title: 'Pages', hint: 'Page content, tags and metadata.' },
  { key: 'history', title: 'Page history', hint: 'Previous page versions and metadata.' },
  { key: 'assets', title: 'Assets', hint: 'Uploaded media and files.' },
  { key: 'users', title: 'Users', hint: 'Identity metadata and group membership.' },
  { key: 'groups', title: 'Groups', hint: 'Permissions and page rules.' },
  { key: 'settings', title: 'Settings', hint: 'Portable administration and module metadata; credentials are excluded.' },
  { key: 'navigation', title: 'Navigation', hint: 'Static or custom navigation.' },
  { key: 'comments', title: 'Comments', hint: 'Built-in comment records.' }
] as const

type ExportPayload = { entities: string[]; path: string }

export default defineComponent({
  components: { UtilityReview },
  props: {
    workspace: { type: Object as PropType<UtilitiesWorkspace>, required: true },
    busy: { type: Boolean, default: false },
    uncertainReceipt: { type: Object as PropType<UtilityOperation | null>, default: null }
  },
  emits: ['request', 'draft-state'],
  data: () => ({
    choices,
    entities: [] as string[],
    path: './data/export',
    review: {
      open: false,
      title: 'Review export',
      effect: '',
      confirmation: utilityOperationConfirmation('export'),
      parameters: [] as Array<{ label: string; value: string }>,
      payload: null as ExportPayload | null
    },
    reviewError: '',
    reviewDirty: false
  }),
  computed: {
    valid(): boolean {
      return this.entities.length > 0 && this.path.trim().length > 0
    },
    pathError(): string {
      return this.path.trim().length > 0 ? '' : 'Enter a target folder path.'
    },
    formDirty(): boolean {
      return this.entities.length > 0 || this.path !== './data/export'
    }
  },
  watch: {
    entities: {
      deep: true,
      handler() {
        this.publishDraftState()
      }
    },
    path() {
      this.publishDraftState()
    }
  },
  methods: {
    openReview() {
      if (!this.valid || this.busy) return
      const payload = Object.freeze({ entities: [...this.entities], path: this.path.trim() }) as ExportPayload
      this.review = {
        open: true,
        title: 'Review export',
        effect:
          'The export service will create selected portable safe projections in the reviewed empty, symlink-safe folder within the application root. It is not a full or restorable backup, and the folder path is intentionally omitted from the receipt and recovery history.',
        confirmation: utilityOperationConfirmation('export'),
        parameters: [
          { label: 'Export sections', value: payload.entities.map((key) => choices.find((choice) => choice.key === key)?.title ?? key).join(', ') },
          { label: 'Target folder', value: payload.path }
        ],
        payload
      }
      this.reviewError = ''
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
      if (!snapshot.open || !snapshot.payload || this.busy) return
      this.$emit('request', {
        kind: 'export',
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
.utility-export-destination.v-input--disabled .v-input__details {
  opacity: 1;

  .v-messages {
    color: var(--admin-muted);
    opacity: 1;
  }
}
</style>
