<template lang="pug">
v-card
  v-card-title {{ $t(`admin:utilitiesContent.contentMaintenance`) }}
  v-card-subtitle {{ $t(`admin:utilitiesContent.repairDerivedContentMove`) }}
  v-card-text
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesContent.rebuildPageTree`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesContent.recreateInferredFolderTree`) }}
          v-btn.mt-4(variant='outlined' color='primary' :disabled='busy' @click='openReview(`content-rebuild-tree`)') {{ $t(`admin:utilitiesContent.reviewTreeRebuild`) }}
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesContent.rerenderAllPages`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesContent.rebuildRenderedOutputPage`) }}
          v-btn.mt-4(variant='outlined' color='primary' :disabled='busy' @click='openReview(`content-rerender`)') {{ $t(`admin:utilitiesContent.reviewFullRerender`) }}
    v-divider.my-6
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesContent.migratePagesLocale`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesContent.moveEligiblePagesWithout`) }}
          v-alert.mt-3(v-if='!locales.length' color='warning' variant='tonal' density='compact') {{ $t(`admin:utilitiesContent.noCurrentLocalesAvailable`) }}
          v-row.mt-1
            v-col(cols='12' sm='6')
              v-select(v-model='sourceLocale' :items='locales' item-title='name' item-value='code' :label='$t(`admin:utilitiesContent.sourceLocale`)' variant='outlined' hide-details :disabled='busy || !locales.length')
            v-col(cols='12' sm='6')
              v-select(v-model='targetLocale' :items='locales' item-title='name' item-value='code' :label='$t(`admin:utilitiesContent.targetLocale`)' variant='outlined' hide-details :disabled='busy || !locales.length')
          v-btn.mt-4(variant='outlined' color='warning' :disabled='busy || !canMigrate' @click='openReview(`content-migrate-locale`)') {{ $t(`admin:utilitiesContent.reviewLocaleMigration`) }}
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium {{ $t(`admin:utilitiesContent.purgePageHistory`) }}
          p.text-body-medium.mt-2 {{ $t(`admin:utilitiesContent.permanentlyRemoveDatabaseHistory`) }}
          v-select.mt-3(v-model='olderThan' :items='historyPeriods' item-title='title' item-value='value' :label='$t(`admin:utilitiesContent.deleteHistoryOlderThan`)' variant='outlined' hide-details :disabled='busy')
          v-btn.mt-4(variant='outlined' color='error' :disabled='busy' @click='openReview(`content-purge-history`)') {{ $t(`admin:utilitiesContent.reviewHistoryPurge`) }}
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
  UtilityHistoryRetentionPeriods,
  utilityOperationConfirmation,
  type UtilitiesWorkspace,
  type UtilityOperation,
  type UtilityOperationKind
} from '../../../shared/utilities-workspace.ts'
import UtilityReview from './admin-utilities-review.vue'
import type { Translate } from '../../helpers/use-translate.ts'

type ContentKind = Extract<UtilityOperationKind, 'content-rebuild-tree' | 'content-rerender' | 'content-migrate-locale' | 'content-purge-history'>
type ReviewSnapshot = {
  kind: ContentKind
  title: string
  effect: string
  confirmation: string
  parameters: Array<{ label: string; value: string }>
  payload: Record<string, string>
}

const historyPeriodTitles: Record<string, string> = {
  P1D: 'admin:utilitiesContent.n1Day',
  P1M: 'admin:utilitiesContent.n1Month',
  P3M: 'admin:utilitiesContent.n3Months',
  P6M: 'admin:utilitiesContent.n6Months',
  P1Y: 'admin:utilitiesContent.n1Year',
  P2Y: 'admin:utilitiesContent.n2Years',
  P3Y: 'admin:utilitiesContent.n3Years',
  P5Y: 'admin:utilitiesContent.n5Years'
}
const historyPeriodTitle = (t: Translate, value: string): string => (historyPeriodTitles[value] ? t(historyPeriodTitles[value]) : value)

export default defineComponent({
  components: { UtilityReview },
  props: {
    workspace: { type: Object as PropType<UtilitiesWorkspace>, required: true },
    busy: { type: Boolean, default: false },
    uncertainReceipt: { type: Object as PropType<UtilityOperation | null>, default: null }
  },
  emits: ['request', 'draft-state'],
  data: () => ({
    sourceLocale: '',
    targetLocale: '',
    olderThan: 'P1Y',
    review: {
      open: false,
      kind: 'content-rebuild-tree' as ContentKind,
      title: '',
      effect: '',
      confirmation: '',
      parameters: [] as Array<{ label: string; value: string }>,
      payload: {} as Record<string, string>
    },
    reviewError: '',
    reviewDirty: false
  }),
  computed: {
    locales() {
      return this.workspace.locales
    },
    historyPeriods() {
      return UtilityHistoryRetentionPeriods.map((value) => ({ value, title: historyPeriodTitle(this.$t, value) }))
    },
    canMigrate(): boolean {
      return (
        this.locales.some((locale) => locale.code === this.sourceLocale) &&
        this.locales.some((locale) => locale.code === this.targetLocale) &&
        this.sourceLocale !== this.targetLocale
      )
    },
    formDirty(): boolean {
      return Boolean(this.sourceLocale || this.targetLocale || this.olderThan !== 'P1Y')
    }
  },
  watch: {
    'workspace.locales': {
      immediate: true,
      handler() {
        if (!this.locales.some((locale) => locale.code === this.sourceLocale)) this.sourceLocale = ''
        if (!this.locales.some((locale) => locale.code === this.targetLocale)) this.targetLocale = ''
      }
    },
    sourceLocale() {
      this.publishDraftState()
    },
    targetLocale() {
      this.publishDraftState()
    },
    olderThan() {
      this.publishDraftState()
    }
  },
  methods: {
    localeTitle(code: string): string {
      const locale = this.locales.find((value) => value.code === code)
      return locale ? `${locale.name} (${locale.code})` : code
    },
    openReview(kind: ContentKind) {
      if (this.busy || (kind === 'content-migrate-locale' && !this.canMigrate)) return
      const payload = Object.freeze(
        kind === 'content-migrate-locale'
          ? { sourceLocale: this.sourceLocale, targetLocale: this.targetLocale }
          : kind === 'content-purge-history'
            ? { olderThan: this.olderThan }
            : {}
      ) as Record<string, string>
      const detail: Record<ContentKind, Omit<ReviewSnapshot, 'kind' | 'confirmation' | 'payload'>> = {
        'content-rebuild-tree': {
          title: this.$t('admin:utilitiesContent.reviewPageTreeRebuild'),
          effect: this.$t('admin:utilitiesContent.regeneratesInferredPageTree'),
          parameters: [{ label: this.$t('admin:utilitiesContent.maintenanceOperation'), value: this.$t('admin:utilitiesContent.rebuildPageTreeCurrent') }]
        },
        'content-rerender': {
          title: this.$t('admin:utilitiesContent.reviewFullRerender'),
          effect:
            this.$t('admin:utilitiesContent.rebuildsRenderedOutputEvery'),
          parameters: [{ label: this.$t('admin:utilitiesContent.maintenanceOperation'), value: this.$t('admin:utilitiesContent.rerenderEveryCurrentPage') }]
        },
        'content-migrate-locale': {
          title: this.$t('admin:utilitiesContent.reviewLocaleMigration'),
          effect: this.$t('admin:utilitiesContent.movesEligiblePagesExisting', { sourceLocale: this.localeTitle(this.sourceLocale), targetLocale: this.localeTitle(this.targetLocale), interpolation: { escapeValue: false } }),
          parameters: [
            { label: this.$t('admin:utilitiesContent.sourceLocale'), value: this.localeTitle(this.sourceLocale) },
            { label: this.$t('admin:utilitiesContent.targetLocale'), value: this.localeTitle(this.targetLocale) }
          ]
        },
        'content-purge-history': {
          title: this.$t('admin:utilitiesContent.reviewHistoryPurge'),
          effect: this.$t('admin:utilitiesContent.permanentlyDeletesDatabasePage', { olderThan: historyPeriodTitle(this.$t, this.olderThan), interpolation: { escapeValue: false } }),
          parameters: [
            { label: this.$t('admin:utilitiesContent.deleteHistoryOlderThan'), value: historyPeriodTitle(this.$t, this.olderThan) },
            { label: this.$t('admin:utilitiesContent.storageModuleHistory'), value: this.$t('admin:utilitiesContent.unchanged') }
          ]
        }
      }
      this.review = { open: true, kind, confirmation: utilityOperationConfirmation(kind), payload, ...detail[kind] }
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
