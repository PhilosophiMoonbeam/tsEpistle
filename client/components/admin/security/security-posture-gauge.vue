<script setup lang="ts">
import { computed, useId } from 'vue'

const {
  score = 0,
  maxScore = 100,
  size = 180,
  strokeWidth = 12,
  label = 'Security Posture Index'
} = defineProps<{
  score: number
  maxScore?: number
  size?: number
  strokeWidth?: number
  label?: string
}>()

const filterId = useId()
const gradientId = useId()
const radius = computed(() => (size - strokeWidth) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const normalizedScore = computed(() => Math.min(maxScore, Math.max(0, score)))
const dashOffset = computed(() => circumference.value - (normalizedScore.value / maxScore) * circumference.value)
const center = computed(() => size / 2)

const healthTone = computed(() => {
  if (normalizedScore.value >= 85) return { color: '#10b981', secondary: '#06b6d4', status: 'Fortified' }
  if (normalizedScore.value >= 60) return { color: '#06b6d4', secondary: '#6366f1', status: 'Balanced' }
  return { color: '#f59e0b', secondary: '#ef4444', status: 'Exposure Detected' }
})
</script>

<template>
  <div class="posture-gauge" :style="{ width: `${size}px` }">
    <div class="posture-gauge__chart-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
      <svg
        class="posture-gauge__svg"
        :width="size"
        :height="size"
        :viewBox="`0 0 ${size} ${size}`"
        role="img"
        :aria-label="`${label}: ${Math.round(normalizedScore)} out of ${maxScore} (${healthTone.status})`"
      >
        <defs>
          <filter :id="filterId" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="4.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient :id="gradientId" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" :stop-color="healthTone.color" />
            <stop offset="50%" stop-color="#06b6d4" />
            <stop offset="100%" :stop-color="healthTone.secondary" />
          </linearGradient>
        </defs>
        <!-- Background Track -->
        <circle
          class="posture-gauge__track"
          :cx="center"
          :cy="center"
          :r="radius"
          fill="none"
          :stroke-width="strokeWidth"
        />
        <!-- Animated Active Arc -->
        <circle
          class="posture-gauge__arc"
          :cx="center"
          :cy="center"
          :r="radius"
          fill="none"
          :stroke="`url(#${gradientId})`"
          :stroke-width="strokeWidth"
          stroke-linecap="round"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
          :filter="`url(#${filterId})`"
          :transform="`rotate(-90 ${center} ${center})`"
        />
      </svg>
      <!-- Center Telemetry Overlay -->
      <div class="posture-gauge__center">
        <svg
          class="posture-gauge__shield-icon"
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          :stroke="healthTone.color"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <span class="posture-gauge__score-value">{{ Math.round(normalizedScore) }}%</span>
        <span
          class="posture-gauge__status-pill"
          :style="{
            color: healthTone.color,
            borderColor: `color-mix(in srgb, ${healthTone.color} 30%, transparent)`,
            backgroundColor: `color-mix(in srgb, ${healthTone.color} 10%, transparent)`
          }"
        >
          {{ healthTone.status }}
        </span>
      </div>
    </div>
    <div v-if="label" class="posture-gauge__label">{{ label }}</div>
  </div>
</template>

<style scoped lang="scss">
.posture-gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  user-select: none;

  &__chart-wrap {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__svg {
    display: block;
    overflow: visible;
  }

  &__track {
    stroke: rgba(var(--v-theme-on-surface), 0.08);
  }

  &__arc {
    transition: stroke-dashoffset 0.85s cubic-bezier(0.16, 1, 0.3, 1), stroke 0.4s ease;
  }

  &__center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    text-align: center;
    gap: 3px;
  }

  &__shield-icon {
    filter: drop-shadow(0 0 6px rgba(6, 182, 212, 0.45));
    transition: stroke 0.4s ease;
  }

  &__score-value {
    font-size: 1.85rem;
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1;
    color: rgb(var(--v-theme-on-surface));
    font-variant-numeric: tabular-nums;
  }

  &__status-pill {
    font-size: 0.64rem;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid currentColor;
    line-height: 1.4;
    transition: all 0.4s ease;
  }

  &__label {
    margin-top: 8px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: rgba(var(--v-theme-on-surface), 0.6);
    text-align: center;
  }
}
</style>
