<template>
  <v-card :aria-busy="busy">
    <v-card-title>Import selected HedgeDoc content</v-card-title>
    <v-card-subtitle>Review a bounded export, then import or resume one private note at a time.</v-card-subtitle>
    <v-card-text>
      <v-alert type="info" variant="tonal">No source database connection, remote fetch, accounts, credentials, aliases or automatic publication. Imports belong to your current native account ({{ wikiStore.user.id }}); administrator status never impersonates another owner.</v-alert>
      <p class="my-4">Choose a hedgedoc-content-v1 JSON snapshot or a saved review bundle (maximum 8 MiB). The original file is never modified. Source author labels, timestamps and history are untrusted and may contain sensitive information.</p>
      <label>Read-only snapshot or resume bundle <input type="file" accept="application/json,.json" :disabled="busy" @change="loadFile" /></label>
      <p v-if="!snapshot" class="mt-4">No snapshot selected. The export must contain a namespace and selected notes with Markdown, bounded original revision records, history completeness, and export-only assets. Patch records use exact UTF-16 start/deleteCount/insert with SHA-256 beforeDigest/afterDigest; unsupported fuzzy patches must be exported as full Markdown revisions.</p>
      <template v-if="snapshot">
        <p class="mt-4">Source namespace: <code>{{ snapshot.namespace }}</code> · {{ snapshot.notes.length }} notes. Deselect notes you do not intend to import.</p>
        <section v-for="(choice, index) in choices" :key="choice.sourceId" class="my-4 pa-4 border rounded">
          <v-checkbox :model-value="selected" :value="choice.sourceId" :label="`Select source note ${choice.sourceId}`" :disabled="busy" hide-details @update:model-value="selected = $event ?? []; invalidate()" />
          <div v-if="selected.includes(choice.sourceId)">
            <v-row class="mt-2">
              <v-col cols="12" md="3"><v-text-field :model-value="choice.ownerId" label="Your existing native owner account ID" readonly /></v-col>
              <v-col cols="12" md="3"><v-select v-model="choice.target.kind" :items="['create', 'update']" label="Destination decision" :disabled="busy" @update:model-value="changeKind(index)" /></v-col>
              <v-col cols="12" md="3"><v-text-field v-model="choice.target.key" label="Native note key" :disabled="busy" @update:model-value="invalidate" /></v-col>
              <v-col v-if="choice.target.kind === 'update'" cols="12" md="3"><v-text-field :model-value="Number.isFinite(choice.target.expectedRevision) ? String(choice.target.expectedRevision) : ''" type="number" min="0" label="Explicit current native revision" :error-messages="Number.isSafeInteger(choice.target.expectedRevision) && choice.target.expectedRevision >= 0 ? [] : ['Enter a nonnegative native revision.']" :disabled="busy" @update:model-value="setExpectedRevision(index, $event)" /></v-col>
            </v-row>
            <p>Access: private. Source history: {{ sourceNote(choice.sourceId)?.historyComplete ? 'declared complete (validated during review)' : 'incomplete / unavailable segments retained honestly' }}.</p>
            <details class="my-2"><summary>Inspect original Markdown (untrusted, not rendered)</summary><pre class="hedgedoc-source">{{ sourceNote(choice.sourceId)?.markdown }}</pre></details>
            <div v-for="(asset, assetIndex) in choice.assets" :key="asset.sourceId" class="mt-3">
              <p>Asset <code>{{ asset.sourceId }}</code> · original URL <code>{{ sourceNote(choice.sourceId)?.assets.find(source => source.id === asset.sourceId)?.url }}</code></p>
              <v-select v-model="asset.action" :items="['skip', 'import']" label="Explicit asset decision" :disabled="busy" @update:model-value="changeAsset(index, assetIndex)" />
              <template v-if="asset.action === 'import'">
                <v-text-field v-model="asset.filename" label="Unused root asset filename (lowercase PNG/JPEG/GIF/WebP/PDF/TXT)" :disabled="busy" @update:model-value="invalidate" />
                <v-checkbox :model-value="asset.rewrite" label="Approve exact Markdown link/image destination replacement in plain paragraphs (other source remains unchanged)" :disabled="busy" @update:model-value="asset.rewrite = $event === true; invalidate()" />
              </template>
            </div>
          </div>
        </section>
        <v-btn color="primary" variant="outlined" :disabled="busy || !selected.length" @click="reviewSnapshot">Inventory and review (no writes)</v-btn>
      </template>
      <div v-if="review" class="mt-5">
        <h2 class="text-title-large">Reviewed manifest</h2>
        <p>Snapshot SHA-256: <code class="hedgedoc-digest">{{ review.snapshotDigest }}</code></p>
        <v-alert v-for="warning in review.warnings" :key="warning" class="my-3" type="warning" variant="tonal">{{ warning }}</v-alert>
        <ul><li v-for="item in review.items" :key="item.sourceId"><strong>{{ item.sourceId }}</strong> → {{ item.key }} · owner {{ item.ownerId }} · {{ item.status }} · native revision {{ item.currentRevision ?? 'new / previously imported' }}<br />Source SHA-256: <code class="hedgedoc-digest">{{ item.sourceDigest }}</code><ul><li v-for="asset in item.assets" :key="asset.sourceId">{{ asset.sourceId }}: {{ asset.action }} → {{ asset.destination ?? 'original URL unchanged' }} · {{ asset.rewrite ? 'URL replacement approved' : 'no URL replacement' }}</li></ul></li></ul>
        <v-btn class="mt-4 mr-3" variant="outlined" :disabled="busy" @click="downloadBundle">Save sensitive review / resume bundle</v-btn>
        <v-checkbox :model-value="acknowledged" label="I reviewed source content for secrets, approved existing owner mapping and private destinations, understand independent asset access, and saved the exact resume bundle." :disabled="busy" @update:model-value="acknowledged = $event === true" />
        <v-btn color="primary" :disabled="busy || !acknowledged" @click="execute">Import / resume reviewed notes</v-btn>
      </div>
      <p v-if="busy" class="mt-4" role="status">{{ activity }}</p>
      <v-alert v-if="error" class="mt-4" type="error" role="alert">{{ error }} Earlier committed notes remain intact. Retry with the exact saved review bundle; do not change source identity to bypass a conflict.</v-alert>
      <section v-if="receipts.length" class="mt-5" aria-label="Durable import results">
        <h2 class="text-title-large">Native results</h2>
        <ul><li v-for="receipt in receipts" :key="receipt.sourceId"><a :href="`/p/notes/${encodeURIComponent(receipt.key)}`">{{ receipt.key }}</a> · {{ receipt.status }} · captured native revision {{ receipt.revision }}<ul><li v-for="asset in receipt.assets" :key="asset.sourceId">{{ asset.sourceId }}: {{ asset.status }} {{ asset.destination }}</li></ul><v-btn size="small" variant="text" :disabled="busy" @click="loadProvenance(receipt.key)">Inspect retained source history / provenance</v-btn></li></ul>
        <p>Open the native note for real native history and captured-revision “Publish as page”. Import itself never creates a page or expands asset authorization.</p>
      </section>
      <details v-if="provenance" open class="mt-4"><summary>Retained untrusted provenance (owner-authorized; may contain secrets)</summary><pre class="hedgedoc-source">{{ JSON.stringify(provenance, null, 2) }}</pre></details>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { wikiStore } from '../../store/index.ts'
import { sameOriginJsonFetch } from '../../helpers/json-transport.ts'
import { HEDGEDOC_MAX_BYTES, parseHedgeDocInput, type HedgeDocSnapshot, type HedgeDocChoice, type HedgeDocReview, type HedgeDocReceipt, type HedgeDocProvenance } from '../../../shared/hedgedoc-import.ts'

const emit = defineEmits<{ 'draft-state': [dirty: boolean]; 'busy-state': [busy: boolean] }>()
const dirty = ref(false)
const snapshot = ref<HedgeDocSnapshot | null>(null)
const choices = ref<HedgeDocChoice[]>([])
const selected = ref<string[]>([])
const review = ref<HedgeDocReview | null>(null)
const acknowledged = ref(false)
const busy = ref(false)
const error = ref('')
const activity = ref('')
const receipts = ref<HedgeDocReceipt[]>([])
const provenance = ref<HedgeDocProvenance | null>(null)
let generation = 0
let disposed = false
let controller = new AbortController()
const identity = () => `${wikiStore.user.id}:${wikiStore.user.authVersion}:${wikiStore.offlineIdentityEpoch}:${siteConfig.agentCsrfToken}`
const current = (epoch: number) => !disposed && epoch === generation
function retire() {
  generation++
  controller.abort()
  if (!disposed) controller = new AbortController()
  snapshot.value = null; choices.value = []; selected.value = []; review.value = null; receipts.value = []; provenance.value = null
  acknowledged.value = false; error.value = ''; activity.value = ''; busy.value = false; dirty.value = false
}
watch(identity, retire, { flush: 'sync' })
watch([busy, dirty], ([running, unsaved]) => { emit('busy-state', running); emit('draft-state', running || unsaved) }, { flush: 'sync', immediate: true })
function beforeUnload(event: BeforeUnloadEvent) {
  if (!busy.value && !dirty.value) return
  event.preventDefault(); event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { disposed = true; retire(); window.removeEventListener('beforeunload', beforeUnload) })
function sourceNote(sourceId: string) { return snapshot.value?.notes.find(note => note.id === sourceId) }
function invalidate() { review.value = null; acknowledged.value = false; dirty.value = true }
function changeKind(index: number) {
  const choice = choices.value[index]!
  choice.target = choice.target.kind === 'update' ? { kind: 'update', key: choice.target.key, expectedRevision: 0 } : { kind: 'create', key: choice.target.key }
  invalidate()
}
function setExpectedRevision(index: number, value: string) {
  const target = choices.value[index]?.target
  if (target?.kind !== 'update') return
  target.expectedRevision = value.trim() === '' ? Number.NaN : Number(value)
  invalidate()
}
function changeAsset(index: number, assetIndex: number) {
  const choice = choices.value[index]!
  const asset = choice.assets[assetIndex]!
  choice.assets[assetIndex] = asset.action === 'import' ? { sourceId: asset.sourceId, action: 'import', filename: '', rewrite: false } : { sourceId: asset.sourceId, action: 'skip' }
  invalidate()
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const epoch = generation, actor = identity()
  const csrf = siteConfig.agentCsrfToken
  try {
    const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/hedgedoc-import${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-wiki-csrf': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value: unknown = await response.json()
    if (!current(epoch) || identity() !== actor) throw new DOMException('The importing account changed.', 'AbortError')
    if (!response.ok) throw new Error(typeof value === 'object' && value !== null && typeof Reflect.get(value, 'error') === 'string' ? Reflect.get(value, 'error') as string : 'Import request failed; its receipt may be unknown. Resume the original review.')
    return value as T
  } finally {
    if (current(epoch) && identity() !== actor) retire()
  }
}
async function loadFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || busy.value) return
  const epoch = generation, actor = identity()
  busy.value = true; activity.value = 'Reading the selected local snapshot…'
  error.value = ''; snapshot.value = null; choices.value = []; selected.value = []; review.value = null; receipts.value = []; provenance.value = null
  try {
    if (file.size > HEDGEDOC_MAX_BYTES) throw new Error('Snapshot exceeds the 8 MiB input budget.')
    const text = await file.text()
    if (!current(epoch) || identity() !== actor) { if (current(epoch)) retire(); return }
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) throw new Error('Expected a bounded JSON snapshot or resume bundle.')
    const saved = Object.hasOwn(value, 'snapshot')
    const source = saved ? Reflect.get(value, 'snapshot') : value
    if (typeof source !== 'object' || source === null || !Array.isArray(Reflect.get(source, 'notes'))) throw new Error('Snapshot must contain selected notes.')
    const defaults: HedgeDocChoice[] = (Reflect.get(source, 'notes') as HedgeDocSnapshot['notes']).map(note => ({ sourceId: note.id, ownerId: wikiStore.user.id, target: { kind: 'create', key: `hedgedoc-${crypto.randomUUID().replace(/-/gu, '')}` }, assets: Array.isArray(note.assets) ? note.assets.map(asset => ({ sourceId: asset.id, action: 'skip' })) : [] }))
    const parsed = parseHedgeDocInput({ snapshot: source, choices: saved ? Reflect.get(value, 'choices') : defaults })
    if (parsed.choices.some(choice => choice.ownerId !== wikiStore.user.id)) throw new Error('This resume bundle maps another native owner. Sign in as that existing owner; do not replace its ownership mapping or source identity.')
    snapshot.value = parsed.snapshot
    choices.value = parsed.choices
    selected.value = choices.value.map(choice => choice.sourceId)
    invalidate()
  } catch (cause) { if (current(epoch)) error.value = cause instanceof Error ? cause.message : 'Cannot read snapshot.' }
  finally { if (current(epoch)) busy.value = false }
}
async function reviewSnapshot() {
  if (busy.value || !snapshot.value) return
  const epoch = generation
  busy.value = true; activity.value = 'Validating a read-only inventory…'; error.value = ''
  try {
    const manifest = await request<HedgeDocReview>('/review', { snapshot: snapshot.value, choices: choices.value.filter(choice => selected.value.includes(choice.sourceId)) })
    if (!current(epoch)) return
    review.value = manifest; acknowledged.value = false
  }
  catch (cause) { if (current(epoch)) { review.value = null; error.value = cause instanceof Error ? cause.message : 'Review failed.' } }
  finally { if (current(epoch)) busy.value = false }
}
function downloadBundle() {
  if (!review.value || !snapshot.value) return
  const blob = new Blob([JSON.stringify({ snapshot: snapshot.value, choices: choices.value.filter(choice => selected.value.includes(choice.sourceId)) }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `hedgedoc-review-${review.value.snapshotDigest}.json`; anchor.click(); URL.revokeObjectURL(url)
}
async function execute() {
  if (busy.value || !review.value || !snapshot.value || !acknowledged.value) return
  const epoch = generation
  busy.value = true; error.value = ''
  try {
    for (const item of review.value.items) {
      activity.value = `Importing / resuming ${item.sourceId}…`
      const choice = choices.value.find(choice => choice.sourceId === item.sourceId)!
      const receipt = await request<HedgeDocReceipt>('/execute', { snapshot: snapshot.value, choices: [choice], reviewDigest: item.reviewDigest })
      if (!current(epoch)) return
      receipts.value = [...receipts.value.filter(value => value.sourceId !== receipt.sourceId), receipt]
    }
    dirty.value = false
  } catch (cause) { if (current(epoch)) error.value = cause instanceof Error ? cause.message : 'Import interrupted. Resume the original review.' }
  finally { if (current(epoch)) busy.value = false }
}
async function loadProvenance(key: string) {
  if (busy.value) return
  const epoch = generation
  busy.value = true; activity.value = 'Reading owner-authorized source provenance…'; error.value = ''
  try {
    const retained = await request<HedgeDocProvenance>(`/provenance/${encodeURIComponent(key)}`)
    if (current(epoch)) provenance.value = retained
  }
  catch (cause) { if (current(epoch)) error.value = cause instanceof Error ? cause.message : 'Provenance is unavailable.' }
  finally { if (current(epoch)) busy.value = false }
}
</script>
<style scoped>
.hedgedoc-source { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 28rem; overflow: auto; padding: 1rem; }
.hedgedoc-digest { overflow-wrap: anywhere; }
</style>
