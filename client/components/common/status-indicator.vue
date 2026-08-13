<template>
  <span
    class="status-indicator"
    :class="[`is-${status}`, { 'is-pulsing': pulse }]"
    role="status"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  active?: boolean
  positive?: boolean
  intermediary?: boolean
  negative?: boolean
  pulse?: boolean
}>()

const status = computed(() => {
  if (props.negative) return 'negative'
  if (props.intermediary) return 'intermediary'
  if (props.positive) return 'positive'
  if (props.active) return 'active'
  return 'neutral'
})
</script>

<style scoped>
.status-indicator {
  --indicator-color: #d8e2e9;
  position: relative;
  display: inline-block;
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  border-radius: 50%;
  background: var(--indicator-color);
}

.is-active { --indicator-color: #0095ff; }
.is-positive { --indicator-color: #4bd28f; }
.is-intermediary { --indicator-color: #ffaa00; }
.is-negative { --indicator-color: #ff4d4d; }

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
</style>
