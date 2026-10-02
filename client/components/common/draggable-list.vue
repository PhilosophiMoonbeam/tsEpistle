<template>
  <component
    :is="tag"
    v-bind="$attrs"
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
  </component>
  <span :id="instructionsId" class="draggable-list__instructions" data-draggable-instructions>
      {{ $t('common:draggableList.pressSpaceEnterPick') }}
    </span>
  <span class="draggable-list__announcement" data-draggable-announcement aria-live="polite" aria-atomic="true">{{ liveMessage }}</span>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useId, useTemplateRef } from 'vue'
import { useTranslate } from '../../helpers/use-translate.ts'

const t = useTranslate()

defineOptions({ inheritAttrs: false })
const modelValue = defineModel<unknown[]>({ required: true })
const { handle = '', tag = 'div' } = defineProps<{
  handle?: string
  tag?: string
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
let keyboardMoving = false
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
  for (const elementHandle of root.value?.querySelectorAll<HTMLElement>('[data-draggable-handle="true"]') ?? []) {
    if (handle && elementHandle.matches(handle)) continue
    elementHandle.removeAttribute('aria-pressed')
    removeInstructionReference(elementHandle)
    elementHandle.removeAttribute('data-draggable-handle')
  }
  for (const [index, child] of children.entries()) {
    child.draggable = true
    child.setAttribute('role', 'listitem')
    child.classList.toggle('is-dragging', sourceIndex === index)
    child.classList.toggle('is-drop-target', dropTargetIndex === index && sourceIndex !== index)
    child.setAttribute('aria-posinset', String(index + 1))
    child.setAttribute('aria-setsize', String(itemCount))
    child.removeAttribute('aria-grabbed')
    if (handle) {
      for (const elementHandle of child.querySelectorAll(handle)) {
        if (!(elementHandle instanceof HTMLElement)) continue
        elementHandle.tabIndex = 0
        elementHandle.setAttribute('role', 'button')
        elementHandle.setAttribute('aria-roledescription', t('common:draggableList.sortableItem'))
        if (!elementHandle.hasAttribute('aria-label') && !elementHandle.hasAttribute('aria-labelledby')) {
          elementHandle.setAttribute('aria-label', t('common:draggableList.reorderItem'))
        }
        elementHandle.setAttribute('aria-pressed', String(sourceIndex === index))
        elementHandle.setAttribute('data-draggable-handle', 'true')
        addInstructionReference(elementHandle)
      }
    } else {
      child.tabIndex = 0
      child.setAttribute('aria-roledescription', t('common:draggableList.sortableItem'))
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
  if (handle) {
    if (!(target instanceof Element)) return -1
    const elementHandle = target.closest(handle)
    return elementHandle && root.value?.contains(elementHandle) ? directChildIndex(elementHandle) : -1
  }
  return directChildIndex(target)
}

function positionMessage (index: number): string {
  return t('common:draggableList.position', { value: index + 1, valueCount: modelValue.value.length, interpolation: { escapeValue: false } })
}

function emitReorder (from: number, to: number): void {
  if (from < 0 || to < 0 || from === to || from >= modelValue.value.length || to >= modelValue.value.length) return
  const next = [...modelValue.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  modelValue.value = next
}

function handlePointerDown (event: PointerEvent): void {
  const handleEl = handle && event.target instanceof Element ? event.target.closest(handle) : null
  const validHandle = !handle || Boolean(handleEl && directChildIndex(handleEl) >= 0)
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
    pointerOriginal = [...modelValue.value]
    sourceIndex = pointerStartIndex
    liveMessage.value = t('common:draggableList.pickedUpItem', { pointerStartIndex: positionMessage(pointerStartIndex), interpolation: { escapeValue: false } })
  }
  event.preventDefault()
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const targetIndex = directChildIndex(target)
  if (targetIndex < 0 || targetIndex === sourceIndex) return
  const previousIndex = sourceIndex
  emitReorder(previousIndex, targetIndex)
  sourceIndex = targetIndex
  dropTargetIndex = targetIndex
  liveMessage.value = t('common:draggableList.movedItem', { targetIndex: positionMessage(targetIndex), interpolation: { escapeValue: false } })
  scheduleRefreshChildren()
  void nextTick(() => {
    const child = itemChildren()[targetIndex]
    const control = handle ? child?.querySelector<HTMLElement>(handle) : child
    control?.focus()
    keyboardMoving = false
  })
}

function handlePointerUp (event: PointerEvent): void {
  if (pointerId === null) {
    handlePressed = false
    return
  }
  if (pointerId !== event.pointerId) return
  if (pointerDragging) liveMessage.value = t('common:draggableList.droppedItem', { sourceIndex: positionMessage(sourceIndex), interpolation: { escapeValue: false } })
  if (root.value?.hasPointerCapture?.(event.pointerId)) root.value.releasePointerCapture(event.pointerId)
  pointerId = null
  pointerStartIndex = -1
  pointerDragging = false
  resetDrag()
}

function handlePointerCancel (event: PointerEvent): void {
  if (pointerId !== event.pointerId) return
  if (pointerDragging && pointerOriginal) {
    modelValue.value = pointerOriginal
    liveMessage.value = t('common:draggableList.cancelledReorder')
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
    keyboardOriginal = [...modelValue.value]
    sourceIndex = index
    liveMessage.value = t('common:draggableList.pickedUpItem2', { index: positionMessage(index), interpolation: { escapeValue: false } })
    scheduleRefreshChildren()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (keyboardOriginal) modelValue.value = keyboardOriginal
    liveMessage.value = t('common:draggableList.cancelledReorder')
    resetDrag()
    keyboardIndex = -1
    keyboardOriginal = null
    return
  }
  if (isActivation) {
    event.preventDefault()
    event.stopPropagation()
    liveMessage.value = t('common:draggableList.droppedItem2', { keyboardIndex: positionMessage(keyboardIndex), interpolation: { escapeValue: false } })
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
  if (targetIndex < 0 || targetIndex >= modelValue.value.length) return
  keyboardMoving = true
  emitReorder(keyboardIndex, targetIndex)
  keyboardIndex = targetIndex
  sourceIndex = targetIndex
  dropTargetIndex = targetIndex
  liveMessage.value = t('common:draggableList.movedItem', { targetIndex: positionMessage(targetIndex), interpolation: { escapeValue: false } })
  scheduleRefreshChildren()
  void nextTick(() => {
    const child = itemChildren()[targetIndex]
    const control = handle ? child?.querySelector<HTMLElement>(handle) : child
    control?.focus()
    keyboardMoving = false
  })
}

function handleFocusOut (event: FocusEvent): void {
  if (keyboardIndex < 0 || keyboardMoving) return
  if (itemIndexForKeyboardTarget(event.relatedTarget) === keyboardIndex) return
  if (keyboardOriginal) modelValue.value = keyboardOriginal
  liveMessage.value = t('common:draggableList.cancelledReorder')
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
  liveMessage.value = t('common:draggableList.pickedUpItem2', { index: positionMessage(index), interpolation: { escapeValue: false } })
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
    liveMessage.value = t('common:draggableList.droppedItem3', { targetIndex: positionMessage(targetIndex), interpolation: { escapeValue: false } })
  }
  resetDrag()
}

function handleDragEnd (): void {
  if (sourceIndex >= 0) liveMessage.value = t('common:draggableList.cancelledReorder')
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
  outline: 2px solid rgb(var(--v-theme-focus, var(--v-theme-on-surface)));
  outline-offset: -2px;
}

.draggable-list [data-draggable-handle='true'] {
  cursor: grab;
  touch-action: none;
}

.draggable-list [data-draggable-handle='true']:focus-visible {
  outline: 2px solid rgb(var(--v-theme-focus, var(--v-theme-on-surface)));
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .draggable-list > .is-dragging { transition: none; }
}
</style>
