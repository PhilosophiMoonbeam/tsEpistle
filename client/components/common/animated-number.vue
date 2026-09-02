<template>
  <span aria-hidden="true">{{ displayValue }}</span>
  <span class="animated-number__announcement" role="status" aria-live="polite" aria-atomic="true">{{ announcementValue }}</span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  value: number
  duration?: number
  formatValue?: (value: number) => string | number
}>(), {
  duration: 600,
  formatValue: (value: number) => value
})

const displayValue = ref<string | number>(props.formatValue(0))
const announcementValue = ref<string | number>(props.formatValue(props.value))
let frame: number | null = null
let renderedValue = 0
let mediaQuery: MediaQueryList | null = null

function reducedMotionEnabled (): boolean {
  return mediaQuery?.matches ?? (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function cancelFrame (): void {
  if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  frame = null
}

function commitTarget (target: number): void {
  renderedValue = target
  displayValue.value = props.formatValue(target)
}

function animateTo (target: number): void {
  cancelFrame()
  announcementValue.value = props.formatValue(target)
  if (reducedMotionEnabled()) {
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
  const duration = Number.isFinite(props.duration) ? Math.max(0, props.duration) : 0
  const render = (now: number): void => {
    const progress = duration === 0 ? 1 : Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 5)
    renderedValue = from + (target - from) * eased
    displayValue.value = props.formatValue(renderedValue)
    if (progress < 1) {
      frame = requestAnimationFrame(render)
    } else {
      frame = null
      commitTarget(target)
    }
  }
  frame = requestAnimationFrame(render)
}

watch(() => props.value, animateTo, { immediate: true })

watch(() => props.formatValue, formatValue => {
  displayValue.value = formatValue(renderedValue)
  announcementValue.value = formatValue(props.value)
})

function handleMotionPreferenceChange (event: MediaQueryListEvent): void {
  if (event.matches) {
    cancelFrame()
    commitTarget(props.value)
  }
}

onMounted(() => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  mediaQuery.addEventListener?.('change', handleMotionPreferenceChange)
  if (mediaQuery.matches) commitTarget(props.value)
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
