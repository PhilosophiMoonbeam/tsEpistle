<template>
  <span
    class="status-indicator"
    :class="[`is-${status}`, { 'is-pulsing': pulse }]"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <span class="status-indicator__label">{{ statusLabel }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type Status = 'neutral' | 'active' | 'positive' | 'intermediary' | 'negative'

const props = defineProps<{
  active?: boolean
  positive?: boolean
  intermediary?: boolean
  negative?: boolean
  pulse?: boolean
  label?: string
}>()

const status = computed<Status>(() => {
  if (props.negative) return 'negative'
  if (props.intermediary) return 'intermediary'
  if (props.positive) return 'positive'
  if (props.active) return 'active'
  return 'neutral'
})

const defaultStatusLabels: Record<Status, string> = {
  neutral: 'Status unavailable',
  active: 'Active',
  positive: 'Positive',
  intermediary: 'Pending',
  negative: 'Error'
}

const statusLabel = computed(() => props.label || defaultStatusLabels[status.value])
</script>

<style scoped>

.status-indicator {
  --indicator-color: rgb(var(--v-theme-on-surface-variant));
  position: relative;
  display: inline-block;
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  border-radius: 50%;
  background: var(--indicator-color);
}

.status-indicator__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.is-active { --indicator-color: rgb(var(--v-theme-primary)); }
.is-positive { --indicator-color: rgb(var(--v-theme-success)); }
.is-intermediary { --indicator-color: rgb(var(--v-theme-warning)); }
.is-negative { --indicator-color: rgb(var(--v-theme-error)); }

.is-pulsing::before {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: inherit;
  content: '';
  animation: status-indicator-pulse 2s ease-out infinite;
}

@keyframes status-indicator-pulse {
  from { opacity: .65; transform: scale(1); }
  to { opacity: 0; transform: scale(2.4); }
}

@media (prefers-reduced-motion: reduce) {
  .is-pulsing::before { animation: none; }
}

@media (forced-colors: active) {
  .status-indicator {
    border: 1px solid currentColor;
    background: currentColor;
  }
}
</style>
