<template>
  <canvas ref="canvasEl" class="agent-dictation-waveform" aria-hidden="true" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  /** Whether the microphone is currently capturing. */
  active?: boolean
  /** Returns the current microphone level from 0 (silence) to 1 (loudest). */
  source?: () => number
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const reducedMotion = ref(false)

const BAR_PITCH = 4
const SAMPLE_INTERVAL = 70
/** Static bar level used under reduced-motion preferences. */
const REDUCED_LEVEL = 0.4

let observer: ResizeObserver | null = null
let frame = 0
let lastSample = 0
const history: number[] = []

const readLevel = (): number => {
  const source = props.source
  if (typeof source !== 'function') return 0
  try {
    const value = source()
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  } catch {
    return 0
  }
}

const draw = (): void => {
  const element = canvasEl.value
  if (!element) return
  const context = element.getContext('2d')
  if (!context) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = element.clientWidth
  const height = element.clientHeight
  if (width <= 0 || height <= 0) return
  const scaledWidth = Math.max(1, Math.round(width * dpr))
  const scaledHeight = Math.max(1, Math.round(height * dpr))
  if (element.width !== scaledWidth || element.height !== scaledHeight) {
    element.width = scaledWidth
    element.height = scaledHeight
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)
  const capacity = Math.max(1, Math.floor(width / BAR_PITCH))
  while (history.length < capacity) history.unshift(0)
  while (history.length > capacity) history.shift()
  // Neutral bars inherit the theme's text color; coral stays on the status dot.
  context.fillStyle = getComputedStyle(element).color || 'rgba(128, 128, 128, .55)'
  const slot = width / capacity
  for (let index = 0; index < capacity; index += 1) {
    const level = reducedMotion.value ? REDUCED_LEVEL : (history[index] ?? 0)
    const barHeight = Math.max(2, Math.round(level * (height - 4)))
    context.fillRect(index * slot, (height - barHeight) / 2, Math.max(1, slot - 1.2), barHeight)
  }
}

const tick = (time: number): void => {
  if (time - lastSample >= SAMPLE_INTERVAL) {
    lastSample = time
    history.push(readLevel())
    if (history.length > 240) history.shift()
    draw()
  }
  frame = window.requestAnimationFrame(tick)
}

const start = (): void => {
  if (frame || reducedMotion.value) return
  lastSample = 0
  frame = window.requestAnimationFrame(tick)
}

const stop = (): void => {
  if (frame) {
    window.cancelAnimationFrame(frame)
    frame = 0
  }
}

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    reducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => draw())
    const element = canvasEl.value
    if (element) observer.observe(element)
  }
  if (props.active) start()
  draw()
})

watch(() => props.active, active => {
  if (active) {
    history.length = 0
    start()
  } else {
    stop()
    draw()
  }
})

onBeforeUnmount(() => {
  stop()
  observer?.disconnect()
  observer = null
})
</script>

<style scoped>
.agent-dictation-waveform {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  /* Neutral level bars; the theme decides light/dark automatically. */
  color: rgb(var(--v-theme-on-surface), .5);
}
</style>
