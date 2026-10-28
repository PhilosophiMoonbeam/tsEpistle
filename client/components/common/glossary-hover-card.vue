<template>
  <Teleport :to="teleportTarget">
    <section
      :id="id"
      ref="card"
      class="glossary-hover-card"
      :style="position"
      role="dialog"
      aria-modal="false"
      :aria-labelledby="`${id}-title`"
      :aria-busy="loading"
      data-glossary-owned="true"
      tabindex="-1"
      @pointerenter="emit('retain')"
      @pointerleave="emit('leave-pointer', $event)"
      @keydown="keydown"
    >
      <header class="glossary-hover-card__header">
        <div>
          <h2 :id="`${id}-title`" class="glossary-hover-card__title" dir="auto">{{ definition?.term || name }}</h2>
          <span class="glossary-hover-card__locale" dir="ltr" :aria-label="t('common:glossaryHover.locale', { locale: definition?.locale || locale })">{{ definition?.locale || locale }}</span>
        </div>
        <button type="button" class="glossary-hover-card__close" :aria-label="t('common:glossaryHover.close')" @click="emit('dismiss', true)"><span aria-hidden="true">×</span></button>
      </header>
      <p v-if="definition?.expansion" class="glossary-hover-card__expansion" dir="auto">{{ definition.expansion }}</p>
      <p v-if="loading || errorKey" class="glossary-hover-card__status" role="status">{{ t(`common:glossaryHover.${loading ? 'loading' : errorKey}`) }}</p>
      <div v-if="definition && !loading && !errorKey" class="glossary-hover-card__definition" :lang="definition.locale" dir="auto" v-html="definitionHtml" />
      <footer class="glossary-hover-card__actions">
        <template v-if="definition && !loading && !errorKey">
          <button
            type="button"
            class="glossary-hover-card__pin"
            :aria-disabled="!canPin || pinState?.pending"
            :aria-describedby="!canPin ? `${id}-pin-help` : undefined"
            :aria-busy="pinState?.key === selectionKey && pinState.pending"
            @click="requestPin"
          >{{ t('common:glossaryHover.pin') }}</button>
          <p v-if="!canPin" :id="`${id}-pin-help`" class="glossary-hover-card__pin-help">{{ pinState?.key === selectionKey && pinState.unavailableReason || t('common:glossaryHover.pinUnavailable') }}</p>
        </template>
        <a class="glossary-hover-card__full" :href="href">{{ t('common:glossaryHover.openGlossary') }}</a>
      </footer>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import type { GlossaryHoverDefinition, GlossaryPinState } from '../../helpers/glossary-runtime.ts'
import { sanitizeGlossaryDefinition } from '../../helpers/glossary-runtime.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const props = defineProps<{
  id: string
  anchor: HTMLAnchorElement
  name: string
  locale: string
  selectionKey: string
  definition: GlossaryHoverDefinition | null
  loading: boolean
  errorKey: string
  href: string
  pinState?: GlossaryPinState
}>()
const emit = defineEmits<{
  dismiss: [restoreFocus: boolean]
  retain: []
  'leave-pointer': [event: PointerEvent]
  'leave-focus': [backward: boolean, event: KeyboardEvent]
  'pin-request': []
}>()
const t = useTranslate()
const card = ref<HTMLElement | null>(null)
const position = ref<CSSProperties>({ left: '12px', top: '12px', maxHeight: 'calc(100dvh - 24px)', visibility: 'hidden' })
const teleportTarget = computed(() => props.anchor.closest('.v-application') ?? document.body)
const definitionHtml = computed(() => sanitizeGlossaryDefinition(props.definition?.definitionHtml ?? ''))
const canPin = computed(() => !!props.definition && props.pinState?.key === props.selectionKey && props.pinState.available)
let resizeObserver: ResizeObserver | undefined, frame = 0, alive = true
function requestPin (): void {
  if (canPin.value && !props.pinState?.pending && !props.loading && !props.errorKey) emit('pin-request')
}
function focusables (): HTMLElement[] {
  return Array.from(card.value?.querySelectorAll<HTMLElement>('a[href],button,[tabindex]') ?? [])
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled,[hidden],[inert]') && !element.closest('[hidden],[inert]') && element.getClientRects().length > 0)
}
function focusFirst (): void {
  updatePosition()
  void nextTick(() => { if (alive) (focusables()[0] ?? card.value)?.focus({ preventScroll: true }) })
}
function contains (target: EventTarget | null): boolean { return target instanceof Node && card.value?.contains(target) === true }
function keydown (event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
  const elements = focusables(), first = elements[0], last = elements.at(-1)
  if (event.shiftKey && event.target === first || !event.shiftKey && event.target === last) {
    // This is a nonmodal reading aid: leave at either edge, never cycle a trap.
    emit('leave-focus', event.shiftKey, event)
  }
}
function updatePosition (): void {
  frame = 0
  const element = card.value
  if (!alive || !element) return
  if (!props.anchor.isConnected) { emit('dismiss', false); return }
  const viewport = window.visualViewport
  const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0
  const width = viewport?.width ?? document.documentElement.clientWidth
  const height = viewport?.height ?? window.innerHeight
  const bounds = props.anchor.getBoundingClientRect()
  if (bounds.bottom < y || bounds.top > y + height || bounds.right < x || bounds.left > x + width) { emit('dismiss', false); return }
  const margin = 12, gap = 8
  // Keep this nonmodal reading aid below the actual fixed chrome.
  const header = props.anchor.ownerDocument.querySelector<HTMLElement>('.nav-header')
  const headerBox = header?.getBoundingClientRect()
  let topEdge = y + margin
  if (header && headerBox && headerBox.top <= topEdge && headerBox.bottom > y && getComputedStyle(header).visibility === 'visible') {
    topEdge = Math.max(topEdge, headerBox.bottom + margin)
  }
  topEdge = Math.min(topEdge, y + height - margin - 1)
  const cardWidth = Math.min(280, Math.max(1, width - margin * 2))
  const maxHeight = Math.max(1, y + height - margin - topEdge)
  element.style.width = `${cardWidth}px`
  element.style.maxHeight = `${maxHeight}px`
  const cardHeight = Math.min(element.getBoundingClientRect().height, maxHeight)
  const below = y + height - bounds.bottom - gap - margin, above = bounds.top - topEdge - gap
  const preferredTop = below >= cardHeight || below >= above ? bounds.bottom + gap : bounds.top - gap - cardHeight
  position.value = {
    left: `${Math.max(x + margin, Math.min(bounds.left, x + width - cardWidth - margin))}px`,
    top: `${Math.max(topEdge, Math.min(preferredTop, y + height - cardHeight - margin))}px`,
    maxHeight: `${maxHeight}px`,
    visibility: 'visible'
  }
}
function schedulePosition (): void { if (!frame && alive) frame = window.requestAnimationFrame(updatePosition) }
watch(() => [props.anchor, props.definition, props.loading, props.errorKey, props.pinState], () => { void nextTick(() => { if (alive) schedulePosition() }) }, { flush: 'post' })
onMounted(() => {
  resizeObserver = new ResizeObserver(schedulePosition)
  if (card.value) resizeObserver.observe(card.value)
  window.addEventListener('resize', schedulePosition)
  window.addEventListener('scroll', schedulePosition, true)
  window.visualViewport?.addEventListener('resize', schedulePosition)
  window.visualViewport?.addEventListener('scroll', schedulePosition)
  schedulePosition()
})
onBeforeUnmount(() => {
  alive = false
  window.cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', schedulePosition)
  window.removeEventListener('scroll', schedulePosition, true)
  window.visualViewport?.removeEventListener('resize', schedulePosition)
  window.visualViewport?.removeEventListener('scroll', schedulePosition)
})
defineExpose({ contains, focusFirst })
</script>

<style scoped lang="scss">
.glossary-hover-card {
  position: fixed;
  z-index: 1005;
  box-sizing: border-box;
  width: 280px;
  max-width: calc(100vw - 24px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--wiki-space-4);
  border: var(--wiki-hud-border);
  border-radius: var(--wiki-radius-md);
  color: rgb(var(--v-theme-on-surface));
  background: var(--wiki-hud-surface);
  -webkit-backdrop-filter: var(--wiki-hud-filter);
  backdrop-filter: var(--wiki-hud-filter);
  box-shadow: var(--wiki-specular-border), var(--wiki-shadow-md);
  font-family: var(--wiki-font-body);
  font-size: .875rem;
  line-height: 1.55;
  text-align: start;
  overflow-wrap: anywhere;
}
.glossary-hover-card__header { display: flex; align-items: start; justify-content: space-between; gap: var(--wiki-space-2); }
.glossary-hover-card__title { margin: 0; font-family: var(--wiki-font-display); font-size: 1.375rem; font-weight: 500; line-height: 1.2; }
.glossary-hover-card__locale { display: inline-block; margin-block-start: var(--wiki-space-1); font-family: var(--wiki-font-mono); font-size: .75rem; }
.glossary-hover-card__close { flex: 0 0 auto; min-width: 2.75rem; min-height: 2.75rem; margin-block-start: -.5rem; margin-inline-end: -.5rem; border-radius: var(--wiki-radius-sm); font-size: 1.5rem; }
.glossary-hover-card__expansion, .glossary-hover-card__status { margin-block: var(--wiki-space-3); }
.glossary-hover-card__definition { margin-block-start: var(--wiki-space-3); }
.glossary-hover-card__definition :deep(:first-child) { margin-block-start: 0; }
.glossary-hover-card__definition :deep(:last-child) { margin-block-end: 0; }
.glossary-hover-card__definition :deep(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
.glossary-hover-card__definition :deep(table) { display: block; overflow-x: auto; max-width: 100%; }
.glossary-hover-card__definition :deep(a), .glossary-hover-card__full { color: var(--wiki-primary-ink); text-decoration: underline; text-underline-offset: .18em; }
.glossary-hover-card__actions { display: grid; gap: var(--wiki-space-2); margin-block-start: var(--wiki-space-4); padding-block-start: var(--wiki-space-3); border-block-start: var(--wiki-hud-border); }
.glossary-hover-card__pin { min-height: 2.75rem; padding: .5rem .75rem; border: 1px solid var(--wiki-control-edge); border-radius: var(--wiki-radius-sm); font: inherit; font-weight: 600; text-align: center; }
.glossary-hover-card__pin[aria-disabled='true'] { cursor: not-allowed; }
.glossary-hover-card__pin-help { margin: 0; font-size: .8125rem; }
.glossary-hover-card__full { display: inline-flex; align-items: center; min-height: 2.75rem; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glossary-hover-card { background: rgb(var(--v-theme-surface)); }
}
@media (prefers-reduced-transparency: reduce) {
  .glossary-hover-card { background: rgb(var(--v-theme-surface)); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (forced-colors: active) {
  .glossary-hover-card { color: CanvasText; background: Canvas; border: 1px solid CanvasText; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .glossary-hover-card__pin { border-color: ButtonText; }
  .glossary-hover-card__definition :deep(a), .glossary-hover-card__full { color: LinkText; }
}
</style>
