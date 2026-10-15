<template lang="pug">
section.discussion-annotations(v-if='enabled', aria-label='Passage discussions')
  .d-flex.flex-wrap.align-center.ga-2.my-3
    v-btn(size='small', variant='tonal', prepend-icon='mdi-comment-quote-outline', :disabled='!selected || !canCompose', @pointerdown.prevent, @click='compose') Discuss selected passage
    span.text-body-small(role='status', aria-live='polite') {{ selectionMessage }}
  v-alert.my-2(v-if='error', type='warning', variant='tonal', role='status')
    | {{ error }}
    v-btn.ml-2(size='small', variant='text', @click='reload') Retry
  p.text-body-small(v-if='jumpMessage', role='status', aria-live='polite') {{ jumpMessage }}
  details(v-if='items.length', open)
    summary.text-body-small Passage discussions ({{ items.length }}{{ nextAfter !== null ? '+' : '' }})
    ol.discussion-annotations-list
      li.my-3(v-for='item in located', :key='item.annotation.id')
        .d-flex.flex-wrap.align-center.ga-2
          v-btn.discussion-quote(size='small', variant='text', :disabled='item.status !== "found"', @click='jump(item.annotation.anchor)') {{ item.annotation.anchor.exact }}
          span.text-label-small {{ item.status === 'missing' ? 'Passage no longer found' : item.status === 'ambiguous' ? 'Passage matches more than once' : item.annotation.resolvedAt ? 'Resolved' : 'Open' }}
          v-btn(size='small', variant='text', @click='$emit("thread", item.annotation.commentId)') Open thread
  v-btn.my-2(v-if='nextAfter !== null', size='small', variant='outlined', :loading='loading', @click='loadMore') More passage discussions
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DiscussionAnnotation, DiscussionAnnotationAnchor } from '../../../shared/discussion-annotations.ts'
import { wikiStore } from '../../store/index.ts'
import { pwaState } from '../../helpers/pwa'
import { captureDiscussionAnchor, discussionAnchorRange, indexDiscussionText } from '../../helpers/discussion-anchors.ts'
import { fetchDiscussionPageAnnotations } from '../../helpers/discussion-annotations-api.ts'
import { onDiscussionAnnotationsChanged, onJumpDiscussionAnnotation } from '../../helpers/discussion-annotation-events.ts'

const props = withDefaults(defineProps<{ pageId: number; contentRoot: HTMLElement | null; enabled?: boolean }>(), { enabled: true })
const emit = defineEmits<{ compose: [anchor: DiscussionAnnotationAnchor]; thread: [commentId: number] }>()
const items = ref<DiscussionAnnotation[]>([])
const nextAfter = ref<number | null>(null)
const loading = ref(false)
const error = ref('')
const selected = ref<DiscussionAnnotationAnchor | null>(null)
const selectionMessage = ref('Select up to 1,000 characters in the article, then discuss the passage.')
const jumpMessage = ref('')
const contentVersion = ref(0)
const canCompose = computed(() => wikiStore.page.effectivePermissions.comments.write && pwaState.connectionState === 'online')
let generation = 0
let controller: AbortController | null = null
let observer: MutationObserver | null = null
let removeChanged: (() => void) | null = null
let removeJump: (() => void) | null = null
const highlightName = 'discussion-passages'
type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void }
const highlightApi = () => (window.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
const located = computed(() => {
  void contentVersion.value
  const root = props.contentRoot
  const index = root ? indexDiscussionText(root) : null
  return items.value.map(annotation => ({ annotation, ...(index ? discussionAnchorRange(index, annotation.anchor) : { status: 'missing' as const }) }))
})
function paint(): void {
  highlightApi()?.delete(highlightName)
  if (!props.enabled) return
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (Highlight) highlightApi()?.set(highlightName, new Highlight(...located.value.flatMap(item => item.status === 'found' ? [item.range] : [])))
}
function capture(): void {
  if (!props.enabled || !props.contentRoot) { selected.value = null; return }
  selected.value = captureDiscussionAnchor(props.contentRoot, window.getSelection())
  selectionMessage.value = selected.value ? 'Passage selected. Add its note in the discussion form.' : 'Select up to 1,000 characters in the article, then discuss the passage.'
}
function compose(): void {
  if (!selected.value || !canCompose.value) return
  emit('compose', { ...selected.value })
  selected.value = null
}
function jump(anchor: DiscussionAnnotationAnchor): void {
  const root = props.contentRoot
  if (!root || !props.enabled) return
  const found = discussionAnchorRange(indexDiscussionText(root), anchor)
  if (found.status !== 'found') {
    jumpMessage.value = found.status === 'ambiguous' ? 'This passage matches more than once; no location was chosen.' : 'This passage is no longer present in the current article.'
    return
  }
  jumpMessage.value = ''
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(found.range)
  const element = found.range.startContainer.parentElement
  element?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  // Focus the real article container, never a user-authored action/attribute.
  const previous = root.getAttribute('tabindex')
  root.setAttribute('tabindex', '-1')
  root.focus({ preventScroll: true })
  if (previous === null) root.removeAttribute('tabindex')
  else root.setAttribute('tabindex', previous)
}
async function loadMore(): Promise<void> {
  if (loading.value || !props.enabled || pwaState.connectionState !== 'online') return
  const current = generation, pageId = props.pageId, after = nextAfter.value
  const request = new AbortController()
  controller?.abort()
  controller = request
  loading.value = true
  error.value = ''
  try {
    const page = await fetchDiscussionPageAnnotations(pageId, after, request.signal)
    if (current !== generation || request.signal.aborted) return
    items.value = after === null ? page.items : [...items.value, ...page.items.filter(item => !items.value.some(existing => existing.id === item.id))]
    nextAfter.value = page.nextAfter
  } catch (cause) {
    if (current !== generation || request.signal.aborted) return
    // A revoked grant/session must not leave formerly authorized notes or highlights visible.
    items.value = []
    nextAfter.value = null
    error.value = cause instanceof Error ? cause.message : 'Passage discussions could not be loaded.'
  } finally {
    if (current === generation) { loading.value = false; controller = null }
  }
}
function reload(): void {
  generation++
  controller?.abort()
  controller = null
  loading.value = false
  items.value = []
  nextAfter.value = null
  error.value = ''
  selected.value = null
  jumpMessage.value = ''
  highlightApi()?.delete(highlightName)
  if (props.enabled && pwaState.connectionState === 'online') void loadMore()
}
watch(() => [props.pageId, props.enabled, wikiStore.user.id, wikiStore.user.authenticated, wikiStore.user.authVersion, pwaState.connectionState], reload, { flush: 'sync' })
watch(() => props.contentRoot, root => {
  observer?.disconnect()
  observer = null
  selected.value = null
  contentVersion.value++
  if (root) {
    observer = new MutationObserver(() => { selected.value = null; contentVersion.value++ })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
  }
}, { immediate: true, flush: 'post' })
watch(located, paint, { flush: 'post' })
onMounted(() => {
  document.addEventListener('selectionchange', capture)
  removeChanged = onDiscussionAnnotationsChanged(pageId => { if (pageId === props.pageId) reload() })
  removeJump = onJumpDiscussionAnnotation((pageId, anchor) => {
    if (pageId !== props.pageId) return
    const current = generation
    void nextTick(() => { if (current === generation && pageId === props.pageId) jump(anchor) })
  })
  reload()
})
onBeforeUnmount(() => {
  generation++
  controller?.abort()
  observer?.disconnect()
  removeChanged?.()
  removeJump?.()
  document.removeEventListener('selectionchange', capture)
  highlightApi()?.delete(highlightName)
})
</script>

<style scoped>
.discussion-annotations-list { padding-inline-start: 1.25rem; }
.discussion-quote { max-width: 100%; height: auto; white-space: normal; text-align: start; }
.discussion-quote :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; }
:global(::highlight(discussion-passages)) { background-color: rgba(var(--v-theme-primary), .18); text-decoration: underline; text-decoration-color: rgb(var(--v-theme-primary)); }
</style>
