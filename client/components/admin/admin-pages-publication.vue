<template>
  <v-dialog :model-value="modelValue" max-width="900" persistent aria-labelledby="publication-review-title">
    <v-card class="publication-review">
      <header><span class="pages-kicker">Selected pages / publication</span><h2 id="publication-review-title">Review the change.</h2><p>Change publication for up to 25 pages. Each page keeps its visibility, ownership, content and publication window.</p></header>
      <v-card-text>
        <v-radio-group v-model="enabled" inline label="Publication action" :disabled="busy || completed">
          <v-radio :value="true" label="Enable publication" /><v-radio :value="false" label="Return to draft" />
        </v-radio-group>
        <p class="publication-context">{{ enabled ? 'An enabled page is available only inside its publication window and to readers with access. Private pages remain private.' : 'Draft pages are hidden from ordinary readers. People with edit access can still open them.' }}</p>
        <div class="publication-progress" role="status">{{ busy ? 'Working… ' : '' }}{{ summary }}<span v-if="stopRequested"> · Stopping after the current request</span></div>
        <div class="publication-review-list">
          <article v-for="row in rows" :key="row.id"><div><strong>{{ row.title }}</strong><small v-if="row.page">{{ row.page.locale }}/{{ row.page.path }} · {{ row.page.visibility === 'private' ? 'Private' : 'Workspace' }} · {{ state(row.page) }}</small><small v-if="row.page && (row.page.publishStartDate || row.page.publishEndDate)">Window: {{ date(row.page.publishStartDate) }} → {{ date(row.page.publishEndDate) }}</small><p v-if="row.error" class="text-error">{{ row.error }}</p></div><v-chip size="small" :color="row.status === 'error' ? 'error' : row.status === 'saved' ? 'success' : undefined">{{ row.status }}</v-chip></article>
        </div>
        <p class="publication-context">Changes run one page at a time in this browser. A changed revision or missing permission fails that page without overwriting it. Review failed pages again before retrying.</p>
      </v-card-text>
      <v-card-actions class="publication-actions"><v-btn :disabled="busy" @click="close">{{ completed ? 'Done' : 'Cancel' }}</v-btn><v-btn v-if="hasErrors" :disabled="busy" @click="reviewFailures">Review failed pages</v-btn><v-spacer /><v-btn v-if="busy" :disabled="stopRequested || inspecting" @click="stopRequested = true">Stop after this page</v-btn><v-btn v-else color="primary" variant="flat" :disabled="!readyCount" @click="apply">Apply to {{ readyCount }} {{ readyCount === 1 ? 'page' : 'pages' }}</v-btn></v-card-actions>
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
    summary(): string { return `${this.rows.filter(row => row.status === 'saved').length} changed · ${this.rows.filter(row => row.status === 'unchanged').length} unchanged · ${this.rows.filter(row => row.status === 'error').length} failed · ${this.readyCount} ready` }
  },
  methods: {
    state: publicationState,
    date(value: string | null | undefined): string { return value === undefined || value === null || value === '' ? 'No boundary' : new Date(value).toLocaleString() },
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
