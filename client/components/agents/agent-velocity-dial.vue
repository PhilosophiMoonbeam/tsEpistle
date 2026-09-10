<template>
  <div class="velocity-dial" :class="{ 'velocity-dial--active': active }">
    <header class="velocity-dial__header">
      <div class="velocity-dial__label-group">
        <span class="velocity-dial__beacon" :class="{ 'velocity-dial__beacon--pulsing': active }" aria-hidden="true" />
        <span class="velocity-dial__title">{{ label }}</span>
      </div>
      <span class="velocity-dial__status-badge" :class="active ? 'velocity-dial__status-badge--active' : 'velocity-dial__status-badge--idle'">
        {{ active ? 'STREAMING' : 'SETTLED' }}
      </span>
    </header>

    <div class="velocity-dial__meters">
      <!-- Token Velocity Gauge -->
      <div class="velocity-dial__card">
        <div class="velocity-dial__radial-box">
          <svg class="velocity-dial__svg" viewBox="0 0 100 100" aria-hidden="true">
            <circle
              class="velocity-dial__track"
              cx="50"
              cy="50"
              r="40"
            />
            <circle
              class="velocity-dial__indicator velocity-dial__indicator--tokens"
              cx="50"
              cy="50"
              r="40"
              :stroke-dasharray="circumference"
              :stroke-dashoffset="tokenDashOffset"
            />
          </svg>
          <div class="velocity-dial__center-data">
            <span class="velocity-dial__rate-number">{{ tokenRate }}</span>
            <span class="velocity-dial__rate-unit">tok/s</span>
          </div>
        </div>
        <div class="velocity-dial__meta">
          <span class="velocity-dial__meta-label">Tokens</span>
          <span class="velocity-dial__meta-value">
            {{ formatNumber(tokens) }}<small v-if="maxTokens > 0"> / {{ formatNumber(maxTokens) }}</small>
          </span>
        </div>
      </div>

      <!-- Tool Call Velocity Gauge -->
      <div class="velocity-dial__card">
        <div class="velocity-dial__radial-box">
          <svg class="velocity-dial__svg" viewBox="0 0 100 100" aria-hidden="true">
            <circle
              class="velocity-dial__track"
              cx="50"
              cy="50"
              r="40"
            />
            <circle
              class="velocity-dial__indicator velocity-dial__indicator--tools"
              cx="50"
              cy="50"
              r="40"
              :stroke-dasharray="circumference"
              :stroke-dashoffset="toolDashOffset"
            />
          </svg>
          <div class="velocity-dial__center-data">
            <span class="velocity-dial__rate-number">{{ toolRate }}</span>
            <span class="velocity-dial__rate-unit">ops/m</span>
          </div>
        </div>
        <div class="velocity-dial__meta">
          <span class="velocity-dial__meta-label">Tool Calls</span>
          <span class="velocity-dial__meta-value">
            {{ formatNumber(toolCalls) }}<small v-if="maxToolCalls > 0"> / {{ formatNumber(maxToolCalls) }}</small>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onWatcherCleanup, ref, watchEffect } from 'vue'

const {
  tokens = 0,
  maxTokens = 0,
  toolCalls = 0,
  maxToolCalls = 0,
  active = false,
  label = 'Execution Velocity'
} = defineProps<{
  tokens?: number
  maxTokens?: number
  toolCalls?: number
  maxToolCalls?: number
  active?: boolean
  label?: string
}>()

const tokenRate = ref(0)
const toolRate = ref(0)

const circumference = 2 * Math.PI * 40 // ~251.327

const tokenPercent = computed(() => {
  if (maxTokens > 0) return Math.min(100, Math.max(0, (tokens / maxTokens) * 100))
  return Math.min(100, Math.max(0, (tokenRate.value / 120) * 100))
})

const toolPercent = computed(() => {
  if (maxToolCalls > 0) return Math.min(100, Math.max(0, (toolCalls / maxToolCalls) * 100))
  return Math.min(100, Math.max(0, (toolRate.value / 20) * 100))
})

const tokenDashOffset = computed(() => circumference - (tokenPercent.value / 100) * circumference)
const toolDashOffset = computed(() => circumference - (toolPercent.value / 100) * circumference)

const formatNumber = (val: number): string => val.toLocaleString()

watchEffect(() => {
  if (!active) {
    tokenRate.value = 0
    toolRate.value = 0
    return
  }

  let prevTokens = tokens
  let prevTools = toolCalls
  let lastTime = performance.now()

  const interval = (typeof window !== 'undefined' ? window : globalThis).setInterval(() => {
    const now = performance.now()
    const elapsedSec = (now - lastTime) / 1000
    if (elapsedSec >= 0.5) {
      const deltaTokens = Math.max(0, tokens - prevTokens)
      const deltaTools = Math.max(0, toolCalls - prevTools)
      tokenRate.value = Math.round(deltaTokens / elapsedSec)
      toolRate.value = Math.round((deltaTools / elapsedSec) * 60)
      prevTokens = tokens
      prevTools = toolCalls
      lastTime = now
    }
  }, 1000)

  onWatcherCleanup(() => {
    (typeof window !== 'undefined' ? window : globalThis).clearInterval(interval)
  })
})
</script>

<style scoped lang="scss">
.velocity-dial {
  display: flex;
  flex-direction: column;
  gap: var(--wiki-space-3, 12px);
  padding: var(--wiki-space-3, 12px);
  background: color-mix(in srgb, rgb(var(--v-theme-surface, 30, 41, 59)) 85%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-primary, 6, 182, 212)) 20%, var(--wiki-surface-border, rgba(148, 163, 184, 0.2)));
  border-radius: var(--wiki-control-radius, 8px);
  box-shadow: var(--wiki-shadow-xs, 0 1px 2px rgba(0, 0, 0, 0.05)), inset 0 0 12px rgba(6, 182, 212, 0.04);
  transition: border-color 0.3s ease, box-shadow 0.3s ease;

  &--active {
    border-color: color-mix(in srgb, rgb(var(--v-theme-primary, 6, 182, 212)) 45%, var(--wiki-surface-border, rgba(148, 163, 184, 0.2)));
    box-shadow: 0 0 16px -4px rgba(6, 182, 212, 0.3), inset 0 0 14px rgba(6, 182, 212, 0.08);
  }

  &__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  &__label-group {
    display: flex;
    align-items: center;
    gap: var(--wiki-space-2, 8px);
  }

  &__beacon {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #64748b;
    transition: background 0.3s ease, box-shadow 0.3s ease;

    &--pulsing {
      background: #06b6d4;
      box-shadow: 0 0 10px #06b6d4, 0 0 18px rgba(6, 182, 212, 0.6);
      animation: beacon-pulse 1.4s infinite ease-in-out;
    }
  }

  &__title {
    font-size: var(--wiki-type-micro, 0.75rem);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface, 255, 255, 255)) 75%, transparent);
  }

  &__status-badge {
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 999px;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;

    &--active {
      color: #06b6d4;
      background: rgba(6, 182, 212, 0.15);
      border: 1px solid rgba(6, 182, 212, 0.4);
    }

    &--idle {
      color: #94a3b8;
      background: rgba(148, 163, 184, 0.1);
      border: 1px solid rgba(148, 163, 184, 0.2);
    }
  }

  &__meters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--wiki-space-3, 12px);
  }

  &__card {
    display: flex;
    align-items: center;
    gap: var(--wiki-space-3, 12px);
    padding: var(--wiki-space-2, 8px);
    background: var(--wiki-surface-sunken, rgba(0, 0, 0, 0.15));
    border-radius: var(--wiki-control-radius, 8px);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  &__radial-box {
    position: relative;
    width: 56px;
    height: 56px;
    flex: 0 0 56px;
  }

  &__svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }

  &__track {
    fill: none;
    stroke: rgba(148, 163, 184, 0.18);
    stroke-width: 8;
  }

  &__indicator {
    fill: none;
    stroke-width: 8;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.4s cubic-bezier(0.16, 1, 0.3, 1);

    &--tokens {
      stroke: #06b6d4;
      filter: drop-shadow(0 0 4px rgba(6, 182, 212, 0.7));
    }

    &--tools {
      stroke: #8b5cf6;
      filter: drop-shadow(0 0 4px rgba(139, 92, 246, 0.7));
    }
  }

  &__center-data {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  &__rate-number {
    font-size: 0.78rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--v-theme-on-surface, 255, 255, 255));
  }

  &__rate-unit {
    font-size: 0.55rem;
    font-weight: 600;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface, 255, 255, 255)) 60%, transparent);
    margin-top: 1px;
  }

  &__meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  &__meta-label {
    font-size: var(--wiki-type-micro, 0.75rem);
    font-weight: 650;
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface, 255, 255, 255)) 65%, transparent);
  }

  &__meta-value {
    font-size: 0.8rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--v-theme-on-surface, 255, 255, 255));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    small {
      font-size: 0.7rem;
      font-weight: 400;
      color: color-mix(in srgb, rgb(var(--v-theme-on-surface, 255, 255, 255)) 55%, transparent);
    }
  }
}

@keyframes beacon-pulse {
  0% {
    box-shadow: 0 0 4px #06b6d4, 0 0 8px rgba(6, 182, 212, 0.4);
    opacity: 0.8;
  }
  50% {
    box-shadow: 0 0 12px #06b6d4, 0 0 22px rgba(6, 182, 212, 0.8);
    opacity: 1;
  }
  100% {
    box-shadow: 0 0 4px #06b6d4, 0 0 8px rgba(6, 182, 212, 0.4);
    opacity: 0.8;
  }
}

@media (max-width: 520px) {
  .velocity-dial__meters {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .velocity-dial__beacon--pulsing {
    animation: none;
  }
  .velocity-dial__indicator {
    transition: none;
  }
}
</style>
