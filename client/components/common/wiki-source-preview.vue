<template>
  <Teleport to="body">
    <div class="wiki-source-preview" :class="themeClasses" @mousedown.self="emit('close')">
      <section ref="panel" class="wiki-source-preview__panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" :aria-busy="loading">
        <header class="wiki-source-preview__header">
          <div><p class="wiki-source-preview__eyebrow">{{ $t('common:wikiSourcePreview.sourceNotebook') }}</p><h2 :id="titleId">{{ source?.title || $t('common:wikiSourcePreview.readLittleCloser') }}</h2></div>
          <v-btn icon="mdi-close" variant="text" :aria-label="$t('common:wikiSourcePreview.closeSourcePreview')" @click="emit('close')" />
        </header>
        <div class="wiki-source-preview__body" tabindex="0" role="region" :aria-label="$t('common:wikiSourcePreview.sourceExcerpt')">
          <div v-if="loading" class="wiki-source-preview__state" role="status"><v-progress-circular indeterminate size="24" width="2" /><p>{{ $t('common:wikiSourcePreview.openingSource') }}</p></div>
          <div v-else-if="error" class="wiki-source-preview__state" role="alert"><v-icon icon="mdi-file-hidden" size="30" /><p>{{ error }}</p><v-btn variant="tonal" @click="loadSource">{{ $t('common:wikiSourcePreview.tryAgain') }}</v-btn></div>
          <template v-else-if="source">
            <div class="wiki-source-preview__metadata"><span>{{ source.locale.toUpperCase() }}</span><span v-if="source.visibility === 'private'">{{ $t('common:wikiSourcePreview.privatePage') }}</span><span>{{ $t('common:wikiSourcePreview.revision', { sourceRevision: source.sourceRevision, interpolation: { escapeValue: false } }) }}</span></div>
            <p class="wiki-source-preview__path">{{ source.path }}</p>
            <p v-if="source.description" class="wiki-source-preview__description">{{ source.description }}</p>
            <div class="wiki-source-preview__caption"><span>{{ excerptParts.some(part => part.match) ? $t('common:wikiSourcePreview.passageMatchingSearch') : $t('common:wikiSourcePreview.page') }}</span><time :datetime="source.updatedAt">{{ $t('common:wikiSourcePreview.updated', { updated, interpolation: { escapeValue: false } }) }}</time></div>
            <p v-if="source.excerpt" class="wiki-source-preview__excerpt"><template v-for="(part, index) in excerptParts" :key="index"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
            <p v-else class="wiki-source-preview__empty">{{ $t('common:wikiSourcePreview.pageHasNoPreview') }}</p>
            <p v-if="source.excerptTruncated" class="wiki-source-preview__footnote">{{ $t('common:wikiSourcePreview.excerptCurrentPageOpen') }}</p>
          </template>
        </div>
        <footer v-if="source && !loading && !error" class="wiki-source-preview__actions">
          <v-btn :href="wikiSourceHref(source)" target="_blank" rel="noopener noreferrer" variant="text" append-icon="mdi-open-in-new">{{ $t('common:wikiSourcePreview.openPage') }}<span class="sr-only"> {{ $t('common:wikiSourcePreview.newTab') }}</span></v-btn>
          <v-btn v-if="canAsk" class="wiki-source-preview__ask" variant="tonal" prepend-icon="mdi-text-box-plus-outline" @click="emit('ask', source)">{{ $t('common:wikiSourcePreview.askAboutPage') }}</v-btn>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useTheme } from 'vuetify'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { wikiSourceHref, type WikiSource, type WikiSourceSelector } from '../../../shared/wiki-source.ts'
import { fetchWikiSource } from '../../helpers/wiki-source.ts'
import { createModalFocusScope, type ModalFocusScope } from './modal-focus-scope.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const props = defineProps<{ selector: WikiSourceSelector; query?: string; canAsk?: boolean }>()
const emit = defineEmits<{ close: []; ask: [source: WikiSource] }>()
const { themeClasses } = useTheme()
const titleId = useId()
const panel = useTemplateRef<HTMLElement>('panel')
const source = ref<WikiSource | null>(null)
const loading = ref(true)
const error = ref('')
let request: AbortController | null = null
let focusScope: ModalFocusScope | null = null
const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
const updated = computed(() => source.value ? new Date(source.value.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '')
const excerptParts = computed(() => {
  const text = source.value?.excerpt ?? ''
  const terms = props.query?.match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 12) ?? []
  if (!terms.length) return [{ text, match: false }]
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  return text.split(pattern).map((text, index) => ({ text, match: index % 2 === 1 }))
})
const loadSource = async (): Promise<void> => {
  request?.abort()
  const current = new AbortController()
  request = current
  source.value = null
  error.value = ''
  loading.value = true
  try { const result = await fetchWikiSource(props.selector, props.query ?? '', current.signal); if (!current.signal.aborted) source.value = result }
  catch (value) { if (!current.signal.aborted) error.value = value instanceof Error ? value.message : t('common:wikiSourcePreview.sourceUnavailable') }
  finally { if (!current.signal.aborted) loading.value = false }
}
watch(() => [props.selector, props.query], () => void loadSource())
onMounted(async () => {
  await nextTick()
  if (panel.value) { focusScope = createModalFocusScope({ root: panel.value, restoreTarget, onEscape: () => emit('close') }); focusScope.focusFirst() }
  void loadSource()
})
onBeforeUnmount(() => { request?.abort(); focusScope?.deactivate() })
</script>

<style scoped>
.wiki-source-preview { position: fixed; inset: 0; z-index: 2800; display: flex; justify-content: flex-end; background: rgb(0 0 0 / .42); backdrop-filter: blur(3px); }
.wiki-source-preview__panel { display: flex; flex-direction: column; width: min(42rem, 100%); height: 100%; background: var(--wiki-surface-raised, rgb(var(--v-theme-surface))); color: rgb(var(--v-theme-on-surface)); box-shadow: -12px 0 60px rgb(0 0 0 / .18); }
.wiki-source-preview__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 2rem 1.75rem 1.25rem; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12); }
.wiki-source-preview__ask { color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); }
.wiki-source-preview__eyebrow { font-size: .68rem; text-transform: uppercase; letter-spacing: .16em; color: color-mix(in srgb, rgb(var(--v-theme-primary)) 35%, rgb(var(--v-theme-on-surface))); font-weight: 700; margin: 0 0 .75rem; }
.wiki-source-preview h2 { margin: 0; font-family: var(--wiki-font-display, 'Newsreader', serif); font-size: clamp(1.7rem, 4vw, 2.5rem); font-weight: 500; line-height: 1.12; overflow-wrap: anywhere; }
.wiki-source-preview__body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 1.75rem; }
.wiki-source-preview__metadata { display: flex; flex-wrap: wrap; gap: .5rem 1rem; font-size: .7rem; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; }
.wiki-source-preview__path { font-size: .78rem; opacity: .6; overflow-wrap: anywhere; margin: .4rem 0 1.5rem; }
.wiki-source-preview__description { font-size: 1rem; line-height: 1.65; margin-bottom: 2rem; opacity: .78; }
.wiki-source-preview__caption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem; font-size: .7rem; opacity: .65; border-bottom: 1px solid rgba(var(--v-theme-on-surface), .12); padding-bottom: .65rem; margin-bottom: 1.2rem; }
.wiki-source-preview__excerpt { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; font-size: .95rem; }
.wiki-source-preview mark { background: rgba(var(--v-theme-primary), .22); color: inherit; border-radius: .15rem; }
.wiki-source-preview__footnote, .wiki-source-preview__empty { font-size: .78rem; line-height: 1.6; opacity: .65; margin-top: 1.75rem; }
.wiki-source-preview__state { padding: 4rem 1rem; text-align: center; }
.wiki-source-preview__state p { margin: 1rem 0; }
.wiki-source-preview__actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .75rem; padding: 1rem 1.75rem max(1rem, env(safe-area-inset-bottom)); border-top: 1px solid rgba(var(--v-theme-on-surface), .12); }
@media(max-width: 480px) { .wiki-source-preview__header, .wiki-source-preview__body { padding: 1.25rem; } .wiki-source-preview__actions { padding-inline: 1rem; } }
</style>
