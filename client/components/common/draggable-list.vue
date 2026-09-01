<template>
  <component
    :is="tag"
    ref="root"
    class="draggable-list"
    @pointerdown.capture="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerUp"
    @keydown.capture="handleKeydown"
    @dragstart="handleDragStart"
    @dragover.prevent="handleDragOver"
    @drop.prevent="handleDrop"
    @dragend="resetDrag"
  >
    <slot />
    <span class="draggable-list__announcement" data-draggable-announcement aria-live="polite" aria-atomic="true">{{ liveMessage }}</span>
  </component>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: unknown[]
  handle?: string
  tag?: string
}>(), {
  handle: '',
  tag: 'div'
})

const emit = defineEmits<{
  'update:modelValue': [value: unknown[]]
}>()

const root = ref<HTMLElement | null>(null)
const sourceIndex = ref(-1)
const dropTargetIndex = ref(-1)
const liveMessage = ref('')
let handlePressed = false
let pointerId: number | null = null
let pointerStartIndex = -1
let pointerStartX = 0
let pointerStartY = 0
let pointerDragging = false
let keyboardIndex = -1
let keyboardOriginal: unknown[] | null = null
let refreshPending = false

function itemChildren (): HTMLElement[] {
  return Array.from(root.value?.children ?? [])
    .filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute('data-draggable-announcement'))
}

function refreshChildren (): void {
  const children = itemChildren()
  const itemCount = children.length
  for (const [index, child] of children.entries()) {
    child.draggable = true
    child.classList.toggle('is-dragging', sourceIndex.value === index)
    child.classList.toggle('is-drop-target', dropTargetIndex.value === index && sourceIndex.value !== index)
    child.setAttribute('aria-posinset', String(index + 1))
    child.setAttribute('aria-setsize', String(itemCount))
    child.setAttribute('aria-grabbed', String(sourceIndex.value === index))
    if (props.handle) {
      for (const handle of Array.from(child.querySelectorAll(props.handle))) {
        if (!(handle instanceof HTMLElement)) continue
        handle.tabIndex = 0
        handle.setAttribute('role', 'button')
        handle.setAttribute('aria-roledescription', 'sortable item')
        if (!handle.getAttribute('aria-label')) handle.setAttribute('aria-label', 'Reorder item')
        handle.setAttribute('aria-pressed', String(sourceIndex.value === index))
        handle.setAttribute('data-draggable-handle', 'true')
      }
    } else {
      child.tabIndex = 0
    }
  }
}

function scheduleRefreshChildren (): void {
  if (refreshPending) return
  refreshPending = true
  void nextTick(() => {
    refreshPending = false
    refreshChildren()
  })
}

function directChildIndex (target: EventTarget | null): number {
  if (!(target instanceof Node) || !root.value) return -1
  return itemChildren().findIndex(child => child === target || child.contains(target))
}

function itemIndexForKeyboardTarget (target: EventTarget | null): number {
  if (props.handle && target instanceof Element) {
    const handle = target.closest(props.handle)
    if (handle && root.value?.contains(handle)) return directChildIndex(handle)
  }
  return directChildIndex(target)
}

function positionMessage (index: number): string {
  return `Position ${index + 1} of ${props.modelValue.length}`
}

function emitReorder (from: number, to: number): void {
  if (from < 0 || to < 0 || from === to || from >= props.modelValue.length || to >= props.modelValue.length) return
  const next = [...props.modelValue]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  emit('update:modelValue', next)
}

function handlePointerDown (event: PointerEvent): void {
  const validHandle = !props.handle || (
    event.target instanceof Element && Boolean(event.target.closest(props.handle))
  )
  handlePressed = validHandle
  if (!validHandle || event.pointerType === 'mouse') return
  pointerId = event.pointerId
  pointerStartIndex = directChildIndex(event.target)
  pointerStartX = event.clientX
  pointerStartY = event.clientY
  pointerDragging = false
  root.value?.setPointerCapture?.(event.pointerId)
}

function handlePointerMove (event: PointerEvent): void {
  if (pointerId !== event.pointerId || pointerStartIndex < 0) return
  if (!pointerDragging) {
    const moved = Math.abs(event.clientX - pointerStartX) + Math.abs(event.clientY - pointerStartY)
    if (moved < 6) return
    pointerDragging = true
    sourceIndex.value = pointerStartIndex
    liveMessage.value = `Picked up item, ${positionMessage(pointerStartIndex)}`
  }
  event.preventDefault()
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const targetIndex = directChildIndex(target)
  if (targetIndex < 0 || targetIndex === sourceIndex.value) return
  const previousIndex = sourceIndex.value
  emitReorder(previousIndex, targetIndex)
  sourceIndex.value = targetIndex
  dropTargetIndex.value = targetIndex
  liveMessage.value = `Moved item, ${positionMessage(targetIndex)}`
  scheduleRefreshChildren()
}

function handlePointerUp (event: PointerEvent): void {
  if (pointerId === null) {
    handlePressed = false
    return
  }
  if (pointerId !== event.pointerId) return
  if (pointerDragging) liveMessage.value = `Dropped item, ${positionMessage(sourceIndex.value)}`
  root.value?.releasePointerCapture?.(event.pointerId)
  pointerId = null
  pointerStartIndex = -1
  pointerDragging = false
  resetDrag()
}

function handleKeydown (event: KeyboardEvent): void {
  const index = itemIndexForKeyboardTarget(event.target)
  if (index < 0) return
  const isActivation = event.key === ' ' || event.key === 'Enter'
  if (keyboardIndex < 0) {
    if (!isActivation) return
    event.preventDefault()
    event.stopPropagation()
    keyboardIndex = index
    keyboardOriginal = [...props.modelValue]
    sourceIndex.value = index
    liveMessage.value = `Picked up item, ${positionMessage(index)}`
    scheduleRefreshChildren()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (keyboardOriginal) emit('update:modelValue', keyboardOriginal)
    liveMessage.value = 'Cancelled reorder'
    resetDrag()
    keyboardIndex = -1
    keyboardOriginal = null
    return
  }
  if (isActivation) {
    event.preventDefault()
    event.stopPropagation()
    liveMessage.value = `Dropped item, ${positionMessage(keyboardIndex)}`
    resetDrag()
    keyboardIndex = -1
    keyboardOriginal = null
    return
  }
  const offset = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (!offset) return
  event.preventDefault()
  event.stopPropagation()
  const targetIndex = keyboardIndex + offset
  if (targetIndex < 0 || targetIndex >= props.modelValue.length) return
  emitReorder(keyboardIndex, targetIndex)
  keyboardIndex = targetIndex
  sourceIndex.value = targetIndex
  dropTargetIndex.value = targetIndex
  liveMessage.value = `Moved item, ${positionMessage(targetIndex)}`
  scheduleRefreshChildren()
}

function handleDragStart (event: DragEvent): void {
  if (!handlePressed) {
    event.preventDefault()
    return
  }
  const index = directChildIndex(event.target)
  if (index < 0) {
    event.preventDefault()
    return
  }
  sourceIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  liveMessage.value = `Picked up item, ${positionMessage(index)}`
  scheduleRefreshChildren()
}

function handleDragOver (event: DragEvent): void {
  if (sourceIndex.value < 0) return
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const targetIndex = directChildIndex(event.target)
  if (targetIndex >= 0) {
    dropTargetIndex.value = targetIndex
    scheduleRefreshChildren()
  }
}

function handleDrop (event: DragEvent): void {
  const targetIndex = directChildIndex(event.target)
  const from = sourceIndex.value
  if (from >= 0 && targetIndex >= 0 && targetIndex !== from) {
    emitReorder(from, targetIndex)
    liveMessage.value = `Dropped item, ${positionMessage(targetIndex)}`
  }
  resetDrag()
}

function resetDrag (): void {
  sourceIndex.value = -1
  dropTargetIndex.value = -1
  handlePressed = false
  scheduleRefreshChildren()
}

onMounted(refreshChildren)
onUpdated(() => {
  if (!refreshPending) refreshChildren()
})
onBeforeUnmount(() => {
  if (pointerId !== null && root.value?.hasPointerCapture?.(pointerId)) {
    root.value.releasePointerCapture(pointerId)
  }
})
</script>

<style scoped>
.draggable-list__announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.draggable-list > .is-dragging {
  opacity: .55;
}

.draggable-list > .is-drop-target {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

.draggable-list [data-draggable-handle='true'] {
  cursor: grab;
  touch-action: none;
}

.draggable-list [data-draggable-handle='true']:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .draggable-list > .is-dragging { transition: none; }
}
</style>
