<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'

const {
  targetValue = 0,
  durationMs = 800,
  prefix = '',
  suffix = ''
} = defineProps<{
  targetValue: number
  durationMs?: number
  prefix?: string
  suffix?: string
}>()

const displayValue = ref(targetValue)
let animationFrameId: number | null = null

const startRollup = (from: number, to: number) => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  const startTime = performance.now()
  const step = (now: number) => {
    const elapsed = now - startTime
    const progress = Math.min(1, elapsed / durationMs)
    const eased = 1 - Math.pow(1 - progress, 3) // cubic ease-out
    displayValue.value = Math.round(from + (to - from) * eased)
    if (progress < 1) {
      animationFrameId = requestAnimationFrame(step)
    } else {
      displayValue.value = to
      animationFrameId = null
    }
  }
  animationFrameId = requestAnimationFrame(step)
}

watch(
  () => targetValue,
  (newVal, oldVal) => {
    startRollup(oldVal ?? 0, newVal)
  }
)

onMounted(() => {
  startRollup(0, targetValue)
})

onUnmounted(() => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
})
</script>

<template>
  <span class="animated-counter" :aria-label="`${prefix}${targetValue}${suffix}`">
    <span v-if="prefix" class="animated-counter__prefix">{{ prefix }}</span>
    <span class="animated-counter__value">{{ displayValue.toLocaleString() }}</span>
    <span v-if="suffix" class="animated-counter__suffix">{{ suffix }}</span>
  </span>
</template>

<style scoped lang="scss">
.animated-counter {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;

  &__prefix,
  &__suffix {
    opacity: 0.8;
  }
}
</style>
