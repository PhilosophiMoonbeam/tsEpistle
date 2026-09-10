<script setup lang="ts">
import { computed } from 'vue'

const {
  state = 'applied',
  size = 10,
  ping = true
} = defineProps<{
  state?: string
  size?: number
  ping?: boolean
}>()

const beaconTone = computed(() => {
  switch (state) {
    case 'applied':
    case 'success':
    case 'saved':
      return { color: '#10b981', glow: 'rgba(16, 185, 129, 0.65)' }
    case 'pending':
    case 'draft':
    case 'warning':
    case 'needs-attention':
      return { color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.65)' }
    case 'error':
    case 'failed':
      return { color: '#ef4444', glow: 'rgba(239, 68, 68, 0.65)' }
    default:
      return { color: '#06b6d4', glow: 'rgba(6, 182, 212, 0.65)' }
  }
})
</script>

<template>
  <span
    class="radar-beacon"
    :style="{
      '--beacon-size': `${size}px`,
      '--beacon-color': beaconTone.color,
      '--beacon-glow': beaconTone.glow
    }"
    :aria-label="`Status: ${state}`"
    role="status"
  >
    <span v-if="ping" class="radar-beacon__ring radar-beacon__ring--1" />
    <span v-if="ping" class="radar-beacon__ring radar-beacon__ring--2" />
    <span class="radar-beacon__core" />
  </span>
</template>

<style scoped lang="scss">
.radar-beacon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--beacon-size, 10px);
  height: var(--beacon-size, 10px);
  vertical-align: middle;
  flex-shrink: 0;

  &__core {
    width: var(--beacon-size, 10px);
    height: var(--beacon-size, 10px);
    border-radius: 50%;
    background-color: var(--beacon-color, #10b981);
    box-shadow: 0 0 8px var(--beacon-glow, rgba(16, 185, 129, 0.65));
    position: relative;
    z-index: 2;
    transition: background-color 0.3s ease, box-shadow 0.3s ease;
  }

  &__ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.5px solid var(--beacon-color, #10b981);
    opacity: 0;
    pointer-events: none;
    z-index: 1;
    animation: radar-ping 2.2s cubic-bezier(0, 0.2, 0.8, 1) infinite;

    &--2 {
      animation-delay: 1.1s;
    }
  }
}

@keyframes radar-ping {
  0% {
    transform: scale(0.8);
    opacity: 0.9;
  }
  100% {
    transform: scale(2.4);
    opacity: 0;
  }
}
</style>
