<template>
  <section class="search-evaluate" aria-labelledby="search-evaluate-title">
    <header><div class="search-kicker">Query evaluation</div><h2 id="search-evaluate-title">Find out what comes back.</h2><p>Run the same search readers use, then inspect the matching fields and relative scores.</p></header>
    <v-form class="query-form" @submit.prevent="evaluate()">
      <v-text-field v-model="query" label="Search query" prepend-inner-icon="mdi-magnify" maxlength="1000" hide-details clearable />
      <div class="query-scope"><v-text-field v-model="locale" label="Locale (optional)" hint="For example, en" persistent-hint maxlength="35" /><v-text-field v-model="path" label="Page path (optional)" hint="Limit the search to a page tree" persistent-hint maxlength="1024" /></div>
      <div class="query-actions"><span>Uses saved configuration and your current page permissions.</span><v-btn type="submit" color="primary" prepend-icon="mdi-play-outline" :disabled="!query?.trim() || loading" :loading="loading">Evaluate query</v-btn></div>
    </v-form>
    <v-alert v-if="error" type="error" variant="tonal" class="mt-4" role="alert">{{ error }}</v-alert>
    <v-skeleton-loader v-if="loading && !result" type="list-item-three-line, list-item-three-line" class="mt-4" />
    <template v-if="result">
      <div class="query-summary" role="status"><div><h3>Results for “{{ submitted.query }}”</h3><p>{{ rows.length }} shown · {{ elapsedMs }} ms round trip<span v-if="submitted.locale"> · {{ submitted.locale }}</span><span v-if="submitted.path"> · {{ submitted.path }}</span></p></div><span>Scores are relative to this query</span></div>
      <v-alert v-if="result.windowTruncated" type="info" variant="tonal" density="compact">This search uses a bounded candidate window. Narrow the query or scope to evaluate more specific content.</v-alert>
      <div v-if="result.suggestions.length" class="query-suggestions"><span>Try a spelling suggestion</span><v-btn v-for="suggestion in result.suggestions" :key="suggestion" variant="tonal" size="small" :disabled="loading" @click="query = suggestion; evaluate()">{{ suggestion }}</v-btn></div>
      <ol v-if="rows.length" class="query-results">
        <li v-for="(row, index) in rows" :key="row.id">
          <span class="query-rank">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="query-result"><div class="query-result__title"><a :href="pageUrl(row)" target="_blank" rel="noopener">{{ row.title }}<v-icon size="14" aria-label="Opens in a new tab">mdi-open-in-new</v-icon></a><span>{{ row.score.toLocaleString(undefined, { maximumFractionDigits: 3 }) }}</span></div><code>{{ row.locale }}/{{ row.path }}</code><p v-if="row.description">{{ row.description }}</p><div class="query-evidence"><span>Matched</span><v-chip v-for="field in row.matchedFields" :key="field" size="x-small" variant="tonal">{{ matchFieldLabel(field) }}</v-chip><span v-if="!row.matchedFields.length">No field evidence reported</span><v-chip v-if="row.visibility === 'private'" size="x-small" prepend-icon="mdi-lock-outline" variant="outlined">Private</v-chip></div></div>
        </li>
      </ol>
      <div v-else class="query-empty"><v-icon size="32">mdi-text-search</v-icon><h3>No matching pages</h3><p>Try a broader query or remove a scope filter. Unpublished and inaccessible pages may be excluded by the search service.</p></div>
      <v-btn v-if="result.nextCursor" class="mt-4" variant="outlined" :loading="loading" :disabled="loading" @click="evaluate(result.nextCursor)">Load more results</v-btn>
    </template>
    <div v-else-if="!loading && !error" class="query-empty"><v-icon size="32">mdi-text-box-search-outline</v-icon><h3>Start with a real question</h3><p>Try a page title, a subject your readers ask about, or a phrase you expect the wiki to contain.</p></div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { searchPages, type PageSearchResult, type PageSearchRow } from '../../helpers/pages-api.ts'
const query = ref<string | null>('')
const locale = ref('')
const path = ref('')
const submitted = shallowRef({ query: '', locale: '', path: '' })
const loading = ref(false)
const error = ref('')
const result = shallowRef<PageSearchResult | null>(null)
const rows = shallowRef<PageSearchRow[]>([])
const elapsedMs = ref(0)
let controller: AbortController | null = null
const pageUrl = (row: PageSearchRow) => `/${encodeURIComponent(row.locale)}/${row.path.split('/').map(encodeURIComponent).join('/')}`
const matchFieldLabel = (field: PageSearchRow['matchedFields'][number]): string => field === 'knowledge' ? 'knowledge hints' : field
async function evaluate(cursor?: string | null) {
  if (loading.value) return
  const input = cursor ? submitted.value : { query: query.value?.trim() || '', locale: locale.value.trim(), path: path.value.trim() }
  if (!input.query) return
  controller?.abort()
  const request = new AbortController()
  controller = request
  loading.value = true
  error.value = ''
  if (!cursor) { result.value = null; rows.value = []; submitted.value = input }
  const started = performance.now()
  try {
    const response = await searchPages((url, init) => window.fetch(url, { ...init, signal: request.signal }), input.query, { locale: input.locale, path: input.path, paginated: true, ...(cursor ? { cursor } : {}) })
    if (request.signal.aborted) return
    elapsedMs.value = Math.round(performance.now() - started)
    result.value = response
    rows.value = cursor ? [...rows.value, ...response.results.filter(row => !rows.value.some(existing => String(existing.id) === String(row.id)))] : response.results
  } catch (value) { if (!request.signal.aborted) error.value = value instanceof Error ? value.message : 'Search could not be evaluated.' }
  finally { if (controller === request) loading.value = false }
}
onBeforeUnmount(() => controller?.abort())
</script>

<style scoped>
.search-evaluate { max-width: 66rem; }
.search-kicker { color: var(--wiki-accent-ink); font-size: .75rem; letter-spacing: .09em; text-transform: uppercase; }
h2 { font: 500 1.8rem var(--wiki-font-display); margin-block: .5rem; }
h3 { font-size: 1rem; }
header p { font-size: .9rem; line-height: 1.6; margin-bottom: 1.5rem; }
.query-form { padding: clamp(1rem, 2vw, 1.75rem); border: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-panel-radius); background: var(--wiki-surface-raised); }
.query-scope { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem; }
.query-actions, .query-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; }
.query-actions span, .query-summary p, .query-summary > span { font-size: .8rem; line-height: 1.6; }
.query-summary { margin-block: 2rem 1rem; }
.query-summary h3 { overflow-wrap: anywhere; }
.query-results { list-style: none; padding: 0; border-top: 1px solid var(--wiki-surface-border); }
.query-results li { display: flex; gap: 1.25rem; padding-block: 1.5rem; border-bottom: 1px solid var(--wiki-surface-border); }
.query-rank { font: .85rem var(--wiki-font-mono); padding-top: .15rem; }
.query-result { min-width: 0; flex: 1; }
.query-result__title { display: flex; align-items: start; gap: 1rem; justify-content: space-between; }
.query-result__title > span { font: .8rem var(--wiki-font-mono); }
.query-result a { color: var(--wiki-accent-ink); font-weight: 600; overflow-wrap: anywhere; }
.query-result code { font: .75rem var(--wiki-font-mono); overflow-wrap: anywhere; }
.query-result p { margin-block: .6rem; font-size: .85rem; line-height: 1.6; }
.query-evidence, .query-suggestions { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; font-size: .75rem; margin-top: .75rem; }
.query-empty { text-align: center; padding: 3rem 1rem; }
.query-empty h3 { margin-block: .75rem; }
.query-empty p { font-size: .85rem; line-height: 1.6; max-width: 50ch; margin-inline: auto; }
@media (max-width: 600px) { .query-scope { grid-template-columns: 1fr; } .query-results li { gap: .75rem; } }
</style>
