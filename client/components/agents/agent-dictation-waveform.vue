<template>
  <canvas ref="canvasEl" class="agent-dictation-waveform" aria-hidden="true" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { dictationTone, type DictationTone } from './agent-dictation-tone.ts'

const props = defineProps<{
  /** Whether the microphone is currently capturing. */
  active?: boolean
  /** Returns the current microphone level from 0 (silence) to 1 (loudest). */
  source?: () => number
  /** Returns the current RMS level in dBFS for tone thresholds; optional. */
  dbSource?: () => number
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const reducedMotion = ref(false)

const BAR_PITCH = 4
const SAMPLE_INTERVAL = 70
/** Static bar level used under reduced-motion preferences. */
const REDUCED_LEVEL = 0.4

interface Sample {
  level: number
  tone: DictationTone
}

let observer: ResizeObserver | null = null
let frame = 0
let lastSample = 0
const history: Sample[] = []

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

const readDb = (): number => {
  const source = props.dbSource
  if (typeof source !== 'function') return Number.NaN
  try {
    return source()
  } catch {
    return Number.NaN
  }
}

// Theme palettes are CSS custom properties; canvas cannot read var() so the
// components resolve them through computed style and refresh periodically to
// follow theme switches.
const PALETTE_TONES: DictationTone[] = ['neutral', 'safe', 'warn', 'loud']
const PALETTE_VARS: Record<DictationTone, string> = {
  neutral: '--v-theme-on-surface',
  safe: '--v-theme-success',
  warn: '--v-theme-warning',
  loud: '--v-theme-error'
}
const PALETTE_FALLBACK: Record<DictationTone, string> = {
  neutral: 'rgba(128, 128, 128, .55)',
  safe: 'rgba(46, 160, 67, .9)',
  warn: 'rgba(216, 148, 10, .95)',
  loud: 'rgba(227, 72, 80, .95)'
}
let palette: Record<DictationTone, string> | null = null
let paletteAt = -Number.POSITIVE_INFINITY

const resolvePalette = (element: HTMLCanvasElement, time: number): Record<DictationTone, string> => {
  if (palette && time - paletteAt < 1500) return palette
  paletteAt = time
  const style = getComputedStyle(element)
  const next = {} as Record<DictationTone, string>
  for (const tone of PALETTE_TONES) {
    const value = style.getPropertyValue(PALETTE_VARS[tone]).trim()
    next[tone] = value ? `rgb(${value})` : PALETTE_FALLBACK[tone]
  }
  palette = next
  return next
}

const pushSample = (): void => {
  const level = readLevel()
  history.push({ level, tone: dictationTone(level, readDb()) })
}

const draw = (time = Number.POSITIVE_INFINITY): void => {
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
  while (history.length < capacity) history.unshift({ level: 0, tone: 'neutral' })
  while (history.length > capacity) history.shift()
  // Bars scroll continuously: the newest sample slides in from the right
  // edge while earlier bars drift left one pitch per sample interval, so the
  // wave moves at display rate instead of jumping once per sample.
  const count = history.length
  const frac = lastSample === 0 || time === Number.POSITIVE_INFINITY ? 1 : Math.min(1, Math.max(0, (time - lastSample) / SAMPLE_INTERVAL))
  const tones = resolvePalette(element, time)
  const baseline = Math.max(2, Math.round(reducedMotion.value ? REDUCED_LEVEL * (height - 4) : 2))
  for (let index = 0; index < count; index += 1) {
    const age = count - 1 - index
    const x = width - (age + frac) * BAR_PITCH
    if (x + BAR_PITCH <= 0) continue
    const sample = reducedMotion.value ? { level: REDUCED_LEVEL, tone: 'neutral' as const } : history[index]
    const barHeight = reducedMotion.value ? Math.round(REDUCED_LEVEL * (height - 4)) : Math.max(2, Math.round(sample.level * (height - 4)))
    if (barHeight <= baseline) {
      context.fillStyle = tones.neutral
      context.fillRect(x, (height - barHeight) / 2, BAR_PITCH - 1.2, barHeight)
      continue
    }
    context.fillStyle = tones[sample.tone === 'neutral' ? 'neutral' : sample.tone]
    context.fillRect(x, (height - barHeight) / 2, BAR_PITCH - 1.2, barHeight)
  }
}

const tick = (time: number): void => {
  if (time - lastSample >= SAMPLE_INTERVAL) {
    lastSample = time
    pushSample()
    draw(time)
  } else {
    draw(time)
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
