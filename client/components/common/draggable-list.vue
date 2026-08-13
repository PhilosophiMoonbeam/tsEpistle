<template>
  <component
    :is="tag"
    ref="root"
    class="draggable-list"
    @pointerdown.capture="handlePointerDown"
    @dragstart="handleDragStart"
    @dragover.prevent="handleDragOver"
    @drop.prevent="handleDrop"
    @dragend="resetDrag"
  >
    <slot />
  </component>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUpdated, ref } from 'vue'

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
let dragIndex = -1
let handlePressed = false

function refreshChildren (): void {
  for (const child of Array.from(root.value?.children ?? [])) {
    if (child instanceof HTMLElement) child.draggable = true
  }
}

function directChildIndex (target: EventTarget | null): number {
  if (!(target instanceof Node) || !root.value) return -1
  return Array.from(root.value.children).findIndex(child => child === target || child.contains(target))
}

function handlePointerDown (event: PointerEvent): void {
  if (!props.handle) {
    handlePressed = true
    return
  }
  handlePressed = event.target instanceof Element && Boolean(event.target.closest(props.handle))
}

function handleDragStart (event: DragEvent): void {
  if (!handlePressed) {
    event.preventDefault()
    return
  }
  dragIndex = directChildIndex(event.target)
  if (dragIndex < 0) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('text/plain', String(dragIndex))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function handleDragOver (event: DragEvent): void {
  if (dragIndex >= 0 && event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function handleDrop (event: DragEvent): void {
  const targetIndex = directChildIndex(event.target)
  if (dragIndex < 0 || targetIndex < 0 || targetIndex === dragIndex) {
    resetDrag()
    return
  }
  const next = [...props.modelValue]
  const [moved] = next.splice(dragIndex, 1)
  next.splice(targetIndex, 0, moved)
  emit('update:modelValue', next)
  resetDrag()
}

function resetDrag (): void {
  dragIndex = -1
  handlePressed = false
  void nextTick(refreshChildren)
}

onMounted(refreshChildren)
onUpdated(refreshChildren)
</script>
