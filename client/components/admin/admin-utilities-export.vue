<template lang="pug">
v-card
  v-card-title {{ $t(`admin:utilitiesExport.exportWorkspaceData`) }}
  v-card-subtitle {{ $t(`admin:utilitiesExport.prepareLocalExportThrough`) }}
  v-card-text
    v-alert(color='info' variant='tonal' icon='mdi-information-outline')
      .text-body-medium {{ $t(`admin:utilitiesExport.createsPortableSafeProjections`) }}
      .text-body-small.mt-1 {{ $t(`admin:utilitiesExport.credentialsSigningSessionMaterial`) }}
    h2.text-title-medium.mt-6 {{ $t(`admin:utilitiesExport.selectPortableProjections`) }}
    v-checkbox(v-for='choice in choices' :key='choice.key' v-model='entities' :value='choice.key' :label='$t(choice.title)' :hint='$t(choice.hint)' persistent-hint :disabled='busy')
    v-text-field.utility-export-destination.mt-6(v-model='path' :label='$t(`admin:utilitiesExport.emptyDestinationWithinApplication`)' :hint='$t(`admin:utilitiesExport.relativePathsSupportedServer`)' persistent-hint variant='outlined' :error-messages='pathError' :disabled='busy')
    v-btn.mt-4(color='primary' variant='flat' :disabled='busy || !valid' @click='openReview') {{ $t(`admin:utilitiesExport.reviewExport`) }}
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
  { key: 'pages', title: 'admin:utilitiesExport.pages', hint: 'admin:utilitiesExport.pageContentTagsMetadata' },
  { key: 'history', title: 'admin:utilitiesExport.pageHistory', hint: 'admin:utilitiesExport.previousPageVersionsMetadata' },
  { key: 'assets', title: 'admin:utilitiesExport.assets', hint: 'admin:utilitiesExport.uploadedMediaFiles' },
  { key: 'users', title: 'admin:utilitiesExport.users', hint: 'admin:utilitiesExport.identityMetadataGroupMembership' },
  { key: 'groups', title: 'admin:utilitiesExport.groups', hint: 'admin:utilitiesExport.permissionsPageRules' },
  { key: 'settings', title: 'admin:utilitiesExport.settings', hint: 'admin:utilitiesExport.portableAdministrationModuleMetadata' },
  { key: 'navigation', title: 'admin:utilitiesExport.navigation', hint: 'admin:utilitiesExport.staticCustomNavigation' },
  { key: 'comments', title: 'admin:utilitiesExport.comments', hint: 'admin:utilitiesExport.builtCommentRecords' }
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
  data: (vm) => ({
    choices,
    entities: [] as string[],
    path: './data/export',
    review: {
      open: false,
      title: vm.$t('admin:utilitiesExport.reviewExport'),
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
      return this.path.trim().length > 0 ? '' : this.$t('admin:utilitiesExport.enterTargetFolderPath')
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
        title: this.$t('admin:utilitiesExport.reviewExport'),
        effect:
          this.$t('admin:utilitiesExport.exportServiceWillCreate'),
        confirmation: utilityOperationConfirmation('export'),
        parameters: [
          { label: this.$t('admin:utilitiesExport.exportSections'), value: payload.entities.map((key) => this.$t(choices.find((choice) => choice.key === key)?.title ?? key)).join(', ') },
          { label: this.$t('admin:utilitiesExport.targetFolder'), value: payload.path }
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
