<template>
  <div
    class="laser-meter"
    :class="stateClass"
    role="progressbar"
    :aria-valuenow="Math.round(clamped)"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="label || undefined"
  >
    <div v-if="label" class="laser-meter__label-row">
      <span class="laser-meter__label">{{ label }}</span>
      <span class="laser-meter__value">{{ Math.round(clamped) }}%</span>
    </div>
    <div class="laser-meter__track">
      <div class="laser-meter__fill" :style="{ width: `${clamped}%` }">
        <span class="laser-meter__head" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const {
  percent = 0,
  label = '',
  warningThreshold = 80,
  criticalThreshold = 95
} = defineProps<{
  percent: number
  label?: string
  warningThreshold?: number
  criticalThreshold?: number
}>()

const clamped = computed(() => Math.min(100, Math.max(0, percent)))
const stateClass = computed(() => {
  if (clamped.value >= criticalThreshold) return 'laser-meter--critical'
  if (clamped.value >= warningThreshold) return 'laser-meter--warning'
  return 'laser-meter--nominal'
})
</script>

<style scoped lang="scss">
.laser-meter {
  position: relative;
  width: 100%;

  &__label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--wiki-type-micro, 0.75rem);
    margin-bottom: var(--wiki-space-1, 4px);
    font-variant-numeric: tabular-nums;
  }

  &__label {
    color: color-mix(in srgb, rgb(var(--v-theme-on-surface, 255, 255, 255)) 70%, transparent);
    font-weight: 600;
  }

  &__value {
    color: rgb(var(--v-theme-on-surface, 255, 255, 255));
    font-weight: 700;
  }

  &__track {
    height: 8px;
    background: rgba(var(--v-theme-surface-variant, 148, 163, 184), 0.25);
    border-radius: 999px;
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  &__fill {
    height: 100%;
    position: relative;
    border-radius: 999px;
    background: linear-gradient(90deg, #06b6d4 0%, #3b82f6 50%, #8b5cf6 100%);
    box-shadow: 0 0 10px rgba(6, 182, 212, 0.6);
    transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  &__head {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 14px;
    background: #ffffff;
    border-radius: 999px;
    box-shadow: 0 0 8px #ffffff, 0 0 16px #06b6d4;
    animation: pulse-head 1.2s infinite alternate ease-in-out;
  }

  &--warning &__fill {
    background: linear-gradient(90deg, #f59e0b 0%, #f97316 100%);
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.65);
  }

  &--warning &__head {
    box-shadow: 0 0 8px #ffffff, 0 0 16px #f59e0b;
  }

  &--critical &__fill {
    background: linear-gradient(90deg, #f43f5e 0%, #ef4444 100%);
    box-shadow: 0 0 14px rgba(244, 63, 94, 0.8);
  }

  &--critical &__head {
    box-shadow: 0 0 8px #ffffff, 0 0 16px #ef4444;
  }
}

@keyframes pulse-head {
  0% {
    opacity: 0.7;
    transform: scaleX(0.8);
  }
  100% {
    opacity: 1;
    transform: scaleX(1.3);
  }
}

@media (prefers-reduced-motion: reduce) {
  .laser-meter__fill {
    transition: none;
  }
  .laser-meter__head {
    animation: none;
  }
}
</style>
