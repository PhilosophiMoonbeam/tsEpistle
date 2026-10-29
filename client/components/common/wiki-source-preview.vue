<template>
  <Teleport to="body">
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: Backdrop-only pointer dismissal supplements the named Close button and focus-scope Escape handling. -->
    <div ref="backdrop" class="wiki-source-preview" :class="themeClasses" :dir="isRtl ? 'rtl' : 'ltr'" @mousedown.self="emit('close')">
      <section ref="panel" class="wiki-source-preview__panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1" :aria-busy="loading">
        <header class="wiki-source-preview__header">
          <div><p class="wiki-source-preview__eyebrow">{{ $t('common:wikiSourcePreview.sourceNotebook') }}</p><h2 :id="titleId" :lang="source?.locale" dir="auto">{{ source?.title || $t('common:wikiSourcePreview.readLittleCloser') }}</h2></div>
          <v-btn icon="mdi-close" variant="text" :aria-label="$t('common:wikiSourcePreview.closeSourcePreview')" @click="emit('close')" />
        </header>
        <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This named overflow-y scroll region must remain keyboard-focusable to scroll the excerpt. -->
        <section class="wiki-source-preview__body" tabindex="0" :aria-label="$t('common:wikiSourcePreview.sourceExcerpt')">
          <div v-if="loading" class="wiki-source-preview__state" role="status"><v-progress-circular indeterminate size="24" width="2" /><p>{{ $t('common:wikiSourcePreview.openingSource') }}</p></div>
          <div v-else-if="error" class="wiki-source-preview__state" role="alert"><v-icon icon="mdi-file-hidden" size="30" /><p>{{ error }}</p><v-btn variant="tonal" @click="loadSource">{{ $t('common:wikiSourcePreview.tryAgain') }}</v-btn></div>
          <template v-else-if="source">
            <div class="wiki-source-preview__metadata"><span>{{ source.locale.toUpperCase() }}</span><span v-if="source.visibility === 'private'">{{ $t('common:wikiSourcePreview.privatePage') }}</span><span>{{ $t('common:wikiSourcePreview.revision', { sourceRevision: source.sourceRevision, interpolation: { escapeValue: false } }) }}</span></div>
            <p class="wiki-source-preview__path" dir="ltr">{{ source.path }}</p>
            <p v-if="source.description" class="wiki-source-preview__description" :lang="source.locale" dir="auto">{{ source.description }}</p>
            <div class="wiki-source-preview__caption"><span>{{ $t('common:wikiSourcePreview.page') }}</span><time :datetime="source.updatedAt">{{ $t('common:wikiSourcePreview.updated', { updated, interpolation: { escapeValue: false } }) }}</time></div>
            <!-- Sanitized passive current-render HTML; highlighting replaces text nodes only. -->
            <div v-if="renderedExcerpt.html" class="wiki-source-preview__excerpt" :lang="source.locale" dir="auto" v-html="renderedExcerpt.html" />
            <p v-else class="wiki-source-preview__empty">{{ $t(source.structuredExcerpt.truncated ? 'common:wikiSourcePreview.structuredUnavailable' : 'common:wikiSourcePreview.pageHasNoPreview') }}</p>
            <p v-if="source.structuredExcerpt.truncated" class="wiki-source-preview__footnote">{{ $t('common:wikiSourcePreview.structuredContinuation') }}</p>
          </template>
        </section>
        <footer v-if="source && !loading && !error" class="wiki-source-preview__actions">
          <div class="wiki-source-preview__action-buttons">
            <v-btn :href="wikiSourceHref(source)" target="_blank" rel="noopener noreferrer" variant="text" append-icon="mdi-open-in-new">{{ $t('common:wikiSourcePreview.openPage') }}<span class="sr-only"> {{ $t('common:wikiSourcePreview.newTab') }}</span></v-btn>
            <v-btn v-if="canAsk" class="wiki-source-preview__ask" variant="tonal" prepend-icon="mdi-text-box-plus-outline" @click="emit('ask', WikiSourceSchema.parse(source))">{{ $t('common:wikiSourcePreview.askAboutPage') }}</v-btn>
          </div>
          <p v-if="canAsk" class="wiki-source-preview__draft-hint">{{ $t('common:wikiSourcePreview.draftOnlyHint', { defaultValue: 'Ask prepares a draft. Nothing is sent.' }) }}</p>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useRtl, useTheme } from 'vuetify'
import { computed, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { WikiSourceSchema, wikiSourceHref } from '../../../shared/wiki-source.ts'
import type { WikiSource, WikiSourcePreview, WikiSourceSelector } from '../../../shared/wiki-source.ts'
import { fetchWikiSourcePreview, renderWikiSourcePreview, WikiSourceLoadError } from '../../helpers/wiki-source.ts'
import { createModalFocusScope } from './modal-focus-scope.ts'
import type { ModalFocusScope } from './modal-focus-scope.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()
const props = defineProps<{ selector: WikiSourceSelector; query?: string; canAsk?: boolean }>()
const emit = defineEmits<{ close: []; ask: [source: WikiSource] }>()
const { themeClasses } = useTheme()
const { isRtl } = useRtl()
const titleId = useId()
const panel = useTemplateRef<HTMLElement>('panel')
const backdrop = useTemplateRef<HTMLElement>('backdrop')
const source = ref<WikiSourcePreview | null>(null)
const loading = ref(true)
const error = ref('')
let request: AbortController | null = null
let focusScope: ModalFocusScope | null = null
const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
const updated = computed(() => source.value ? new Date(source.value.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '')
const renderedExcerpt = computed(() => source.value
  ? renderWikiSourcePreview(source.value, props.query ?? '', titleId, t('common:wikiSourcePreview.scrollableTable'))
  : { html: '', matched: false })
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
    const result = await fetchWikiSourcePreview(selector, query, current.signal)
    if (isCurrent()) source.value = result
  } catch (value) {
    if (isCurrent()) error.value = value instanceof WikiSourceLoadError
      ? t(value.status === 503 ? 'common:wikiSourcePreview.renderPending' : value.status === 403 ? 'common:wikiSourcePreview.unlockRequired' : value.status === 404 ? 'common:wikiSourcePreview.noLongerAvailable' : 'common:wikiSourcePreview.loadFailed')
      : value instanceof Error ? value.message : t('common:wikiSourcePreview.sourceUnavailable')
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
  if (panel.value) {
    focusScope = createModalFocusScope({
      root: panel.value,
      restoreTarget,
      backdropRoots: () => backdrop.value ? [backdrop.value] : [],
      onEscape: () => emit('close')
    })
    focusScope.focusFirst()
  }
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
.wiki-source-preview { position: fixed; inset: 0; z-index: 2800; display: flex; justify-content: flex-end; container: wiki-source-reader / size; background: rgb(0 0 0 / .42); backdrop-filter: blur(3px); }
.wiki-source-preview__panel { display: flex; flex-direction: column; width: min(42rem, 100%); height: 100%; min-width: 0; background: var(--wiki-surface-raised, rgb(var(--v-theme-surface))); color: rgb(var(--v-theme-on-surface)); box-shadow: -12px 0 60px rgb(0 0 0 / .18); }
.wiki-source-preview[dir="rtl"] .wiki-source-preview__panel { box-shadow: 12px 0 60px rgb(0 0 0 / .18); }
.wiki-source-preview__header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: var(--wiki-space-4, 1rem); padding: max(var(--wiki-space-8, 2rem), env(safe-area-inset-top)) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-right)) var(--wiki-space-5, 1.25rem) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-left)); border-bottom: 1px solid var(--wiki-surface-border); }
.wiki-source-preview__header > div { min-width: 0; }
.wiki-source-preview__header > .v-btn { flex-shrink: 0; }
.wiki-source-preview__ask, .wiki-source-preview__eyebrow { color: var(--wiki-primary-ink, rgb(var(--v-theme-on-surface))); }
.wiki-source-preview__eyebrow { font-size: var(--wiki-type-micro, .75rem); text-transform: uppercase; letter-spacing: .12em; font-weight: 700; margin: 0 0 var(--wiki-space-3, .75rem); }
.wiki-source-preview h2 { margin: 0; font-family: var(--wiki-font-display, 'Newsreader', serif); font-size: clamp(1.7rem, 4vw, 2.5rem); font-weight: 500; line-height: var(--wiki-leading-heading, 1.12); overflow-wrap: anywhere; }
.wiki-source-preview__body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: var(--wiki-space-6, 1.5rem) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-right)) var(--wiki-space-8, 2rem) max(var(--wiki-space-6, 1.5rem), env(safe-area-inset-left)); }
.wiki-source-preview__body:focus-visible { outline: 2px solid var(--wiki-focus-color, currentColor); outline-offset: -4px; }
.wiki-source-preview__metadata { display: flex; flex-wrap: wrap; gap: var(--wiki-space-2, .5rem) var(--wiki-space-4, 1rem); font-size: var(--wiki-type-label, .8125rem); font-weight: var(--wiki-label-weight, 650); line-height: 1.5; overflow-wrap: anywhere; }
.wiki-source-preview__path { font-size: var(--wiki-type-body-sm, .875rem); line-height: 1.5; color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); overflow-wrap: anywhere; margin: var(--wiki-space-2, .5rem) 0 var(--wiki-space-6, 1.5rem); }
.wiki-source-preview__description { font-size: 1rem; line-height: var(--wiki-leading-body, 1.625); margin: 0 0 var(--wiki-space-8, 2rem); color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); overflow-wrap: anywhere; }
.wiki-source-preview__caption { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: var(--wiki-space-2, .5rem) var(--wiki-space-4, 1rem); font-size: var(--wiki-type-label, .8125rem); line-height: 1.5; color: var(--wiki-text-muted, rgb(var(--v-theme-on-surface))); border-bottom: 1px solid var(--wiki-surface-border); padding-bottom: var(--wiki-space-3, .75rem); margin-bottom: var(--wiki-space-5, 1.25rem); }
.wiki-source-preview__caption > span { font-weight: var(--wiki-label-weight, 650); }
.wiki-source-preview__excerpt { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: var(--wiki-font-reader, inherit); line-height: 1.8; font-size: 1rem; }
.wiki-source-preview__excerpt :deep(p), .wiki-source-preview__excerpt :deep(ul), .wiki-source-preview__excerpt :deep(ol), .wiki-source-preview__excerpt :deep(dl), .wiki-source-preview__excerpt :deep(blockquote), .wiki-source-preview__excerpt :deep(pre) { margin: 0 0 1em; }
.wiki-source-preview__excerpt :deep(ul), .wiki-source-preview__excerpt :deep(ol) { padding-inline-start: 1.5em; }
.wiki-source-preview__excerpt :deep(blockquote) { padding-inline-start: 1em; border-inline-start: 3px solid var(--wiki-surface-border); }
.wiki-source-preview__excerpt :deep(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
.wiki-source-preview__excerpt :deep(a) { color: var(--wiki-primary-ink, rgb(var(--v-theme-on-surface))); text-decoration: underline; text-underline-offset: .15em; }
.wiki-source-preview__excerpt :deep(h1), .wiki-source-preview__excerpt :deep(h2), .wiki-source-preview__excerpt :deep(h3), .wiki-source-preview__excerpt :deep(h4), .wiki-source-preview__excerpt :deep(h5), .wiki-source-preview__excerpt :deep(h6) { margin: 1em 0 .5em; font-size: 1.15em; line-height: 1.4; }
.wiki-source-preview__excerpt :deep(.wiki-source-preview__table-scroll) { max-width: 100%; max-height: min(28rem, 60dvh); overflow: auto; overscroll-behavior: contain; margin-block: 1em; border: 1px solid var(--wiki-surface-border); border-radius: .25rem; }
.wiki-source-preview__excerpt :deep(.wiki-source-preview__table-scroll:focus-visible), .wiki-source-preview__excerpt :deep(a:focus-visible) { outline: 2px solid var(--wiki-focus-color, currentColor); outline-offset: -3px; }
.wiki-source-preview__excerpt :deep(table) { width: max-content; min-width: 100%; border-collapse: collapse; font-size: .875rem; line-height: 1.5; }
.wiki-source-preview__excerpt :deep(caption) { text-align: start; padding: .75em; font-weight: 650; }
.wiki-source-preview__excerpt :deep(th), .wiki-source-preview__excerpt :deep(td) { min-width: 6rem; max-width: 24rem; padding: .65em .8em; text-align: start; vertical-align: top; border: 1px solid var(--wiki-surface-border); overflow-wrap: anywhere; }
.wiki-source-preview__excerpt :deep(th) { font-weight: 700; background: rgb(var(--v-theme-on-surface) / .06); }
.wiki-source-preview__excerpt :deep(mark) { background: rgba(var(--v-theme-primary), .18); color: inherit; border-radius: .15rem; }
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
