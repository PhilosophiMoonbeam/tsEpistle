<template>
  <span>{{ displayValue }}</span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  value: number
  duration?: number
  formatValue?: (value: number) => string | number
}>(), {
  duration: 600,
  formatValue: (value: number) => value
})

const displayValue = ref<string | number>(props.formatValue(props.value))
let frame = 0
let renderedValue = props.value

function animateTo (target: number): void {
  cancelAnimationFrame(frame)
  const from = renderedValue
  const startedAt = performance.now()
  const duration = Math.max(0, props.duration)

  const render = (now: number): void => {
    const progress = duration === 0 ? 1 : Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 5)
    renderedValue = from + (target - from) * eased
    displayValue.value = props.formatValue(renderedValue)
    if (progress < 1) frame = requestAnimationFrame(render)
  }

  frame = requestAnimationFrame(render)
}

watch(() => props.value, animateTo, { immediate: true })
onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>
