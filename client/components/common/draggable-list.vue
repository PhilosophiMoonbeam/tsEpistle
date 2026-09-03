<template>
  <component
    :is="tag"
    ref="root"
    class="draggable-list"
    role="list"
    @pointerdown.capture="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerCancel"
    @keydown.capture="handleKeydown"
    @focusout="handleFocusOut"
    @dragstart="handleDragStart"
    @dragover.prevent="handleDragOver"
    @drop.prevent="handleDrop"
    @dragend="handleDragEnd"
  >
    <slot />
    <span :id="instructionsId" class="draggable-list__instructions" data-draggable-instructions>
      Press Space or Enter to pick up. Use Arrow Up and Arrow Down to move. Press Space or Enter to drop, or Escape to cancel.
    </span>
    <span class="draggable-list__announcement" data-draggable-announcement aria-live="polite" aria-atomic="true">{{ liveMessage }}</span>
  </component>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useId, useTemplateRef } from 'vue'

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

const root = useTemplateRef<HTMLElement>('root')
const instructionsId = useId()
let sourceIndex = -1
let dropTargetIndex = -1
const liveMessage = ref('')
let handlePressed = false
let pointerId: number | null = null
let pointerStartIndex = -1
let pointerStartX = 0
let pointerStartY = 0
let pointerDragging = false
let pointerOriginal: unknown[] | null = null
let keyboardIndex = -1
let keyboardOriginal: unknown[] | null = null
let refreshPending = false

function itemChildren (): HTMLElement[] {
  const children: HTMLElement[] = []
  for (const child of root.value?.children ?? []) {
    if (
      child instanceof HTMLElement &&
      !child.hasAttribute('data-draggable-announcement') &&
      !child.hasAttribute('data-draggable-instructions')
    ) children.push(child)
  }
  return children
}

function addInstructionReference (element: HTMLElement): void {
  const references = new Set((element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
  references.add(instructionsId)
  element.setAttribute('aria-describedby', [...references].join(' '))
}

function removeInstructionReference (element: HTMLElement): void {
  const references = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(reference => reference && reference !== instructionsId)
  if (references.length > 0) element.setAttribute('aria-describedby', references.join(' '))
  else element.removeAttribute('aria-describedby')
}

function refreshChildren (): void {
  const children = itemChildren()
  const itemCount = children.length
  for (const handle of root.value?.querySelectorAll<HTMLElement>('[data-draggable-handle="true"]') ?? []) {
    if (props.handle && handle.matches(props.handle)) continue
    handle.removeAttribute('aria-pressed')
    removeInstructionReference(handle)
    handle.removeAttribute('data-draggable-handle')
  }
  for (const [index, child] of children.entries()) {
    child.draggable = true
    child.setAttribute('role', 'listitem')
    child.classList.toggle('is-dragging', sourceIndex === index)
    child.classList.toggle('is-drop-target', dropTargetIndex === index && sourceIndex !== index)
    child.setAttribute('aria-posinset', String(index + 1))
    child.setAttribute('aria-setsize', String(itemCount))
    child.removeAttribute('aria-grabbed')
    if (props.handle) {
      for (const handle of child.querySelectorAll(props.handle)) {
        if (!(handle instanceof HTMLElement)) continue
        handle.tabIndex = 0
        handle.setAttribute('role', 'button')
        handle.setAttribute('aria-roledescription', 'sortable item')
        if (!handle.hasAttribute('aria-label') && !handle.hasAttribute('aria-labelledby')) {
          handle.setAttribute('aria-label', 'Reorder item')
        }
        handle.setAttribute('aria-pressed', String(sourceIndex === index))
        handle.setAttribute('data-draggable-handle', 'true')
        addInstructionReference(handle)
      }
    } else {
      child.tabIndex = 0
      child.setAttribute('aria-roledescription', 'sortable item')
      addInstructionReference(child)
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
  let index = 0
  for (const child of root.value.children) {
    if (
      !(child instanceof HTMLElement) ||
      child.hasAttribute('data-draggable-announcement') ||
      child.hasAttribute('data-draggable-instructions')
    ) continue
    if (child === target || child.contains(target)) return index
    index += 1
  }
  return -1
}

function itemIndexForKeyboardTarget (target: EventTarget | null): number {
  if (props.handle) {
    if (!(target instanceof Element)) return -1
    const handle = target.closest(props.handle)
    return handle && root.value?.contains(handle) ? directChildIndex(handle) : -1
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
  const handle = props.handle && event.target instanceof Element ? event.target.closest(props.handle) : null
  const validHandle = !props.handle || Boolean(handle && directChildIndex(handle) >= 0)
  handlePressed = validHandle
  if (!validHandle || event.pointerType === 'mouse') return
  pointerId = event.pointerId
  pointerStartIndex = directChildIndex(event.target)
  pointerStartX = event.clientX
  pointerStartY = event.clientY
  pointerDragging = false
  pointerOriginal = null
  root.value?.setPointerCapture?.(event.pointerId)
}

function handlePointerMove (event: PointerEvent): void {
  if (pointerId !== event.pointerId || pointerStartIndex < 0) return
  if (!pointerDragging) {
    const moved = Math.abs(event.clientX - pointerStartX) + Math.abs(event.clientY - pointerStartY)
    if (moved < 6) return
    pointerDragging = true
    pointerOriginal = [...props.modelValue]
    sourceIndex = pointerStartIndex
    liveMessage.value = `Picked up item, ${positionMessage(pointerStartIndex)}`
  }
  event.preventDefault()
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const targetIndex = directChildIndex(target)
  if (targetIndex < 0 || targetIndex === sourceIndex) return
  const previousIndex = sourceIndex
  emitReorder(previousIndex, targetIndex)
  sourceIndex = targetIndex
  dropTargetIndex = targetIndex
  liveMessage.value = `Moved item, ${positionMessage(targetIndex)}`
  scheduleRefreshChildren()
}

function handlePointerUp (event: PointerEvent): void {
  if (pointerId === null) {
    handlePressed = false
    return
  }
  if (pointerId !== event.pointerId) return
  if (pointerDragging) liveMessage.value = `Dropped item, ${positionMessage(sourceIndex)}`
  if (root.value?.hasPointerCapture?.(event.pointerId)) root.value.releasePointerCapture(event.pointerId)
  pointerId = null
  pointerStartIndex = -1
  pointerDragging = false
  resetDrag()
}

function handlePointerCancel (event: PointerEvent): void {
  if (pointerId !== event.pointerId) return
  if (pointerDragging && pointerOriginal) {
    emit('update:modelValue', pointerOriginal)
    liveMessage.value = 'Cancelled reorder'
  }
  if (root.value?.hasPointerCapture?.(event.pointerId)) root.value.releasePointerCapture(event.pointerId)
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
    sourceIndex = index
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
  sourceIndex = targetIndex
  dropTargetIndex = targetIndex
  liveMessage.value = `Moved item, ${positionMessage(targetIndex)}`
  scheduleRefreshChildren()
}

function handleFocusOut (event: FocusEvent): void {
  if (keyboardIndex < 0) return
  if (itemIndexForKeyboardTarget(event.relatedTarget) === keyboardIndex) return
  if (keyboardOriginal) emit('update:modelValue', keyboardOriginal)
  liveMessage.value = 'Cancelled reorder'
  keyboardIndex = -1
  keyboardOriginal = null
  resetDrag()
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
  sourceIndex = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  liveMessage.value = `Picked up item, ${positionMessage(index)}`
  scheduleRefreshChildren()
}

function handleDragOver (event: DragEvent): void {
  if (sourceIndex < 0) return
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const targetIndex = directChildIndex(event.target)
  if (targetIndex >= 0) {
    dropTargetIndex = targetIndex
    scheduleRefreshChildren()
  }
}

function handleDrop (event: DragEvent): void {
  const targetIndex = directChildIndex(event.target)
  const from = sourceIndex
  if (from >= 0 && targetIndex >= 0) {
    if (targetIndex !== from) emitReorder(from, targetIndex)
    liveMessage.value = `Dropped item, ${positionMessage(targetIndex)}`
  }
  resetDrag()
}

function handleDragEnd (): void {
  if (sourceIndex >= 0) liveMessage.value = 'Cancelled reorder'
  resetDrag()
}

function resetDrag (): void {
  sourceIndex = -1
  dropTargetIndex = -1
  handlePressed = false
  pointerOriginal = null
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
.draggable-list__instructions,
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
