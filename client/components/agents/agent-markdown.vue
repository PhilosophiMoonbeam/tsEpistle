<template>
  <div ref="markdownRoot" class="agent-markdown" v-html="rendered" @click="copyCode" />
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AgentCitation } from '../../../shared/agents/contracts.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { formatAgentCitationMarkers } from './agent-citations.ts'

const props = withDefaults(defineProps<{
  content: string
  citations?: readonly AgentCitation[]
  streaming?: boolean
}>(), {
  citations: () => [],
  streaming: false
})

interface CopyReset {
  readonly timer: number
  readonly expiresAt: number
}

interface RenderedDomState {
  readonly focusIndex: number
  readonly scrollPositions: readonly { readonly left: number; readonly top: number }[]
  readonly copyFeedback: readonly {
    readonly index: number
    readonly label: string
    readonly ariaLabel: string
    readonly state: 'success' | 'error'
    readonly remaining: number
  }[]
}

const markdownRoot = ref<HTMLElement | null>(null)
const resetTimers = new Map<HTMLButtonElement, CopyReset>()
const resetCopyLabel = (button: HTMLButtonElement): void => {
  button.textContent = 'Copy'
  button.setAttribute('aria-label', 'Copy code to clipboard')
  button.removeAttribute('data-copy-state')
}
const scheduleCopyReset = (button: HTMLButtonElement, delay: number): void => {
  const activeReset = resetTimers.get(button)
  if (activeReset) window.clearTimeout(activeReset.timer)
  const timer = window.setTimeout(() => {
    resetTimers.delete(button)
    if (button.isConnected) resetCopyLabel(button)
  }, delay)
  resetTimers.set(button, { timer, expiresAt: Date.now() + delay })
}
const showCopyResult = (button: HTMLButtonElement, label: string, state: 'success' | 'error'): void => {
  button.textContent = label
  button.setAttribute('aria-label', label)
  button.dataset.copyState = state
  scheduleCopyReset(button, 2_000)
}

const renderMarkdown = (): string => renderSafeMarkdown(
  formatAgentCitationMarkers(props.content, props.citations, props.streaming)
)
  .replace(
    /<pre(?=>|\s)/g,
    '<div class="agent-markdown__code-shell"><div class="agent-markdown__code-toolbar"><span>Code</span><button type="button" class="agent-markdown__copy" data-copy-code aria-label="Copy code to clipboard" aria-live="polite">Copy</button></div><pre tabindex="0" aria-label="Scrollable code block"'
  )
  .replace(/<\/pre>/g, '</pre></div>')
  .replace(
    /<table(?=>|\s)/g,
    '<div class="agent-markdown__table-shell" tabindex="0" role="region" aria-label="Scrollable table"><table'
  )
  .replace(/<\/table>/g, '</table></div>')
  .replace(
    /<a(?=[^>]*\btarget=["']_blank["'])([^>]*)>/g,
    (_match, attributes: string) => {
      const citationTitle = attributes.match(/\btitle=(["'])(Citation [^"']+)\1/)
      const ariaLabel = citationTitle && !/\baria-label=/i.test(attributes)
        ? ` aria-label=${citationTitle[1]}${citationTitle[2]} (opens in a new tab)${citationTitle[1]}`
        : ''
      return `<a${attributes}${ariaLabel}><span class="agent-markdown__new-window"> (opens in a new tab)</span>`
    }
  )

const focusableElements = (root: HTMLElement): readonly HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('a[href], button, pre[tabindex], [role="region"][tabindex]')
]
const scrollableElements = (root: HTMLElement): readonly HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('pre[tabindex], .agent-markdown__table-shell')
]
const captureRenderedDomState = (): RenderedDomState | null => {
  const root = markdownRoot.value
  if (!root || typeof document === 'undefined') return null
  const focusables = focusableElements(root)
  const activeElement = document.activeElement
  const copyButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-copy-code]')]
  return {
    focusIndex: activeElement instanceof HTMLElement && root.contains(activeElement)
      ? focusables.indexOf(activeElement)
      : -1,
    scrollPositions: scrollableElements(root).map(element => ({
      left: element.scrollLeft,
      top: element.scrollTop
    })),
    copyFeedback: copyButtons.flatMap((button, index) => {
      const state = button.dataset.copyState
      const reset = resetTimers.get(button)
      if ((state !== 'success' && state !== 'error') || !reset) return []
      return [{
        index,
        label: button.textContent ?? '',
        ariaLabel: button.getAttribute('aria-label') ?? '',
        state,
        remaining: Math.max(0, reset.expiresAt - Date.now())
      }]
    })
  }
}
const restoreRenderedDomState = (state: RenderedDomState | null): void => {
  const root = markdownRoot.value
  if (!root || !state) return
  const scrollables = scrollableElements(root)
  for (const [index, position] of state.scrollPositions.entries()) {
    const element = scrollables[index]
    if (!element) continue
    element.scrollLeft = position.left
    element.scrollTop = position.top
  }

  for (const [button, reset] of resetTimers) {
    if (button.isConnected) continue
    window.clearTimeout(reset.timer)
    resetTimers.delete(button)
  }
  const copyButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-copy-code]')]
  for (const feedback of state.copyFeedback) {
    const button = copyButtons[feedback.index]
    if (!button) continue
    button.textContent = feedback.label
    button.setAttribute('aria-label', feedback.ariaLabel)
    button.dataset.copyState = feedback.state
    scheduleCopyReset(button, feedback.remaining)
  }
  if (state.focusIndex >= 0) focusableElements(root)[state.focusIndex]?.focus({ preventScroll: true })
}

const rendered = ref(renderMarkdown())
let scheduledFrame: number | null = null
let renderVersion = 0
const commitRender = (): void => {
  scheduledFrame = null
  const nextRendered = renderMarkdown()
  if (nextRendered === rendered.value) return
  const domState = captureRenderedDomState()
  const version = ++renderVersion
  rendered.value = nextRendered
  void nextTick(() => {
    if (version === renderVersion) restoreRenderedDomState(domState)
  })
}
const scheduleRender = (): void => {
  if (scheduledFrame !== null) return
  if (typeof window === 'undefined') {
    commitRender()
    return
  }
  scheduledFrame = window.requestAnimationFrame(commitRender)
}
watch(
  () => [props.content, props.citations, props.streaming] as const,
  () => {
    if (props.streaming) {
      scheduleRender()
      return
    }
    if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame)
    scheduledFrame = null
    commitRender()
  }
)

const copyCode = async (event: MouseEvent): Promise<void> => {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('[data-copy-code]')
  if (!button) return
  const copyIndex = [...(markdownRoot.value?.querySelectorAll<HTMLButtonElement>('[data-copy-code]') ?? [])].indexOf(button)
  const code = button.closest('.agent-markdown__code-shell')?.querySelector('pre')?.textContent
  if (code == null) return
  try {
    await navigator.clipboard.writeText(code)
    const currentButton = button.isConnected
      ? button
      : [...(markdownRoot.value?.querySelectorAll<HTMLButtonElement>('[data-copy-code]') ?? [])][copyIndex]
    if (currentButton) showCopyResult(currentButton, 'Copied', 'success')
  } catch {
    const currentButton = button.isConnected
      ? button
      : [...(markdownRoot.value?.querySelectorAll<HTMLButtonElement>('[data-copy-code]') ?? [])][copyIndex]
    if (currentButton) showCopyResult(currentButton, 'Copy unavailable', 'error')
  }
}
onBeforeUnmount(() => {
  if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame)
  for (const reset of resetTimers.values()) window.clearTimeout(reset.timer)
  resetTimers.clear()
})
</script>

<style scoped>
.agent-markdown {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-body);
  line-height: var(--wiki-leading-body);
  min-width: 0;
  overflow-wrap: anywhere;
}

.agent-markdown > :deep(:first-child) {
  margin-block-start: 0;
}

.agent-markdown > :deep(:last-child) {
  margin-block-end: 0;
}

.agent-markdown :deep(p) {
  margin-block: 0 var(--wiki-space-4);
}

.agent-markdown :deep(h1),
.agent-markdown :deep(h2),
.agent-markdown :deep(h3),
.agent-markdown :deep(h4),
.agent-markdown :deep(h5),
.agent-markdown :deep(h6) {
  color: rgb(var(--v-theme-on-surface));
  font-family: var(--wiki-font-heading);
  font-weight: 720;
  letter-spacing: -.018em;
  line-height: var(--wiki-leading-heading);
  text-wrap: balance;
}

.agent-markdown :deep(h1) {
  font-size: 1.45rem;
  margin-block: var(--wiki-space-8) var(--wiki-space-3);
}

.agent-markdown :deep(h2) {
  border-block-end: 1px solid var(--wiki-surface-border);
  font-size: 1.25rem;
  margin-block: var(--wiki-space-8) var(--wiki-space-3);
  padding-block-end: var(--wiki-space-2);
}

.agent-markdown :deep(h3) {
  font-size: 1.08rem;
  margin-block: var(--wiki-space-6) var(--wiki-space-2);
}

.agent-markdown :deep(h4),
.agent-markdown :deep(h5),
.agent-markdown :deep(h6) {
  font-size: 1rem;
  margin-block: var(--wiki-space-5) var(--wiki-space-2);
}

.agent-markdown :deep(ul),
.agent-markdown :deep(ol) {
  margin-block: var(--wiki-space-3) var(--wiki-space-5);
  padding-inline-start: var(--wiki-space-6);
}

.agent-markdown :deep(ul) {
  list-style-type: square;
}

.agent-markdown :deep(li) {
  padding-inline-start: var(--wiki-space-1);
}

.agent-markdown :deep(li + li) {
  margin-block-start: var(--wiki-space-2);
}

.agent-markdown :deep(li > :is(ul, ol)) {
  margin-block: var(--wiki-space-2);
}

.agent-markdown :deep(li::marker) {
  color: color-mix(in srgb, var(--wiki-accent-warm) 72%, rgb(var(--v-theme-on-surface)));
  font-weight: 700;
}

.agent-markdown :deep(blockquote) {
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  border-inline-start: var(--wiki-space-1) solid var(--wiki-accent-warm);
  border-radius: 0 var(--wiki-control-radius) var(--wiki-control-radius) 0;
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 82%, transparent);
  margin: var(--wiki-space-5) 0;
  padding: var(--wiki-space-3) var(--wiki-space-4);
}

[dir='rtl'] .agent-markdown :deep(blockquote) {
  border-radius: var(--wiki-control-radius) 0 0 var(--wiki-control-radius);
}

.agent-markdown :deep(blockquote > :last-child) {
  margin-block-end: 0;
}

.agent-markdown :deep(hr) {
  border: 0;
  border-block-start: 1px solid var(--wiki-surface-border-strong);
  margin-block: var(--wiki-space-8);
}

.agent-markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
  font-weight: 560;
  overflow-wrap: anywhere;
  text-decoration-thickness: .08em;
  text-underline-offset: .18em;
  transition:
    color var(--wiki-motion-fast) var(--wiki-motion-ease),
    text-decoration-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-markdown :deep(a:hover) {
  color: color-mix(in srgb, rgb(var(--v-theme-primary)) 72%, rgb(var(--v-theme-on-surface)));
  text-decoration-thickness: .12em;
}

.agent-markdown :deep(a:focus-visible),
.agent-markdown :deep(.agent-markdown__table-shell:focus-visible) {
  border-radius: var(--wiki-radius-xs);
  box-shadow: var(--wiki-focus-ring);
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: var(--wiki-focus-offset);
}

.agent-markdown :deep(pre:focus-visible),
.agent-markdown :deep(.agent-markdown__copy:focus-visible) {
  border-radius: var(--wiki-radius-xs);
  outline: 2px solid var(--wiki-focus-color);
  outline-offset: calc(-1 * var(--wiki-focus-offset));
}

.agent-markdown :deep(a[target='_blank']:not([title^='Citation ']))::after {
  content: ' ↗';
  font-size: .78em;
  text-decoration: none;
}

.agent-markdown :deep(.agent-markdown__new-window) {
  block-size: 1px;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  inline-size: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
}

.agent-markdown :deep(code) {
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-radius-xs);
  font-family: var(--wiki-font-mono);
  font-size: .88em;
  font-variant-ligatures: none;
  padding-inline: var(--wiki-space-1);
}

.agent-markdown :deep(.agent-markdown__code-shell) {
  background: var(--wiki-surface-sunken);
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  box-shadow: var(--wiki-shadow-inset);
  margin-block: var(--wiki-space-5);
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
}

.agent-markdown :deep(.agent-markdown__code-toolbar) {
  align-items: center;
  background: color-mix(in srgb, var(--wiki-surface-raised) 86%, var(--wiki-surface-sunken));
  border-block-end: 1px solid var(--wiki-surface-border);
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  display: flex;
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  font-weight: var(--wiki-label-weight);
  justify-content: space-between;
  letter-spacing: .06em;
  min-height: var(--wiki-space-8);
  padding-inline: var(--wiki-space-3) var(--wiki-space-2);
  text-transform: uppercase;
}

.agent-markdown :deep(.agent-markdown__copy) {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: var(--wiki-radius-xs);
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  justify-content: center;
  letter-spacing: .04em;
  min-height: var(--wiki-space-8);
  padding-inline: var(--wiki-space-2);
  text-transform: none;
  transition:
    background-color var(--wiki-motion-fast) var(--wiki-motion-ease),
    color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-markdown :deep(.agent-markdown__copy:hover) {
  background: color-mix(in srgb, var(--wiki-ambient-accent) 11%, transparent);
  color: var(--wiki-accent-warm);
}

.agent-markdown :deep(.agent-markdown__copy[data-copy-state='success']) {
  color: rgb(var(--v-theme-success));
}

.agent-markdown :deep(.agent-markdown__copy[data-copy-state='error']) {
  color: rgb(var(--v-theme-error));
}

.agent-markdown :deep(pre) {
  direction: ltr;
  margin: 0;
  max-block-size: min(60vh, calc(var(--wiki-space-12) * 10));
  max-width: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  padding: var(--wiki-space-4);
  text-align: start;
  white-space: pre;
}

.agent-markdown :deep(pre code) {
  background: transparent;
  border: 0;
  border-radius: 0;
  color: inherit;
  display: block;
  font-size: .82rem;
  line-height: 1.65;
  min-width: max-content;
  padding: 0;
}

.agent-markdown :deep(.agent-markdown__table-shell) {
  border: 1px solid var(--wiki-surface-border-strong);
  border-radius: var(--wiki-control-radius);
  margin-block: var(--wiki-space-5);
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.agent-markdown :deep(table) {
  border-collapse: collapse;
  font-size: .9em;
  min-width: 100%;
  width: max-content;
}

.agent-markdown :deep(th),
.agent-markdown :deep(td) {
  border-block-end: 1px solid var(--wiki-surface-border);
  border-inline-end: 1px solid var(--wiki-surface-border);
  min-width: calc(var(--wiki-space-12) * 3);
  padding: var(--wiki-space-2) var(--wiki-space-3);
  text-align: start;
  vertical-align: top;
}

.agent-markdown :deep(tr > :last-child) {
  border-inline-end: 0;
}

.agent-markdown :deep(tbody tr:last-child td) {
  border-block-end: 0;
}

.agent-markdown :deep(th) {
  background: var(--wiki-surface-sunken);
  color: rgb(var(--v-theme-on-surface));
  font-size: var(--wiki-label-size);
  font-weight: 720;
  letter-spacing: .05em;
  text-transform: uppercase;
}

.agent-markdown :deep(tbody tr:nth-child(even)) {
  background: color-mix(in srgb, var(--wiki-surface-sunken) 58%, transparent);
}

.agent-markdown :deep(a[title^='Citation ']) {
  align-items: center;
  background: color-mix(in srgb, var(--wiki-accent-warm) 11%, var(--wiki-surface-raised));
  border: 1px solid color-mix(in srgb, var(--wiki-accent-warm) 20%, var(--wiki-surface-border));
  border-radius: var(--wiki-radius-pill);
  color: rgb(var(--v-theme-on-surface));
  display: inline-flex;
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  font-weight: 720;
  justify-content: center;
  line-height: 1;
  margin-inline: var(--wiki-space-1);
  min-height: var(--wiki-space-5);
  min-width: var(--wiki-space-5);
  padding-inline: var(--wiki-space-1);
  text-decoration: none;
  vertical-align: .12em;
}

.agent-markdown :deep(a[title^='Citation ']:hover) {
  background: color-mix(in srgb, var(--wiki-accent-warm) 17%, var(--wiki-surface-raised));
  border-color: color-mix(in srgb, var(--wiki-accent-warm) 42%, var(--wiki-surface-border));
}

@media (max-width: 599.98px) {
  .agent-markdown :deep(h1) {
    font-size: 1.3rem;
  }

  .agent-markdown :deep(h2) {
    font-size: 1.16rem;
  }

  .agent-markdown :deep(.agent-markdown__code-shell),
  .agent-markdown :deep(.agent-markdown__table-shell) {
    border-radius: var(--wiki-radius-xs);
  }

  .agent-markdown :deep(pre) {
    padding: var(--wiki-space-3);
  }

  .agent-markdown :deep(th),
  .agent-markdown :deep(td) {
    min-width: calc(var(--wiki-space-12) * 2.5);
  }
}

@media (pointer: coarse) {
  .agent-markdown :deep(.agent-markdown__code-toolbar),
  .agent-markdown :deep(.agent-markdown__copy) {
    min-height: var(--wiki-control-height);
  }

  .agent-markdown :deep(a[title^='Citation ']) {
    min-width: 28px;
    min-height: 28px;
    margin-inline: var(--wiki-space-2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-markdown :deep(a),
  .agent-markdown :deep(.agent-markdown__copy) {
    transition: none;
  }
}

@media (forced-colors: active) {
  .agent-markdown :deep(blockquote),
  .agent-markdown :deep(code),
  .agent-markdown :deep(.agent-markdown__code-shell),
  .agent-markdown :deep(.agent-markdown__table-shell),
  .agent-markdown :deep(a[title^='Citation ']) {
    background: Canvas;
    border-color: CanvasText;
    color: CanvasText;
  }

  .agent-markdown :deep(a:focus-visible),
  .agent-markdown :deep(pre:focus-visible),
  .agent-markdown :deep(.agent-markdown__table-shell:focus-visible),
  .agent-markdown :deep(.agent-markdown__copy:focus-visible) {
    outline-color: Highlight;
  }
}
</style>
