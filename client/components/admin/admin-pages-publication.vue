<template>
  <v-dialog :model-value="modelValue" max-width="900" persistent aria-labelledby="publication-review-title">
    <v-card class="publication-review">
      <header><span class="pages-kicker">{{ $t('admin:pagesPublication.selectedPagesPublication') }}</span><h2 id="publication-review-title">{{ $t('admin:pagesPublication.reviewChange') }}</h2><p>{{ $t('admin:pagesPublication.changePublicationUp25') }}</p></header>
      <v-card-text>
        <v-radio-group v-model="enabled" inline :label="$t('admin:pagesPublication.publicationAction')" :disabled="busy || completed">
          <v-radio :value="true" :label="$t('admin:pagesPublication.enablePublication')" /><v-radio :value="false" :label="$t('admin:pagesPublication.returnDraft')" />
        </v-radio-group>
        <p class="publication-context">{{ enabled ? $t('admin:pagesPublication.enabledPageAvailableOnly') : $t('admin:pagesPublication.draftPagesHiddenOrdinary') }}</p>
        <div class="publication-progress" role="status">{{ busy ? `${$t('admin:pagesPublication.working')} ` : '' }}{{ summary }}<span v-if="stopRequested"> {{ $t('admin:pagesPublication.stoppingAfterCurrentRequest') }}</span></div>
        <div class="publication-review-list">
          <article v-for="row in rows" :key="row.id"><div><strong>{{ row.title }}</strong><small v-if="row.page">{{ row.page.locale }}/{{ row.page.path }} · {{ row.page.visibility === 'private' ? $t('admin:pagesPublication.private') : $t('admin:pagesPublication.workspace') }} · {{ state(row.page) }}</small><small v-if="row.page && (row.page.publishStartDate || row.page.publishEndDate)">{{ $t('admin:pagesPublication.window', { publishStartDate: date(row.page.publishStartDate), publishEndDate: date(row.page.publishEndDate), interpolation: { escapeValue: false } }) }}</small><p v-if="row.error" class="text-error">{{ row.error }}</p></div><v-chip size="small" :color="row.status === 'error' ? 'error' : row.status === 'saved' ? 'success' : undefined">{{ row.status }}</v-chip></article>
        </div>
        <p class="publication-context">{{ $t('admin:pagesPublication.changesRunOnePage') }}</p>
      </v-card-text>
      <v-card-actions class="publication-actions"><v-btn :disabled="busy" @click="close">{{ completed ? $t('admin:pagesPublication.done') : $t('common:actions.cancel') }}</v-btn><v-btn v-if="hasErrors" :disabled="busy" @click="reviewFailures">{{ $t('admin:pagesPublication.reviewFailedPages') }}</v-btn><v-spacer /><v-btn v-if="busy" :disabled="stopRequested || inspecting" @click="stopRequested = true">{{ $t('admin:pagesPublication.stopAfterPage') }}</v-btn><v-btn v-else color="primary" variant="flat" :disabled="!readyCount" @click="apply">{{ $t('admin:pagesPublication.apply', { tValue: $t('admin:pagesPublication.pagesCount', { count: readyCount }), interpolation: { escapeValue: false } }) }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { applyPublication, inspectPublication, publicationState, type PublicationReview } from '../../helpers/admin-pages'
import type { PageListRow } from '../../helpers/pages-api'
export default defineComponent({
  props: { modelValue: Boolean, selected: { type: Array as PropType<PageListRow[]>, required: true } },
  emits: ['update:modelValue', 'busy', 'changed'],
  data: () => ({ rows: [] as PublicationReview[], enabled: false, busy: false, inspecting: false, stopRequested: false, completed: false, generation: 0 }),
  computed: {
    readyCount(): number { return this.rows.filter(row => row.status === 'ready').length },
    hasErrors(): boolean { return this.rows.some(row => row.status === 'error') },
    summary(): string { return this.$t('admin:pagesPublication.changedUnchangedFailedReady', { rows: this.rows.filter(row => row.status === 'saved').length, rows2: this.rows.filter(row => row.status === 'unchanged').length, rows3: this.rows.filter(row => row.status === 'error').length, readyCount: this.readyCount, interpolation: { escapeValue: false } }) }
  },
  methods: {
    state: publicationState,
    date(value: string | null | undefined): string { return value === undefined || value === null || value === '' ? this.$t('admin:pagesPublication.noBoundary') : new Date(value).toLocaleString() },
    protect(event: BeforeUnloadEvent) { if (this.busy) { event.preventDefault(); event.returnValue = '' } },
    async inspect(rows: PublicationReview[]) {
      this.busy = true; this.inspecting = true
      const generation = this.generation
      try { for (const row of rows) { if (generation !== this.generation) break; await inspectPublication(row) } } finally { this.busy = false; this.inspecting = false }
    },
    async reviewFailures() { if (this.busy) return; await this.inspect(this.rows.filter(row => row.status === 'error')) },
    async apply() {
      if (this.busy) return
      this.busy = true; this.stopRequested = false; this.completed = true
      try { for (const row of this.rows) { if (this.stopRequested) break; await applyPublication(row, this.enabled) } } finally { this.busy = false; if (this.rows.some(row => row.status === 'saved')) this.$emit('changed') }
    },
    close() { if (this.busy) return; this.$emit('update:modelValue', false) }
  },
  watch: {
    modelValue: { async handler(open: boolean) { if (!open) return; this.generation++; this.enabled = false; this.completed = false; this.stopRequested = false; this.rows = this.selected.slice(0, 25).map(page => ({ id: page.id, title: page.title || page.path, page: null, status: 'loading', error: '' })); await this.inspect(this.rows) }, immediate: true },
    busy(value: boolean) { this.$emit('busy', value) }
  },
  mounted() { window.addEventListener('beforeunload', this.protect) },
  beforeUnmount() { this.generation++; this.stopRequested = true; window.removeEventListener('beforeunload', this.protect) }
})
</script>
<style scoped lang="scss">
.publication-review header { padding:2rem 2rem 0; }h2 { font:500 2rem/1.15 var(--font-family-serif, Georgia,serif); margin:.5rem 0 1rem; }p { line-height:1.7; }.publication-context { font-size:.85rem; color:rgb(var(--v-theme-on-surface-variant)); }.publication-progress { padding:.8rem 0; border-bottom:1px solid rgba(var(--v-border-color),.2); }.publication-review-list { max-height:38vh; overflow:auto; }article { display:flex; justify-content:space-between; align-items:start; gap:1rem; padding:1rem 0; border-bottom:1px solid rgba(var(--v-border-color),.15); }article div { min-width:0; overflow-wrap:anywhere; }small { display:block; margin-top:.35rem; color:rgb(var(--v-theme-on-surface-variant)); }.publication-actions { flex-wrap:wrap; padding:1rem; }.pages-kicker { font-size:.7rem; text-transform:uppercase; letter-spacing:.13em; }
</style>
