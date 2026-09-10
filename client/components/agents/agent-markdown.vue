<template>
  <div ref="markdownRoot" class="agent-markdown" v-html="rendered" @click="copyCode" />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import type { AgentCitation } from '../../../shared/agents/contracts.ts'
import {
  MERMAID_MAX_DIAGRAMS_PER_ROOT,
  MERMAID_MAX_TEXT_SIZE,
  renderMermaidSvg,
  selectMermaidRenderHosts
} from '../../helpers/content-extension-runtimes/mermaid.ts'
import { renderSafeMarkdown } from '../../helpers/safe-markdown.ts'
import { createAgentCitationResolver } from './agent-citations.ts'
import { wikiSourceSelectorFromHref, type WikiSourceSelector } from '../../../shared/wiki-source.ts'

const {
  content,
  citations = [],
  streaming = false,
  sourcePreviews = false
} = defineProps<{
  content: string
  citations?: readonly AgentCitation[]
  streaming?: boolean
  sourcePreviews?: boolean
}>()

const emit = defineEmits<{ previewSource: [selector: WikiSourceSelector] }>()

interface CopyReset {
  readonly timer: number
  readonly expiresAt: number
}

interface FocusTarget {
  readonly kind: 'copy' | 'pre' | 'table' | 'anchor'
  readonly blockId?: string
  readonly href?: string
  readonly text?: string
  readonly occurrence?: number
  readonly matchingCount?: number
}

interface RenderedDomState {
  readonly focusTarget: FocusTarget | null
  readonly scrollPositions: readonly { readonly blockId: string; readonly left: number; readonly top: number }[]
  readonly copyFeedback: readonly {
    readonly blockId: string
    readonly label: string
    readonly ariaLabel: string
    readonly state: 'success' | 'error'
    readonly remaining: number
  }[]
}

const markdownRoot = useTemplateRef<HTMLElement>('markdownRoot')
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

const stableHash = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const blockIdentity = (element: Element): string | null =>
  element.closest<HTMLElement>('[data-agent-block-id]')?.dataset.agentBlockId ?? null

const focusIdentity = (element: HTMLElement, root: HTMLElement): FocusTarget => {
  const blockId = blockIdentity(element)
  if (element.matches('[data-copy-code]')) return { kind: 'copy', blockId: blockId ?? undefined }
  if (element.matches('pre')) return { kind: 'pre', blockId: blockId ?? undefined }
  if (element.matches('[role="region"]')) return { kind: 'table', blockId: blockId ?? undefined }
  const anchor = element instanceof HTMLAnchorElement ? element : null
  const href = anchor?.getAttribute('href') ?? ''
  const text = anchor?.textContent ?? ''
  if (!anchor) return { kind: 'anchor', href, text }
  const matchingAnchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter(candidate => candidate.getAttribute('href') === href && (candidate.textContent ?? '') === text)
  return {
    kind: 'anchor',
    href,
    text,
    occurrence: matchingAnchors.indexOf(anchor),
    matchingCount: matchingAnchors.length
  }
}

const scrollableElements = (root: HTMLElement): readonly HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-agent-block-id] > pre[tabindex], [data-agent-block-id] > [role="region"][tabindex], [data-agent-block-id] pre[tabindex], [data-agent-block-id][role="region"][tabindex]')
]

const captureRenderedDomState = (): RenderedDomState | null => {
  const root = markdownRoot.value
  if (!root || typeof document === 'undefined') return null
  const activeElement = document.activeElement
  const copyButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-copy-code]')]
  const focusTarget = activeElement instanceof HTMLElement && root.contains(activeElement)
    ? focusIdentity(activeElement, root)
    : null
  return {
    focusTarget,
    scrollPositions: scrollableElements(root).flatMap(element => {
      const blockId = blockIdentity(element)
      return blockId ? [{ blockId, left: element.scrollLeft, top: element.scrollTop }] : []
    }),
    copyFeedback: copyButtons.flatMap(button => {
      const blockId = blockIdentity(button)
      const state = button.dataset.copyState
      const reset = resetTimers.get(button)
      if (!blockId || (state !== 'success' && state !== 'error') || !reset) return []
      return [{
        blockId,
        label: button.textContent ?? '',
        ariaLabel: button.getAttribute('aria-label') ?? '',
        state,
        remaining: Math.max(0, reset.expiresAt - Date.now())
      }]
    })
  }
}

const findFocusedElement = (root: HTMLElement, target: FocusTarget): HTMLElement | null => {
  if (target.kind !== 'anchor') {
    return [...root.querySelectorAll<HTMLElement>('button, pre[tabindex], [role="region"][tabindex]')]
      .find(element => blockIdentity(element) === target.blockId && focusIdentity(element, root).kind === target.kind) ?? null
  }
  if (target.href == null || target.text == null || target.occurrence == null || target.matchingCount == null) return null
  const matchingAnchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')]
    .filter(anchor => anchor.getAttribute('href') === target.href && (anchor.textContent ?? '') === target.text)
  if (matchingAnchors.length !== target.matchingCount) return null
  return matchingAnchors[target.occurrence] ?? null
}

const restoreRenderedDomState = (state: RenderedDomState | null): void => {
  const root = markdownRoot.value
  if (!root || !state) return
  for (const position of state.scrollPositions) {
    const element = [...scrollableElements(root)].find(candidate => blockIdentity(candidate) === position.blockId)
    if (!element) continue
    element.scrollLeft = position.left
    element.scrollTop = position.top
  }

  for (const [button, reset] of resetTimers) {
    if (button.isConnected) continue
    window.clearTimeout(reset.timer)
    resetTimers.delete(button)
  }
  for (const feedback of state.copyFeedback) {
    const button = [...root.querySelectorAll<HTMLButtonElement>('[data-copy-code]')]
      .find(candidate => blockIdentity(candidate) === feedback.blockId)
    if (!button) continue
    button.textContent = feedback.label
    button.setAttribute('aria-label', feedback.ariaLabel)
    button.dataset.copyState = feedback.state
    scheduleCopyReset(button, feedback.remaining)
  }
  if (state.focusTarget) findFocusedElement(root, state.focusTarget)?.focus({ preventScroll: true })
}

const currentTheme = (root: HTMLElement): 'dark' | 'default' => {
  const documentElement = root.ownerDocument.documentElement
  return root.closest('.v-theme--dark') || documentElement.classList.contains('v-theme--dark')
    ? 'dark'
    : 'default'
}

const decorateRenderedHtml = (html: string): string => {
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  const origin = window.location.origin
  for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>('a[data-agent-citation]')) {
    if (!sourcePreviews) continue
    const href = anchor.getAttribute('href') ?? ''
    let url: URL
    const selector = wikiSourceSelectorFromHref(href, origin)
    try {
      url = new URL(href, origin)
    } catch {
      continue
    }
    if (!selector || url.hash) continue
    anchor.dataset.sourcePreview = 'true'
    anchor.removeAttribute('target')
    anchor.setAttribute('aria-label', `${anchor.getAttribute('aria-label') ?? 'Citation'} (preview source)`)
    anchor.querySelector('.agent-markdown__new-window')?.remove()
  }

  const occurrences = new Map<string, number>()
  for (const shell of template.content.querySelectorAll<HTMLElement>('.agent-markdown__code-shell, .agent-markdown__table-shell')) {
    const code = shell.classList.contains('agent-markdown__code-shell')
    const element = code ? shell.querySelector('pre') : shell.querySelector('table')
    if (!element) continue
    const language = code ? element instanceof HTMLElement ? element.dataset.language ?? 'text' : 'text' : 'table'
    const signature = `${code ? 'code' : 'table'}\u0000${language}\u0000${element.textContent ?? ''}\u0000${code ? '' : element.innerHTML}`
    const occurrence = occurrences.get(signature) ?? 0
    occurrences.set(signature, occurrence + 1)
    shell.dataset.agentBlockId = `${code ? 'code' : 'table'}-${stableHash(signature)}-${occurrence}`
    if (!code) continue

    const toolbarLabel = shell.querySelector<HTMLElement>('.agent-markdown__code-toolbar span')
    if (toolbarLabel) toolbarLabel.textContent = language
    if (language !== 'mermaid') continue
    shell.dataset.agentDiagram = 'true'
    const pre = shell.querySelector<HTMLPreElement>('pre')
    if (!pre || shell.querySelector('.agent-markdown__diagram-source')) continue
    const sourceDisclosure = document.createElement('details')
    sourceDisclosure.className = 'agent-markdown__diagram-source'
    sourceDisclosure.open = true
    const summary = document.createElement('summary')
    summary.textContent = 'Mermaid source'
    sourceDisclosure.append(summary, pre)
    shell.append(sourceDisclosure)
    const output = document.createElement('div')
    output.className = 'agent-markdown__diagram-output'
    output.setAttribute('aria-busy', 'true')
    output.setAttribute('aria-label', 'Rendering Mermaid diagram')
    shell.insertBefore(output, sourceDisclosure)
  }
  return template.innerHTML
}

const renderMarkdown = (): string => {
  const html = renderSafeMarkdown(content, {
    resolveCitation: createAgentCitationResolver(citations),
    streaming,
    fenceMetadata: metadata => ({ 'data-language': metadata.language })
  })
    .replace(
      /<pre(?=[\s>])([^>]*)>/g,
      (_match, attributes: string) => {
        const language = attributes.match(/\bdata-language="([a-z0-9][a-z0-9_+.-]{0,31})"/i)?.[1] ?? 'text'
        return `<div class="agent-markdown__code-shell"><div class="agent-markdown__code-toolbar"><span>${language}</span><button type="button" class="agent-markdown__copy" data-copy-code aria-label="Copy code to clipboard" aria-live="polite">Copy</button></div><pre${attributes} tabindex="0" aria-label="Scrollable ${language} code block"`
      }
    )
    .replace(/<\/pre>/g, '</pre></div>')
    .replace(
      /<table(?=[\s>])/g,
      '<div class="agent-markdown__table-shell" tabindex="0" role="region" aria-label="Scrollable table"><table'
    )
    .replace(/<\/table>/g, '</table></div>')
    .replace(
      /<a(?=[^>]*\btarget=["']_blank["'])([^>]*)>([\s\S]*?)<\/a>/g,
      (_match, attributes: string, anchorContent: string) => `<a${attributes}>${anchorContent}<span class="agent-markdown__new-window"> (opens in a new tab)</span></a>`
    )
  return decorateRenderedHtml(html)
}

const citationSemanticSignature = computed(() => JSON.stringify([
  sourcePreviews,
  ...citations.map(citation => [
    citation.evidenceId,
    citation.kind,
    citation.label,
    citation.href
  ])
]))

const rendered = ref(renderMarkdown())
let renderedContent = content
let renderedCitationSignature = citationSemanticSignature.value
let renderedStreaming = streaming
let renderedSourcePreviews = sourcePreviews
let scheduledFrame: number | null = null
let renderVersion = 0
const diagramControllers = new Set<AbortController>()
const cancelDiagramJobs = (): void => {
  for (const controller of diagramControllers) controller.abort()
  diagramControllers.clear()
}

const MERMAID_LIMIT_NOTICE_CLASS = 'content-extension-diagram__limit-notice'
const MERMAID_LIMIT_NOTICE_MESSAGE = `Additional diagrams remain available as source because only ${MERMAID_MAX_DIAGRAMS_PER_ROOT} diagrams are rendered automatically per message.`

const showMermaidLimitNotice = (root: HTMLElement): void => {
  if (root.querySelector(`.${MERMAID_LIMIT_NOTICE_CLASS}`)) return
  const notice = root.ownerDocument.createElement('p')
  notice.className = MERMAID_LIMIT_NOTICE_CLASS
  notice.textContent = MERMAID_LIMIT_NOTICE_MESSAGE
  root.append(notice)
}

const enhanceMermaidDiagrams = (version: number): void => {
  if (streaming) return
  const root = markdownRoot.value
  if (!root || version !== renderVersion) return
  const shells = [...root.querySelectorAll<HTMLElement>('.agent-markdown__code-shell[data-agent-diagram="true"]')]
  const candidates = shells.filter(shell => {
    if (!shell.isConnected || !root.contains(shell)) return false
    const source = shell.querySelector<HTMLPreElement>('pre')?.textContent ?? ''
    return source.length <= MERMAID_MAX_TEXT_SIZE
  })
  const mermaidHosts = selectMermaidRenderHosts(candidates)
  const excess = shells.filter(shell => !mermaidHosts.has(shell))
  for (const shell of excess) {
    const output = shell.querySelector<HTMLElement>('.agent-markdown__diagram-output')
    shell.dataset.diagramState = 'source-only'
    shell.setAttribute('aria-busy', 'false')
    output?.setAttribute('aria-busy', 'false')
    output?.removeAttribute('aria-label')
  }
  if (excess.length > 0) showMermaidLimitNotice(root)
  for (const shell of shells) {
    if (!mermaidHosts.has(shell) || shell.dataset.diagramState) continue
    const pre = shell.querySelector<HTMLPreElement>('pre')
    const output = shell.querySelector<HTMLElement>('.agent-markdown__diagram-output')
    if (!pre || !output) continue
    const source = pre.textContent ?? ''
    if (source.length > MERMAID_MAX_TEXT_SIZE) {
      shell.dataset.diagramState = 'source-only'
      shell.setAttribute('aria-busy', 'false')
      output.setAttribute('aria-busy', 'false')
      output.removeAttribute('aria-label')
      continue
    }
    const controller = new AbortController()
    diagramControllers.add(controller)
    const blockId = shell.dataset.agentBlockId ?? ''
    shell.dataset.diagramState = 'pending'
    shell.setAttribute('aria-busy', 'true')
    output.setAttribute('aria-busy', 'true')
    output.setAttribute('aria-label', 'Rendering Mermaid diagram')
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      renderVersion === version &&
      root.isConnected &&
      root.contains(shell) &&
      shell.dataset.agentBlockId === blockId
    void renderMermaidSvg(source, {
      ownerDocument: root.ownerDocument,
      theme: currentTheme(root),
      signal: controller.signal,
      isCurrent
    }).then(svg => {
      if (!isCurrent() || !svg) return
      svg.setAttribute('role', 'img')
      if (!svg.getAttribute('aria-label')) svg.setAttribute('aria-label', 'Mermaid diagram')
      output.replaceChildren(svg)
      output.removeAttribute('aria-busy')
      output.removeAttribute('aria-label')
      shell.removeAttribute('aria-busy')
      shell.dataset.diagramState = 'rendered'
    }).catch(() => {
      if (!isCurrent()) return
      const status = root.ownerDocument.createElement('p')
      status.className = 'agent-markdown__diagram-error'
      status.setAttribute('role', 'alert')
      status.textContent = 'Diagram could not be rendered safely. Mermaid source remains available below.'
      output.replaceChildren(status)
      output.removeAttribute('aria-busy')
      output.removeAttribute('aria-label')
      shell.removeAttribute('aria-busy')
      shell.dataset.diagramState = 'failed'
    }).finally(() => {
      diagramControllers.delete(controller)
    })
  }
}

const commitRender = (): void => {
  scheduledFrame = null
  const citationSignature = citationSemanticSignature.value
  if (
    content === renderedContent &&
    streaming === renderedStreaming &&
    citationSignature === renderedCitationSignature &&
    sourcePreviews === renderedSourcePreviews
  ) return
  const nextRendered = renderMarkdown()
  renderedContent = content
  renderedCitationSignature = citationSignature
  renderedStreaming = streaming
  renderedSourcePreviews = sourcePreviews
  if (nextRendered === rendered.value) {
    if (!streaming) void nextTick(() => enhanceMermaidDiagrams(renderVersion))
    return
  }
  const domState = captureRenderedDomState()
  cancelDiagramJobs()
  const version = ++renderVersion
  rendered.value = nextRendered
  void nextTick(() => {
    if (version !== renderVersion) return
    restoreRenderedDomState(domState)
    enhanceMermaidDiagrams(version)
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
  [() => content, citationSemanticSignature, () => streaming, () => sourcePreviews],
  () => {
    if (streaming) {
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
  const anchor = target.closest<HTMLAnchorElement>('a[data-source-preview]')
  if (anchor && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    const selector = wikiSourceSelectorFromHref(anchor.href, window.location.origin)
    if (selector) { event.preventDefault(); emit('previewSource', selector); return }
  }
  const button = target.closest<HTMLButtonElement>('[data-copy-code]')
  if (!button) return
  const shell = button.closest<HTMLElement>('[data-agent-block-id]')
  const blockId = shell?.dataset.agentBlockId
  const code = shell?.querySelector('pre')?.textContent
  if (!blockId || code == null) return
  const currentButton = (): HTMLButtonElement | null => {
    if (button.isConnected) return button
    return [...(markdownRoot.value?.querySelectorAll<HTMLButtonElement>('[data-copy-code]') ?? [])]
      .find(candidate => blockIdentity(candidate) === blockId) ?? null
  }
  try {
    await navigator.clipboard.writeText(code)
    const activeButton = currentButton()
    if (activeButton) showCopyResult(activeButton, 'Copied', 'success')
  } catch {
    const activeButton = currentButton()
    if (activeButton) showCopyResult(activeButton, 'Copy unavailable', 'error')
  }
}

onMounted(() => {
  void nextTick(() => enhanceMermaidDiagrams(renderVersion))
})
onBeforeUnmount(() => {
  if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame)
  cancelDiagramJobs()
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
  color: var(--wiki-accent-ink);
  font-weight: 560;
  overflow-wrap: anywhere;
  text-decoration-thickness: .08em;
  text-underline-offset: .18em;
  transition:
    color var(--wiki-motion-fast) var(--wiki-motion-ease),
    text-decoration-color var(--wiki-motion-fast) var(--wiki-motion-ease);
}

.agent-markdown :deep(a:hover) {
  color: rgb(var(--v-theme-on-surface));
  text-decoration-thickness: .12em;
}

.agent-markdown :deep(a:focus-visible) {
  color: rgb(var(--v-theme-on-surface));
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

.agent-markdown :deep(a[target='_blank']:not([data-agent-citation='true']))::after {
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

.agent-markdown :deep(.agent-markdown__diagram-output) {
  align-items: center;
  display: flex;
  justify-content: center;
  min-height: var(--wiki-space-12);
  padding: var(--wiki-space-4);
}

.agent-markdown :deep(.agent-markdown__diagram-output[aria-busy='true']) {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 62%, transparent);
  font-size: var(--wiki-label-size);
}

.agent-markdown :deep(.agent-markdown__diagram-output svg) {
  block-size: auto;
  max-block-size: min(60vh, 32rem);
  max-inline-size: 100%;
}

.agent-markdown :deep(.agent-markdown__diagram-source) {
  border-block-start: 1px solid var(--wiki-surface-border);
}

.agent-markdown :deep(.agent-markdown__diagram-source summary) {
  color: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 72%, transparent);
  cursor: pointer;
  font-family: var(--wiki-font-mono);
  font-size: var(--wiki-label-size);
  padding: var(--wiki-space-2) var(--wiki-space-3);
}

.agent-markdown :deep(.agent-markdown__diagram-error) {
  color: rgb(var(--v-theme-error));
  margin: 0;
  text-align: center;
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
.agent-markdown :deep(a[data-agent-citation='true']),
.agent-markdown :deep(strong[data-agent-citation='true']) {
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

.agent-markdown :deep(a[data-agent-citation='true']:hover),
.agent-markdown :deep(strong[data-agent-citation='true']:hover) {
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

  .agent-markdown :deep(a[data-agent-citation='true']),
  .agent-markdown :deep(strong[data-agent-citation='true']) {
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
  .agent-markdown :deep(a[data-agent-citation='true']),
  .agent-markdown :deep(strong[data-agent-citation='true']) {
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
