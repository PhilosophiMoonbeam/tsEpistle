<template>
  <section class="glossary-search" aria-labelledby="glossary-title">
    <header class="glossary-search__heading">
      <h3 id="glossary-title">{{ $t('common:glossary.title') }}</h3>
      <p>{{ $t('common:glossary.searchHint') }}</p>
    </header>
    <div class="glossary-search__content">
        <v-alert v-if="hostError || error" type="error" class="mb-4" role="alert">{{ hostError ? t('common:glossaryDirectory.requestFailed') : error }}<v-btn variant="text" @click="hostError ? emit('changed') : reload()">{{ t('common:glossaryDirectory.retry') }}</v-btn></v-alert>
        <v-alert v-if="!access.enabled && !hostError" type="info">{{ t('common:glossaryDirectory.disabled') }}</v-alert>
        <v-alert v-else-if="access.enabled && !access.canRead && !access.canManage" type="warning">{{ t('common:glossaryDirectory.forbidden') }}</v-alert>
        <template v-if="access.enabled && (access.canRead || access.canManage)">
          <div class="glossary-search__controls">
            <v-text-field :model-value="localeInput" class="glossary-search__locale" :label="t('common:glossaryDirectory.catalogLocale')" maxlength="35" density="compact" hide-details="auto" :error-messages="localeInvalid ? [t('common:glossaryDirectory.invalidLocale')] : []" :aria-invalid="localeInvalid" :disabled="saving" dir="ltr" @update:model-value="setLocale" />
            <v-btn v-if="mode !== 'directory'" :disabled="saving" variant="text" @click="directory">{{ t('common:glossaryDirectory.directory') }}</v-btn>
          </div>
          <v-progress-linear v-if="loading || catalogLoading" indeterminate :aria-label="t('common:glossaryDirectory.loading')" />
          <template v-if="mode === 'directory' && access.canRead">
            <div class="glossary-search__filters">
              <v-select v-model="letter" :items="[{ title: t('common:glossaryDirectory.allLetters'), value: null }, ...letters.map(value => ({ title: value, value }))]" :menu-props="{ contentClass: 'glossary-owned-overlay' }" :label="t('common:glossaryDirectory.initial')" density="compact" hide-details />
              <v-select v-model="category" :items="[{ title: t('common:glossaryDirectory.allCategories'), value: null }, { title: t('common:glossaryDirectory.uncategorized'), value: '' }, ...categories.map(value => ({ title: value, value }))]" :menu-props="{ contentClass: 'glossary-owned-overlay' }" :label="t('common:glossaryDirectory.category')" density="compact" hide-details />
            </div>
            <p v-if="!error" class="glossary-search__summary" role="status">{{ catalogLoading ? t('common:glossaryDirectory.loadingMatches') : t('common:glossaryDirectory.matchingTerms', { count: filtered.length }) }}</p>
            <ul class="glossary-search__terms" :aria-label="t('common:glossaryDirectory.terms')" :aria-busy="catalogLoading">
              <li v-for="item in visible" :key="item.id">
                <a class="glossary-search__term" :href="termHref(item.term)">
                  <span class="glossary-search__term-name" dir="auto">{{ item.term }}</span>
                  <span v-if="item.expansion || item.category" class="glossary-search__term-meta" dir="auto">{{ [item.expansion, item.category].filter(Boolean).join(' · ') }}</span>
                </a>
              </li>
            </ul>
            <p v-if="!catalogLoading && !error && !filtered.length">{{ t('common:glossaryDirectory.noMatches') }}</p>
            <nav v-if="filtered.length > pageSize" class="glossary-search__pagination" :aria-label="t('common:glossaryDirectory.pagination')">
              <v-btn :disabled="currentPage === 0 || catalogLoading" variant="outlined" @click="page = currentPage - 1">{{ t('common:glossaryDirectory.previous') }}</v-btn>
              <span role="status">{{ t('common:glossaryDirectory.page', { page: currentPage + 1, pages: pageCount }) }}</span>
              <v-btn :disabled="currentPage + 1 >= pageCount || catalogLoading" variant="outlined" @click="page = currentPage + 1">{{ t('common:glossaryDirectory.next') }}</v-btn>
            </nav>
          </template>
          <article v-if="mode === 'detail' && detail && access.canRead" class="glossary-search__detail" aria-labelledby="glossary-term-title">
            <h4 id="glossary-term-title" ref="detailHeading" tabindex="-1">{{ detail.term }}</h4>
            <p v-if="detail.expansion">{{ detail.expansion }}</p>
            <p v-if="detail.category">{{ t('common:glossaryDirectory.termCategory', { category: detail.category }) }}</p>
            <p v-if="detail.aliases.length">{{ t('common:glossaryDirectory.alsoKnownAs', { aliases: detail.aliases.join(', ') }) }}</p>
            <div class="contents" v-html="detailHtml" />
            <p v-if="detail.documentation"><a :href="safeDocumentation(detail.documentation.href)">{{ detail.documentation.label }}</a></p>
            <h5 v-if="detail.relatedTerms.length" class="mt-4">{{ t('common:glossaryDirectory.relatedTerms') }}</h5>
            <ul v-if="detail.relatedTerms.length"><li v-for="related in detail.relatedTerms" :key="related.id"><a :href="termHref(related.term)" @click.prevent="select(related.term)">{{ related.term }}</a></li></ul>
            <h5 v-if="detail.references.length" class="mt-4">{{ t('common:glossaryDirectory.references') }}</h5>
            <ul v-if="detail.references.length"><li v-for="reference in detail.references" :key="reference.url"><a v-if="safeReference(reference.url)" :href="reference.url" target="_blank" rel="noopener noreferrer">{{ reference.label || reference.url }}</a><span v-else>{{ reference.label || t('common:glossaryDirectory.unavailableReference') }}</span></li></ul>
            <div v-if="access.canManage" class="d-flex ga-3 mt-4"><v-btn @click="edit">{{ t('common:glossaryDirectory.edit') }}</v-btn><v-btn variant="outlined" color="error" :disabled="saving" @click="remove">{{ t('common:glossaryDirectory.delete') }}</v-btn></div>
          </article>
          <form v-if="mode === 'edit' && access.canManage" @submit.prevent="save">
            <p class="glossary-search__edit-hint">{{ $t('common:glossary.editingSearchHint') }}</p>
            <v-alert v-if="conflict" type="warning" class="mb-4" role="alert">
              {{ t('common:glossaryDirectory.conflict') }}
              <v-btn :disabled="loading || saving" variant="text" @click="loadConflict">{{ t('common:glossaryDirectory.loadRevision') }}</v-btn>
            </v-alert>
            <section v-if="latest" class="mb-4" :aria-label="t('common:glossaryDirectory.serverVersion')">
              <h3>{{ t('common:glossaryDirectory.serverRevision', { revision: latest.revision }) }}</h3>
              <p>{{ latest.term }} — {{ latest.expansion }}</p><pre>{{ JSON.stringify({ definition: latest.definition, aliases: latest.aliases, relatedTerms: latest.relatedTerms.map(item => item.term), category: latest.category, caseSensitive: latest.caseSensitive, autoLink: latest.autoLink, documentation: latest.documentation, references: latest.references }, null, 2) }}</pre>
              <v-btn variant="outlined" :disabled="saving" @click="acceptRevision">{{ t('common:glossaryDirectory.keepDraft') }}</v-btn>
              <v-btn variant="text" :disabled="saving" @click="useLatest">{{ t('common:glossaryDirectory.useServerVersion') }}</v-btn>
            </section>
            <fieldset :disabled="saving || loading" class="pa-0 ma-0 border-0">
              <v-text-field v-model="draft.term" :label="t('common:glossaryDirectory.term')" maxlength="255" required @update:model-value="touch" />
              <v-text-field v-model="draft.expansion" :label="t('common:glossaryDirectory.expansion')" maxlength="255" @update:model-value="touch" />
              <v-text-field v-model="draft.category" :label="t('common:glossaryDirectory.category')" maxlength="255" @update:model-value="touch" />
              <v-textarea v-model="draft.aliasesText" :label="t('common:glossaryDirectory.aliases')" rows="3" @update:model-value="touch" />
              <v-textarea v-model="draft.definition" :label="t('common:glossaryDirectory.definition')" maxlength="10000" rows="8" @update:model-value="touch" />
              <v-checkbox :model-value="preview" :label="t('common:glossaryDirectory.showPreview')" @update:model-value="setPreview" />
              <section v-if="preview" :aria-label="t('common:glossaryDirectory.definitionPreview')" class="contents mb-4" v-html="previewHtml" />
              <v-checkbox :model-value="draft.caseSensitive" :label="t('common:glossaryDirectory.caseSensitive')" @update:model-value="setLinkingPreference('caseSensitive', $event)" />
              <v-checkbox :model-value="draft.autoLink" :label="t('common:glossaryDirectory.autoLink')" @update:model-value="setLinkingPreference('autoLink', $event)" />
              <h3>{{ t('common:glossaryDirectory.relatedTerms') }}</h3>
              <p v-if="!draft.relatedIds.length">{{ t('common:glossaryDirectory.noRelatedTerms') }}</p>
              <ul><li v-for="id in draft.relatedIds" :key="id">{{ relatedName(id) }} <v-btn size="small" variant="text" :aria-label="t('common:glossaryDirectory.removeRelatedTerm', { term: relatedName(id) })" @click="draft.relatedIds = draft.relatedIds.filter(value => value !== id); touch()">{{ t('common:glossaryDirectory.remove') }}</v-btn></li></ul>
              <div v-if="access.canRead">
                <v-text-field v-model="relatedQuery" :label="t('common:glossaryDirectory.findRelatedTerms')" maxlength="255" />
                <v-btn variant="outlined" :disabled="relatedLoading" @click="loadRelated(false)">{{ t('common:glossaryDirectory.searchRelatedTerms') }}</v-btn>
                <v-progress-linear v-if="relatedLoading" indeterminate :aria-label="t('common:glossaryDirectory.loadingRelatedTerms')" />
                <v-list :aria-label="t('common:glossaryDirectory.relatedChoices')"><v-list-item v-for="item in relatedChoices" :key="item.id" :title="item.term" :disabled="draft.relatedIds.length >= 50 || draft.relatedIds.includes(item.id) || item.id === detail?.id" @click="draft.relatedIds.push(item.id); touch()" /></v-list>
                <v-btn v-if="relatedCursor" variant="text" :disabled="relatedLoading" @click="loadRelated(true)">{{ t('common:glossaryDirectory.moreRelatedTerms') }}</v-btn>
              </div>
              <h3 class="mt-4">{{ t('common:glossaryDirectory.documentationPage') }}</h3>
              <p>{{ documentationText }}</p>
              <p class="text-caption">{{ t('common:glossaryDirectory.protectedAssociation') }}</p>
              <v-btn variant="outlined" @click="picker = true">{{ t('common:glossaryDirectory.choosePage') }}</v-btn>
              <v-btn variant="text" @click="unlink">{{ t('common:glossaryDirectory.unlinkDocumentation') }}</v-btn>
              <v-text-field v-model="draft.documentationLabel" :label="t('common:glossaryDirectory.documentationLabel')" maxlength="255" @update:model-value="documentationDirty.label = true; touch()" />
              <h3>{{ t('common:glossaryDirectory.references') }}</h3>
              <div v-for="(reference, index) in draft.references" :key="index" class="mb-3">
                <v-text-field v-model="reference.label" :label="t('common:glossaryDirectory.referenceLabel', { number: index + 1 })" maxlength="255" @update:model-value="touch" />
                <v-text-field v-model="reference.url" :label="t('common:glossaryDirectory.referenceUrl', { number: index + 1 })" maxlength="2048" type="url" required dir="ltr" @update:model-value="touch" />
                <v-btn variant="text" @click="draft.references.splice(index, 1); touch()">{{ t('common:glossaryDirectory.removeReference', { number: index + 1 }) }}</v-btn>
              </div>
              <v-btn variant="outlined" :disabled="draft.references.length >= 20" @click="draft.references.push({ label: '', url: '' }); touch()">{{ t('common:glossaryDirectory.addReference') }}</v-btn>
            </fieldset>
            <div class="d-flex ga-3 mt-6">
              <v-btn type="submit" color="primary" :loading="saving" :disabled="saving || loading || conflict || !dirty">{{ t('common:glossaryDirectory.saveTerm') }}</v-btn>
              <v-btn :disabled="saving" variant="text" @click="cancelEdit">{{ t('common:glossaryDirectory.cancelEditing') }}</v-btn>
            </div>
          </form>
          <footer v-if="access.canManage && mode !== 'edit'" class="glossary-search__footer">
            <v-btn size="small" variant="text" prepend-icon="mdi-plus" :disabled="saving" @click="create">{{ t('common:glossaryDirectory.newTerm') }}</v-btn>
          </footer>
        </template>
    </div>
    <page-selector v-if="picker" v-model="picker" class="glossary-owned-overlay" mode="select" :locale="locale" :allow-locale-change="true" :must-exist="true" :open-handler="chooseDocumentation" />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import type { GlossaryAccess, GlossaryTerm, GlossaryTermSummary } from '../../../shared/glossary.ts'
import { deleteGlossaryTerm, fetchGlossaryPage, fetchGlossaryTerm, GlossaryApiError, lookupGlossaryTerm, saveGlossaryTerm } from '../../helpers/glossary-api.ts'
import { glossaryDraft, glossaryWrite } from '../../helpers/glossary-form.ts'
import { glossaryHref } from '../../helpers/glossary-runtime.ts'
import { glossaryIdentity } from '../../helpers/glossary-session.ts'
import { isGlossaryLocale, glossaryErrorKey } from '../../helpers/glossary-search.ts'
import { useTranslate } from '../../helpers/use-translate.ts'
import { useWikiStore } from '../../store/index.ts'
import { createWikiMarkdownRenderer } from '../editor/markdown/preview.ts'
import PageSelector from './page-selector.vue'

const props = defineProps<{ locale: string; term: string; access: GlossaryAccess; query: string; hostError?: string }>()
const emit = defineEmits<{ select: [name: string]; locale: [locale: string]; changed: [] }>()
const t = useTranslate()
const mode = ref<'directory' | 'detail' | 'edit'>('directory'), detail = ref<GlossaryTerm | null>(null), latest = ref<GlossaryTerm | null>(null)
const detailHeading = ref<HTMLElement | null>(null)
watch([mode, detail], () => {
  if (mode.value === 'detail' && detail.value && document.activeElement === document.body) detailHeading.value?.focus()
}, { flush: 'post' })
const localeInput = ref(props.locale), letter = ref<string | null>(null), category = ref<string | null>(null), page = ref(0), pageSize = 30
const localeInvalid = computed(() => !isGlossaryLocale(localeInput.value.trim()))
const catalog = ref<GlossaryTermSummary[]>([]), loading = ref(false), catalogLoading = ref(false), saving = ref(false), error = ref(''), dirty = ref(false), conflict = ref(false), preview = ref(false), picker = ref(false)
const draft = ref(glossaryDraft(props.locale)), documentationDirty = reactive({ page: false, label: false }), selectedDocumentation = ref('')
const relatedQuery = ref(''), relatedChoices = ref<GlossaryTermSummary[]>([]), relatedCursor = ref<string | null>(null), relatedLoading = ref(false)
let detailController: AbortController | undefined, catalogController: AbortController | undefined, relatedController: AbortController | undefined, saveController: AbortController | undefined
let generation = 0, relatedGeneration = 0, catalogGeneration = 0, alive = true
let catalogTimer: ReturnType<typeof setTimeout> | undefined
let catalogLocale = props.locale
const store = useWikiStore()
watch(() => glossaryIdentity(store), () => {
  alive = false; generation++; catalogGeneration++; relatedGeneration++
  detailController?.abort(); catalogController?.abort(); relatedController?.abort(); saveController?.abort()
  detail.value = null; catalog.value = []; relatedChoices.value = []; resetDraft()
}, { flush: 'sync' })
const markdown = createWikiMarkdownRenderer()
const safeHtml = (html: string): string => DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'svg', 'math', 'iframe', 'video', 'audio', 'source', 'style'], FORBID_ATTR: ['style', 'src', 'srcset'] })
const detailHtml = computed(() => safeHtml(detail.value?.definitionHtml ?? ''))
const previewHtml = computed(() => safeHtml(markdown.render(draft.value.definition)))
const initial = (name: string): string => Array.from(name.normalize('NFC').trim())[0]?.toLocaleUpperCase(props.locale) ?? '#'
const letters = computed(() => [...new Set(catalog.value.map(item => initial(item.term)))].sort((a, b) => a.localeCompare(b, props.locale)))
const categories = computed(() => [...new Set(catalog.value.map(item => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, props.locale)))
const filtered = computed(() => catalog.value.filter(item => (letter.value === null || initial(item.term) === letter.value) && (category.value === null || item.category === category.value)).sort((a, b) => a.term.localeCompare(b.term, props.locale)))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const currentPage = computed(() => Math.min(Math.max(0, page.value), pageCount.value - 1))
const visible = computed(() => filtered.value.slice(currentPage.value * pageSize, (currentPage.value + 1) * pageSize))
const documentationText = computed(() => selectedDocumentation.value || (draft.value.documentationPageId ? detail.value?.documentation?.label || t('common:glossaryDirectory.selectedPage', { id: draft.value.documentationPageId }) : t('common:glossaryDirectory.noDocumentation')))
watch([letter, category], () => { page.value = 0 }, { flush: 'sync' })
watch(pageCount, () => { page.value = currentPage.value }, { flush: 'sync' })
function message (failure: unknown): string {
  if (failure instanceof GlossaryApiError && ([401, 403].includes(failure.status) || failure.code === 'GLOSSARY_DISABLED')) {
    detail.value = null; catalog.value = []; relatedChoices.value = []; resetDraft(); emit('changed')
  }
  return t(`common:glossaryDirectory.${glossaryErrorKey(failure)}`)
}
function touch (): void { dirty.value = true }
function setPreview (value: boolean | null): void {
  if (value !== null) preview.value = value
}
function setLinkingPreference (field: 'caseSensitive' | 'autoLink', value: boolean | null): void {
  if (value === null) return
  draft.value[field] = value
  touch()
}
function canLeave (): boolean {
  if (saving.value) return false
  if (!dirty.value) return true
  if (!window.confirm(t('common:glossaryDirectory.discardChanges'))) return false
  dirty.value = false
  return true
}
defineExpose({ canLeave })
watch(() => props.query, () => {
  page.value = 0
  clearTimeout(catalogTimer)
  catalogController?.abort(); catalogGeneration++
  if (mode.value === 'edit') { catalogLoading.value = false; return }
  if (props.term) { emit('select', ''); return }
  catalogLoading.value = true
  catalogTimer = setTimeout(() => void loadCatalog(), 180)
})
function select (name: string): void { if (canLeave()) { dirty.value = false; emit('select', name) } }
function directory (): void {
  if (!canLeave()) return
  mode.value = 'directory'
  if (props.term) emit('select', '')
  else void loadCatalog()
}
function setLocale (value: string | null): void {
  localeInput.value = value ?? ''
  const locale = localeInput.value.trim()
  if (!isGlossaryLocale(locale) || locale === props.locale) return
  if (!canLeave()) { localeInput.value = props.locale; return }
  emit('locale', locale)
}
function resetDraft (term?: GlossaryTerm): void {
  draft.value = glossaryDraft(props.locale, term); documentationDirty.page = false; documentationDirty.label = false; selectedDocumentation.value = ''; dirty.value = false; latest.value = null; conflict.value = false; preview.value = false; picker.value = false
  relatedChoices.value = term?.relatedTerms ? [...term.relatedTerms] : []; relatedCursor.value = null; relatedQuery.value = ''
}
function create (): void { if (!props.access.canManage || !canLeave()) return; detailController?.abort(); generation++; detail.value = null; resetDraft(); mode.value = 'edit'; error.value = ''; loading.value = false }
function edit (): void { if (!props.access.canManage || !detail.value) return; resetDraft(detail.value); mode.value = 'edit' }
function cancelEdit (): void { if (!canLeave()) return; dirty.value = false; conflict.value = false; latest.value = null; mode.value = detail.value ? 'detail' : 'directory'; if (!detail.value) void loadCatalog() }
async function loadDetail (): Promise<void> {
  detailController?.abort(); const request = ++generation; detailController = new AbortController(); const signal = detailController.signal
  detail.value = null; error.value = ''; loading.value = true
  try {
    const result = await lookupGlossaryTerm(props.locale, props.term, signal)
    if (!alive || signal.aborted || request !== generation) return
    detail.value = result; mode.value = 'detail'; resetDraft(result)
  } catch (failure) { if (!signal.aborted && request === generation && alive) { error.value = message(failure); mode.value = 'directory' } }
  finally { if (alive && request === generation) loading.value = false }
}
async function loadCatalog (): Promise<void> {
  clearTimeout(catalogTimer)
  if (!props.access.canRead) return
  catalogController?.abort(); const request = ++catalogGeneration; catalogController = new AbortController(); const signal = catalogController.signal
  catalogLoading.value = true; error.value = ''
  let cursor: string | undefined
  const items: GlossaryTermSummary[] = []
  const seen = new Set<string>(), search = props.query, locale = props.locale
  try {
    do {
      const result = await fetchGlossaryPage(locale, search, cursor, signal)
      if (!alive || signal.aborted || request !== catalogGeneration || search !== props.query || locale !== props.locale) return
      items.push(...result.items)
      if (result.complete) break
      cursor = result.nextCursor ?? undefined
      if (!cursor || seen.has(cursor)) throw new Error('The catalog continuation did not advance. Please retry.')
      seen.add(cursor)
    } while (cursor !== undefined)
    catalog.value = items
    page.value = currentPage.value
  } catch (failure) { if (!signal.aborted && request === catalogGeneration && alive) { catalog.value = []; error.value = message(failure) } }
  finally { if (alive && request === catalogGeneration) catalogLoading.value = false }
}
async function loadRelated (more: boolean): Promise<void> {
  relatedController?.abort(); const request = ++relatedGeneration; relatedController = new AbortController(); const signal = relatedController.signal
  relatedLoading.value = true
  if (!more) { relatedChoices.value = []; relatedCursor.value = null }
  try {
    const result = await fetchGlossaryPage(props.locale, relatedQuery.value, more ? relatedCursor.value ?? undefined : undefined, signal)
    if (!alive || signal.aborted || request !== relatedGeneration) return
    relatedChoices.value.push(...result.items); relatedCursor.value = result.nextCursor
  } catch (failure) { if (!signal.aborted && alive && request === relatedGeneration) error.value = message(failure) }
  finally { if (alive && request === relatedGeneration) relatedLoading.value = false }
}
function relatedName (id: number): string { return relatedChoices.value.find(item => item.id === id)?.term ?? detail.value?.relatedTerms.find(item => item.id === id)?.term ?? t('common:glossaryDirectory.termId', { id }) }
function chooseDocumentation (selection: { id: number; locale: string; path: string }): boolean { if (!selection.id || saving.value || !props.access.canManage) return false; draft.value.documentationPageId = selection.id; selectedDocumentation.value = `/${selection.locale}/${selection.path}`; documentationDirty.page = true; touch(); return true }
function unlink (): void { draft.value.documentationPageId = null; draft.value.documentationLabel = ''; selectedDocumentation.value = t('common:glossaryDirectory.documentationUnlinked'); documentationDirty.page = true; documentationDirty.label = true; touch() }
function termHref (name: string): string { return glossaryHref(window.location.href, name) }
function safeReference (value: string): boolean { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false } }
function safeDocumentation (value: string): string | undefined { try { const url = new URL(value, window.location.origin); return url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol) ? `${url.pathname}${url.search}${url.hash}` : undefined } catch { return undefined } }
async function save (): Promise<void> {
  if (!props.access.canManage || !dirty.value || saving.value || conflict.value) return
  error.value = ''
  let input
  try { input = glossaryWrite(draft.value, documentationDirty) } catch (failure) { error.value = message(failure); return }
  saving.value = true; saveController = new AbortController(); const signal = saveController.signal
  try {
    const result = await saveGlossaryTerm(input, detail.value?.id, detail.value?.revision, signal)
    if (!alive || signal.aborted) return
    detail.value = result; resetDraft(result); mode.value = 'detail'; saving.value = false; emit('select', result.term); emit('changed')
  } catch (failure) { if (!signal.aborted && alive) { error.value = message(failure); if (detail.value && failure instanceof GlossaryApiError && failure.status === 409) conflict.value = true } }
  finally { if (alive) saving.value = false }
}
async function remove (): Promise<void> {
  if (!props.access.canManage || !detail.value || saving.value || !window.confirm(t('common:glossaryDirectory.confirmDelete', { term: detail.value.term }))) return
  saving.value = true; saveController = new AbortController(); const signal = saveController.signal
  try { await deleteGlossaryTerm(detail.value.id, detail.value.revision, signal); if (!alive || signal.aborted) return; detail.value = null; dirty.value = false; mode.value = 'directory'; saving.value = false; emit('select', ''); emit('changed'); void loadCatalog() }
  catch (failure) { if (!signal.aborted && alive) { error.value = message(failure); if (failure instanceof GlossaryApiError && failure.status === 409) { resetDraft(detail.value ?? undefined); mode.value = 'edit'; conflict.value = true } } }
  finally { if (alive) saving.value = false }
}
async function loadConflict (): Promise<void> {
  if (!detail.value || loading.value) return
  detailController?.abort(); detailController = new AbortController(); const signal = detailController.signal; loading.value = true
  try { const result = await fetchGlossaryTerm(detail.value.id, signal); if (alive && !signal.aborted) latest.value = result }
  catch (failure) { if (alive && !signal.aborted) error.value = message(failure) }
  finally { if (alive) loading.value = false }
}
function acceptRevision (): void { if (!latest.value) return; detail.value = latest.value; latest.value = null; conflict.value = false; error.value = ''; dirty.value = true }
function useLatest (): void { if (!latest.value || !canLeave()) return; const result = latest.value; detail.value = result; resetDraft(result); mode.value = 'detail' }
function reload (): void { if (!canLeave()) return; dirty.value = false; if (props.term) void loadDetail(); else void loadCatalog() }
function unload (event: BeforeUnloadEvent): void { if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = '' } }
watch(() => [props.locale, props.term, props.access.enabled, props.access.canRead, props.access.canManage], () => {
  detailController?.abort(); catalogController?.abort(); relatedController?.abort(); generation++; catalogGeneration++; relatedGeneration++
  clearTimeout(catalogTimer)
  localeInput.value = props.locale
  if (catalogLocale !== props.locale) { catalogLocale = props.locale; catalog.value = []; page.value = 0; letter.value = null; category.value = null }
  if (!props.access.enabled || !props.access.canRead) { if (!props.access.canManage) { detail.value = null; catalog.value = []; resetDraft() }; return }
  if (props.term) void loadDetail(); else { mode.value = 'directory'; void loadCatalog() }
}, { immediate: true })
onMounted(() => window.addEventListener('beforeunload', unload))
onBeforeUnmount(() => { alive = false; clearTimeout(catalogTimer); detailController?.abort(); catalogController?.abort(); relatedController?.abort(); saveController?.abort(); window.removeEventListener('beforeunload', unload) })
</script>

<style scoped>
.glossary-search { min-width: 0; padding: var(--wiki-space-5); }
.glossary-search__heading { margin-bottom: var(--wiki-space-5); }
.glossary-search__heading h3 { margin: 0; font-size: 1.25rem; font-weight: 650; }
.glossary-search__heading p, .glossary-search__edit-hint { margin: .35rem 0 0; color: var(--wiki-text-muted); line-height: 1.5; }
.glossary-search__controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-3); margin-bottom: var(--wiki-space-5); }
.glossary-search__locale { flex: 0 1 10rem; min-width: 8rem; }
.glossary-search__filters { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(12rem, 2fr); gap: var(--wiki-space-3); }
.glossary-search__summary { margin: var(--wiki-space-4) 0 var(--wiki-space-2); color: var(--wiki-text-muted); font-size: .875rem; }
.glossary-search__terms { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--wiki-surface-border); }
.glossary-search__term { display: flex; flex-direction: column; gap: .25rem; min-height: var(--wiki-control-height); padding: var(--wiki-space-3); border-bottom: 1px solid var(--wiki-surface-border); border-radius: var(--wiki-radius-xs); color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.glossary-search__term:hover { background: var(--wiki-surface-sunken); }
.glossary-search__term:focus-visible { outline: 2px solid var(--wiki-focus-color); outline-offset: -2px; }
.glossary-search__term-name { color: var(--wiki-primary-ink); font-weight: 650; }
.glossary-search__term-meta { color: var(--wiki-text-muted); font-size: .875rem; }
.glossary-search__pagination { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wiki-space-3); margin-top: var(--wiki-space-4); }
.glossary-search__footer { margin-top: var(--wiki-space-5); padding-top: var(--wiki-space-2); border-top: 1px solid var(--wiki-surface-border); text-align: start; }
.glossary-search__detail > h4 { margin: 0 0 var(--wiki-space-2); font-family: var(--wiki-font-heading); font-size: clamp(1.5rem, 4vw, 2.25rem); line-height: 1.2; overflow-wrap: anywhere; }
.glossary-search__detail > h5 { font-size: 1rem; }
.glossary-search__detail p, .glossary-search__detail li { overflow-wrap: anywhere; }
.glossary-search__content pre { max-width: 100%; overflow: auto; }
.glossary-search__edit-hint { margin-bottom: var(--wiki-space-4); }
@media (max-width: 599.98px) {
  .glossary-search { padding: var(--wiki-space-4); }
  .glossary-search__filters { grid-template-columns: 1fr; }
  .glossary-search__controls > .v-btn { min-height: var(--wiki-control-height); }
}
</style>
