<template lang="pug">
v-card
  v-card-title Content maintenance
  v-card-subtitle Repair derived content, move eligible locale records, or delete old history through reviewed receipts.
  v-card-text
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Rebuild page tree
          p.text-body-medium.mt-2 Recreate the inferred folder tree from current page paths. It does not edit page content.
          v-btn.mt-4(variant='outlined' color='primary' :disabled='busy' @click='openReview(`content-rebuild-tree`)') Review tree rebuild
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Rerender all pages
          p.text-body-medium.mt-2 Rebuild rendered output page by page. This can take time; the receipt shows persisted progress if the browser closes.
          v-btn.mt-4(variant='outlined' color='primary' :disabled='busy' @click='openReview(`content-rerender`)') Review full rerender
    v-divider.my-6
    v-row
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Migrate pages to a locale
          p.text-body-medium.mt-2 Move eligible pages without overwriting an existing target page. This action cannot be reversed automatically.
          v-alert.mt-3(v-if='!locales.length' color='warning' variant='tonal' density='compact') No current locales are available for migration. Reload Utilities after locale configuration is restored.
          v-row.mt-1
            v-col(cols='12' sm='6')
              v-select(v-model='sourceLocale' :items='locales' item-title='name' item-value='code' label='Source locale' variant='outlined' hide-details :disabled='busy || !locales.length')
            v-col(cols='12' sm='6')
              v-select(v-model='targetLocale' :items='locales' item-title='name' item-value='code' label='Target locale' variant='outlined' hide-details :disabled='busy || !locales.length')
          v-btn.mt-4(variant='outlined' color='warning' :disabled='busy || !canMigrate' @click='openReview(`content-migrate-locale`)') Review locale migration
      v-col(cols='12' md='6')
        v-sheet.pa-4.rounded.border.h-100
          h2.text-title-medium Purge page history
          p.text-body-medium.mt-2 Permanently remove database history older than the selected retention period. Storage-module history is not changed.
          v-select.mt-3(v-model='olderThan' :items='historyPeriods' item-title='title' item-value='value' label='Delete history older than' variant='outlined' hide-details :disabled='busy')
          v-btn.mt-4(variant='outlined' color='error' :disabled='busy' @click='openReview(`content-purge-history`)') Review history purge
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
  P1D: '1 day',
  P1M: '1 month',
  P3M: '3 months',
  P6M: '6 months',
  P1Y: '1 year',
  P2Y: '2 years',
  P3Y: '3 years',
  P5Y: '5 years'
}
const historyPeriodTitle = (value: string): string => historyPeriodTitles[value] ?? value

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
      return UtilityHistoryRetentionPeriods.map((value) => ({ value, title: historyPeriodTitle(value) }))
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
          title: 'Review page-tree rebuild',
          effect: 'This regenerates the inferred page tree from current paths. It does not edit source content.',
          parameters: [{ label: 'Maintenance operation', value: 'Rebuild page tree from current page paths' }]
        },
        'content-rerender': {
          title: 'Review full rerender',
          effect:
            'This rebuilds rendered output for every current page. It can be interrupted; refresh the receipt rather than restarting an unconfirmed run.',
          parameters: [{ label: 'Maintenance operation', value: 'Rerender every current page' }]
        },
        'content-migrate-locale': {
          title: 'Review locale migration',
          effect: `This moves eligible pages from ${this.localeTitle(this.sourceLocale)} to ${this.localeTitle(this.targetLocale)}. Existing target pages are not overwritten.`,
          parameters: [
            { label: 'Source locale', value: this.localeTitle(this.sourceLocale) },
            { label: 'Target locale', value: this.localeTitle(this.targetLocale) }
          ]
        },
        'content-purge-history': {
          title: 'Review history purge',
          effect: `This permanently deletes database page history older than ${historyPeriodTitle(this.olderThan)}.`,
          parameters: [
            { label: 'Delete history older than', value: historyPeriodTitle(this.olderThan) },
            { label: 'Storage-module history', value: 'Unchanged' }
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
