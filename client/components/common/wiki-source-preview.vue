<template>
  <Teleport to="body">
    <div class="wiki-source-preview" :class="themeClasses" @mousedown.self="emit('close')">
      <section ref="panel" class="wiki-source-preview__panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" :aria-busy="loading">
        <header class="wiki-source-preview__header">
          <div><p class="wiki-source-preview__eyebrow">{{ $t('common:wikiSourcePreview.workbenchLabel', { defaultValue: 'Source preview' }) }}</p><h2 :id="titleId">{{ source?.title || $t('common:wikiSourcePreview.readLittleCloser') }}</h2></div>
          <v-btn icon="mdi-close" variant="text" :aria-label="$t('common:wikiSourcePreview.closeSourcePreview')" @click="emit('close')" />
        </header>
        <div class="wiki-source-preview__body" tabindex="0" role="region" :aria-label="$t('common:wikiSourcePreview.sourceExcerpt')">
          <div v-if="loading" class="wiki-source-preview__state" role="status"><v-progress-circular indeterminate size="24" width="2" /><p>{{ $t('common:wikiSourcePreview.openingSource') }}</p></div>
          <div v-else-if="error" class="wiki-source-preview__state" role="alert"><v-icon icon="mdi-file-hidden" size="30" /><p>{{ error }}</p><v-btn variant="tonal" @click="loadSource">{{ $t('common:wikiSourcePreview.tryAgain') }}</v-btn></div>
          <template v-else-if="source">
            <div class="wiki-source-preview__metadata"><span>{{ source.locale.toUpperCase() }}</span><span v-if="source.visibility === 'private'">{{ $t('common:wikiSourcePreview.privatePage') }}</span><span>{{ $t('common:wikiSourcePreview.revision', { sourceRevision: source.sourceRevision, interpolation: { escapeValue: false } }) }}</span></div>
            <p class="wiki-source-preview__path">{{ source.path }}</p>
            <p v-if="source.description" class="wiki-source-preview__description">{{ source.description }}</p>
            <div class="wiki-source-preview__caption"><span>{{ hasExcerptMatch ? $t('common:wikiSourcePreview.passageMatchingSearch') : $t('common:wikiSourcePreview.page') }}</span><time :datetime="source.updatedAt">{{ $t('common:wikiSourcePreview.updated', { updated, interpolation: { escapeValue: false } }) }}</time></div>
            <p v-if="source.excerpt" class="wiki-source-preview__excerpt"><template v-for="(part, index) in excerptParts" :key="index"><mark v-if="part.matched">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></p>
            <p v-else class="wiki-source-preview__empty">{{ $t('common:wikiSourcePreview.pageHasNoPreview') }}</p>
            <p v-if="source.excerptTruncated" class="wiki-source-preview__footnote">{{ $t('common:wikiSourcePreview.excerptCurrentPageOpen') }}</p>
          </template>
        </div>
        <footer v-if="source && !loading && !error" class="wiki-source-preview__actions">
          <div class="wiki-source-preview__action-buttons">
            <v-btn :href="wikiSourceHref(source)" target="_blank" rel="noopener noreferrer" variant="text" append-icon="mdi-open-in-new">{{ $t('common:wikiSourcePreview.openPage') }}<span class="sr-only"> {{ $t('common:wikiSourcePreview.newTab') }}</span></v-btn>
            <v-btn v-if="canAsk" class="wiki-source-preview__ask" variant="tonal" prepend-icon="mdi-text-box-plus-outline" @click="emit('ask', source)">{{ $t('common:wikiSourcePreview.askAboutPage') }}</v-btn>
          </div>
          <p v-if="canAsk" class="wiki-source-preview__draft-hint">{{ $t('common:wikiSourcePreview.draftOnlyHint', { defaultValue: 'Ask prepares a draft. Nothing is sent.' }) }}</p>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useTheme } from 'vuetify'
import { computed, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { wikiSourceHref } from '../../../shared/wiki-source.ts'
import type { WikiSource, WikiSourceSelector } from '../../../shared/wiki-source.ts'
import { fetchWikiSource } from '../../helpers/wiki-source.ts'
import { createSearchHighlighter } from '../../helpers/search-highlight.ts'
import { createModalFocusScope } from './modal-focus-scope.ts'
import type { ModalFocusScope } from './modal-focus-scope.ts'
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
const excerptHighlighter = computed(() => createSearchHighlighter(props.query ?? ''))
const excerptParts = computed(() => excerptHighlighter.value(source.value?.excerpt ?? ''))
const hasExcerptMatch = computed(() => excerptParts.value.some(part => part.matched))
const loadSource = async (): Promise<void> => {
  request?.abort()
  const current = new AbortController()
  request = current
  const selector = props.selector
  const query = props.query ?? ''
  // Fence prop changes too, before Vue's batched watcher starts their replacement request.
  const isCurrent = (): boolean => request === current && !current.signal.aborted && props.selector === selector && (props.query ?? '') === query
  source.value = null
  error.value = ''
  loading.value = true
  try {
    const result = await fetchWikiSource(selector, query, current.signal)
    if (isCurrent()) source.value = result
  } catch (value) {
    if (isCurrent()) error.value = value instanceof Error ? value.message : t('common:wikiSourcePreview.sourceUnavailable')
  } finally {
    if (isCurrent()) loading.value = false
  }
}
watch(() => [props.selector, props.query], () => void loadSource())
// Retry and selector changes remove their focused controls; keep Escape reachable while loading.
watch(loading, () => {
  if (!focusScope?.containsFocus()) focusScope?.focusFirst()
}, { flush: 'post' })
onMounted(() => {
  if (panel.value) { focusScope = createModalFocusScope({ root: panel.value, restoreTarget, onEscape: () => emit('close') }); focusScope.focusFirst() }
  void loadSource()
})
onBeforeUnmount(() => {
  request?.abort()
  request = null
  focusScope?.deactivate()
  focusScope = null
})
</script>

<style scoped>
.wiki-source-preview { position: fixed; inset: 0; z-index: 2800; display: flex; justify-content: flex-end; container: wiki-source-reader / size; background: rgb(var(--v-theme-background)); }
.wiki-source-preview__panel { display: flex; flex-direction: column; width: min(48rem, 100%); height: 100%; min-width: 0; background: var(--wiki-surface-raised, rgb(var(--v-theme-surface))); color: rgb(var(--v-theme-on-surface)); border-inline-start: 1px solid var(--wiki-surface-border); }
.wiki-source-preview__header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: var(--wiki-space-4, 1rem); padding: max(var(--wiki-space-5, 1.25rem), env(safe-area-inset-top)) max(var(--wiki-space-5, 1.25rem), env(safe-area-inset-right)) var(--wiki-space-4, 1rem) max(var(--wiki-space-5, 1.25rem), env(safe-area-inset-left)); border-bottom: 1px solid var(--wiki-surface-border); }
.wiki-source-preview__header > div { min-width: 0; }
.wiki-source-preview__header > .v-btn { flex-shrink: 0; }
.wiki-source-preview__ask, .wiki-source-preview__eyebrow { color: var(--wiki-primary-ink, rgb(var(--v-theme-on-surface))); }
.wiki-source-preview__eyebrow { font-size: var(--wiki-type-label, .8125rem); font-weight: 650; margin: 0 0 var(--wiki-space-2, .5rem); }
.wiki-source-preview h2 { margin: 0; font-family: var(--wiki-font-heading, inherit); font-size: clamp(1.25rem, 3vw, 1.75rem); font-weight: 700; line-height: 1.4; overflow-wrap: anywhere; }
.wiki-source-preview__body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: var(--wiki-space-6, 1.5rem) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-right)) var(--wiki-space-8, 2rem) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-left)); }
.wiki-source-preview__body:focus-visible { outline: 2px solid var(--wiki-focus-color, currentColor); outline-offset: -4px; }
.wiki-source-preview__metadata { display: flex; flex-wrap: wrap; gap: var(--wiki-space-2, .5rem) var(--wiki-space-4, 1rem); font-size: var(--wiki-type-label, .8125rem); font-weight: var(--wiki-label-weight, 650); line-height: 1.5; overflow-wrap: anywhere; }
.wiki-source-preview__path { font-size: var(--wiki-type-body-sm, .875rem); line-height: 1.5; color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); overflow-wrap: anywhere; margin: var(--wiki-space-2, .5rem) 0 var(--wiki-space-6, 1.5rem); }
.wiki-source-preview__description { font-size: 1rem; line-height: var(--wiki-leading-body, 1.625); margin: 0 0 var(--wiki-space-5, 1.25rem); padding-bottom: var(--wiki-space-4, 1rem); border-bottom: 1px solid var(--wiki-surface-border); color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); overflow-wrap: anywhere; }
.wiki-source-preview__caption { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: var(--wiki-space-2, .5rem) var(--wiki-space-4, 1rem); font-size: var(--wiki-type-label, .8125rem); line-height: 1.5; color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); border-bottom: 1px solid var(--wiki-surface-border); padding-bottom: var(--wiki-space-3, .75rem); margin-bottom: var(--wiki-space-5, 1.25rem); }
.wiki-source-preview__caption > span { font-weight: var(--wiki-label-weight, 650); }
.wiki-source-preview__excerpt { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--wiki-font-reader, inherit); line-height: 1.8; font-size: 1rem; }
.wiki-source-preview mark { background: rgba(var(--v-theme-primary), .18); color: inherit; border-radius: .15rem; }
.wiki-source-preview__footnote, .wiki-source-preview__empty { font-size: var(--wiki-type-body-sm, .875rem); line-height: var(--wiki-leading-body, 1.625); color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); margin: var(--wiki-space-6, 1.5rem) 0 0; }
.wiki-source-preview__state { padding: var(--wiki-space-12, 3rem) var(--wiki-space-4, 1rem); text-align: center; line-height: var(--wiki-leading-body, 1.625); overflow-wrap: anywhere; }
.wiki-source-preview__state p { margin: var(--wiki-space-4, 1rem) 0; }
.wiki-source-preview__actions { flex: 0 0 auto; padding: var(--wiki-space-4, 1rem) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-right)) max(var(--wiki-space-4, 1rem), env(safe-area-inset-bottom)) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-left)); border-top: 1px solid var(--wiki-surface-border); }
.wiki-source-preview__action-buttons { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--wiki-space-3, .75rem); }
.wiki-source-preview__action-buttons > .v-btn { max-width: 100%; min-height: var(--wiki-control-height, 2.75rem); height: auto; padding-block: var(--wiki-space-3, .75rem); }
.wiki-source-preview__action-buttons :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; }
.wiki-source-preview__draft-hint { margin: var(--wiki-space-3, .75rem) 0 0; font-size: var(--wiki-type-label, .8125rem); line-height: 1.5; color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); }
@media (max-width: 480px) {
  .wiki-source-preview__header { padding: max(var(--wiki-space-5, 1.25rem), env(safe-area-inset-top)) max(var(--wiki-space-4, 1rem), env(safe-area-inset-right)) var(--wiki-space-5, 1.25rem) max(var(--wiki-space-4, 1rem), env(safe-area-inset-left)); }
  .wiki-source-preview__body, .wiki-source-preview__actions { padding-inline: max(var(--wiki-space-4, 1rem), env(safe-area-inset-left)) max(var(--wiki-space-4, 1rem), env(safe-area-inset-right)); }
  .wiki-source-preview__action-buttons { flex-direction: column; align-items: stretch; }
}
/* Container rem units track enlarged root text, unlike viewport media-query rem units. */
@container wiki-source-reader (height < 38rem) {
  .wiki-source-preview__panel { overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .wiki-source-preview__body { flex: 1 0 auto; min-height: auto; overflow: visible; scrollbar-gutter: auto; }
}
</style>
