<script setup lang="ts">
import { computed, useId } from 'vue'

const {
  heapUsed = 0,
  heapTotal = 1,
  processRss = 0,
  osTotal = 1,
  size = 180,
  strokeWidth = 10,
  label = 'Memory Telemetry'
} = defineProps<{
  heapUsed: number
  heapTotal: number
  processRss: number
  osTotal: number
  size?: number
  strokeWidth?: number
  label?: string
}>()

const heapGradId = useId()
const rssGradId = useId()
const gaugeFilterId = useId()

const center = computed(() => size / 2)

// Outer arc: JS Heap in use vs allocated (#06b6d4 to #8b5cf6)
const outerRadius = computed(() => Math.max(1, (size - strokeWidth) / 2))
const outerCircumference = computed(() => 2 * Math.PI * outerRadius.value)
const heapPercent = computed(() => (heapTotal > 0 ? Math.min(100, Math.max(0, (heapUsed / heapTotal) * 100)) : 0))
const outerDashOffset = computed(() => outerCircumference.value - (heapPercent.value / 100) * outerCircumference.value)

// Inner arc: Process RSS vs OS total (#10b981 to #06b6d4)
const innerStrokeWidth = computed(() => Math.max(4, Math.round(strokeWidth * 0.75)))
const innerRadius = computed(() => Math.max(6, outerRadius.value - strokeWidth - 5))
const innerCircumference = computed(() => 2 * Math.PI * innerRadius.value)
const rssPercent = computed(() => (osTotal > 0 ? Math.min(100, Math.max(0, (processRss / osTotal) * 100)) : 0))
const innerDashOffset = computed(() => innerCircumference.value - (rssPercent.value / 100) * innerCircumference.value)
</script>

<template>
  <div class="cybernetic-hardware-gauge" :style="{ width: `${size}px` }">
    <div class="cybernetic-hardware-gauge__chart-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
      <svg
        class="cybernetic-hardware-gauge__svg"
        :width="size"
        :height="size"
        :viewBox="`0 0 ${size} ${size}`"
        role="img"
        :aria-label="`${label}: Heap ${Math.round(heapPercent)}% in use, RSS ${Math.round(rssPercent)}% of OS total`"
      >
        <defs>
          <!-- Glow Filter -->
          <filter :id="gaugeFilterId" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <!-- Outer arc gradient: JS Heap in use vs allocated (#06b6d4 to #8b5cf6) -->
          <linearGradient :id="heapGradId" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#06b6d4" />
            <stop offset="100%" stop-color="#8b5cf6" />
          </linearGradient>

          <!-- Inner arc gradient: Process RSS vs OS total (#10b981 to #06b6d4) -->
          <linearGradient :id="rssGradId" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#10b981" />
            <stop offset="100%" stop-color="#06b6d4" />
          </linearGradient>
        </defs>

        <!-- Outer Track (Heap) -->
        <circle
          class="cybernetic-hardware-gauge__track cybernetic-hardware-gauge__track--outer"
          :cx="center"
          :cy="center"
          :r="outerRadius"
          fill="none"
          :stroke-width="strokeWidth"
        />
        <!-- Outer Active Arc -->
        <circle
          class="cybernetic-hardware-gauge__arc cybernetic-hardware-gauge__arc--outer"
          :cx="center"
          :cy="center"
          :r="outerRadius"
          fill="none"
          :stroke="`url(#${heapGradId})`"
          :stroke-width="strokeWidth"
          stroke-linecap="round"
          :stroke-dasharray="outerCircumference"
          :stroke-dashoffset="outerDashOffset"
          :filter="`url(#${gaugeFilterId})`"
          :transform="`rotate(-90 ${center} ${center})`"
        />

        <!-- Inner Track (RSS) -->
        <circle
          class="cybernetic-hardware-gauge__track cybernetic-hardware-gauge__track--inner"
          :cx="center"
          :cy="center"
          :r="innerRadius"
          fill="none"
          :stroke-width="innerStrokeWidth"
        />
        <!-- Inner Active Arc -->
        <circle
          class="cybernetic-hardware-gauge__arc cybernetic-hardware-gauge__arc--inner"
          :cx="center"
          :cy="center"
          :r="innerRadius"
          fill="none"
          :stroke="`url(#${rssGradId})`"
          :stroke-width="innerStrokeWidth"
          stroke-linecap="round"
          :stroke-dasharray="innerCircumference"
          :stroke-dashoffset="innerDashOffset"
          :filter="`url(#${gaugeFilterId})`"
          :transform="`rotate(-90 ${center} ${center})`"
        />
      </svg>

      <!-- Central percentage readout with cyan drop-shadow -->
      <div class="cybernetic-hardware-gauge__center">
        <span class="cybernetic-hardware-gauge__readout">
          {{ Math.round(heapPercent) }}%
        </span>
        <span class="cybernetic-hardware-gauge__caption">Heap Used</span>
        <span class="cybernetic-hardware-gauge__rss-badge">
          <i class="cybernetic-hardware-gauge__rss-dot" />
          {{ Math.round(rssPercent) }}% RSS
        </span>
      </div>
    </div>

    <!-- Label -->
    <div v-if="label" class="cybernetic-hardware-gauge__label">{{ label }}</div>

    <!-- Telemetry Legend -->
    <div class="cybernetic-hardware-gauge__legend">
      <div class="cybernetic-hardware-gauge__legend-item">
        <span class="cybernetic-hardware-gauge__swatch cybernetic-hardware-gauge__swatch--heap" />
        <span>Heap: {{ Math.round(heapPercent) }}%</span>
      </div>
      <div class="cybernetic-hardware-gauge__legend-item">
        <span class="cybernetic-hardware-gauge__swatch cybernetic-hardware-gauge__swatch--rss" />
        <span>RSS: {{ Math.round(rssPercent) }}%</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.cybernetic-hardware-gauge {
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

    &--inner {
      stroke: rgba(var(--v-theme-on-surface), 0.05);
    }
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
    gap: 2px;
  }

  &__readout {
    font-size: 1.85rem;
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1;
    color: rgb(var(--v-theme-on-surface));
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 12px rgba(6, 182, 212, 0.65), 0 0 24px rgba(6, 182, 212, 0.3);
    filter: drop-shadow(0 0 8px rgba(6, 182, 212, 0.5));
  }

  &__caption {
    font-size: 0.64rem;
    font-weight: 650;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: rgba(var(--v-theme-on-surface), 0.65);
    line-height: 1.2;
  }

  &__rss-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: #10b981;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.25);
    border-radius: 999px;
    padding: 1px 6px;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }

  &__rss-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 4px rgba(16, 185, 129, 0.7);
    display: inline-block;
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

  &__legend {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 6px;
  }

  &__legend-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.68rem;
    font-weight: 500;
    color: rgba(var(--v-theme-on-surface), 0.7);
  }

  &__swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;

    &--heap {
      background: linear-gradient(135deg, #06b6d4, #8b5cf6);
      box-shadow: 0 0 4px rgba(6, 182, 212, 0.5);
    }

    &--rss {
      background: linear-gradient(135deg, #10b981, #06b6d4);
      box-shadow: 0 0 4px rgba(16, 185, 129, 0.5);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .cybernetic-hardware-gauge__arc {
    transition: none !important;
    animation: none !important;
  }
}
</style>
