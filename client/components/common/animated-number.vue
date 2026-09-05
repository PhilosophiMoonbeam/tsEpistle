<template>
  <span aria-hidden="true">{{ displayValue }}</span>
  <span class="animated-number__announcement" role="status" aria-live="polite" aria-atomic="true">{{ announcementValue }}</span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const {
  value,
  duration = 600,
  formatValue = (v: number) => v
} = defineProps<{
  value: number
  duration?: number
  formatValue?: (value: number) => string | number
}>()

const displayValue = ref<string | number>(formatValue(0))
const announcementValue = ref<string | number>(formatValue(value))
let frame: number | null = null
let renderedValue = 0
const mediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

function reducedMotionEnabled (): boolean {
  return mediaQuery?.matches ?? false
}

function cancelFrame (): void {
  if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  frame = null
}

function commitTarget (target: number): void {
  renderedValue = target
  displayValue.value = formatValue(target)
}

function animateTo (target: number): void {
  cancelFrame()
  announcementValue.value = formatValue(target)
  const animDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0
  if (
    reducedMotionEnabled() ||
    animDuration === 0 ||
    target === renderedValue ||
    !Number.isFinite(target) ||
    !Number.isFinite(renderedValue)
  ) {
    commitTarget(target)
    return
  }
  if (
    typeof requestAnimationFrame !== 'function' ||
    typeof performance === 'undefined'
  ) {
    commitTarget(target)
    return
  }
  const from = renderedValue
  const startedAt = performance.now()
  const render = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / animDuration)
    const eased = 1 - Math.pow(1 - progress, 5)
    renderedValue = from + (target - from) * eased
    displayValue.value = formatValue(renderedValue)
    if (progress < 1) {
      frame = requestAnimationFrame(render)
    } else {
      frame = null
      commitTarget(target)
    }
  }
  frame = requestAnimationFrame(render)
}

watch(() => value, animateTo, { immediate: true })

watch(() => formatValue, currentFormat => {
  displayValue.value = currentFormat(renderedValue)
  announcementValue.value = currentFormat(value)
})

function handleMotionPreferenceChange (event: MediaQueryListEvent): void {
  if (event.matches) {
    cancelFrame()
    commitTarget(value)
  }
}

onMounted(() => {
  mediaQuery?.addEventListener?.('change', handleMotionPreferenceChange)
  if (mediaQuery?.matches) commitTarget(value)
})

onBeforeUnmount(() => {
  cancelFrame()
  mediaQuery?.removeEventListener?.('change', handleMotionPreferenceChange)
})

</script>

<style scoped>
.animated-number__announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
}
</style>
