<template>
  <kbd
    :id="id"
    class="nav-search-hotkey"
    :class="{ 'nav-search-hotkey--active': active }"
    role="button"
    tabindex="0"
    :aria-label="ariaLabel || defaultAriaLabel"
    aria-keyshortcuts="Control+k Meta+k"
    @click="handleClick"
    @keydown.enter.prevent="handleKeydown"
    @keydown.space.prevent="handleKeydown"
  >
    <slot>{{ displayShortcut }}</slot>
  </kbd>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'

const {
  label,
  ariaLabel,
  active = false
} = defineProps<{
  label?: string
  ariaLabel?: string
  active?: boolean
}>()

const emit = defineEmits<{
  (e: 'trigger'): void
}>()

const id = useId()

const isMac = ref(
  typeof navigator !== 'undefined'
    ? /Mac|iPhone|iPad|iPod/i.test(
        (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
        navigator.platform ||
        navigator.userAgent ||
        ''
      )
    : false
)

onMounted(() => {
  if (typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
    isMac.value = /Mac|iPhone|iPad|iPod/i.test(platform)
  }
})

const displayShortcut = computed(() => {
  if (label && label.trim().length > 0) return label
  return isMac.value ? '⌘K' : 'Ctrl+K'
})

const defaultAriaLabel = computed(() => `Search shortcut (${displayShortcut.value})`)

function handleClick(event: MouseEvent): void {
  event.stopPropagation()
  emit('trigger')
}

function handleKeydown(event: KeyboardEvent): void {
  event.stopPropagation()
  emit('trigger')
}
</script>

<style lang="scss" scoped>
.nav-search-hotkey {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding: 0.125rem 0.375rem;
  border-radius: 0.375rem;
  background: rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(6, 182, 212, 0.3);
  box-shadow: 0 0 8px rgba(6, 182, 212, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.15);
  color: rgb(var(--v-theme-on-surface-variant, 226, 232, 240));
  font-family: inherit;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.025em;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  outline: none;
  transition:
    transform 0.15s cubic-bezier(0.16, 1, 0.3, 1),
    border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

  &:hover {
    border-color: rgba(6, 182, 212, 0.6);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(6, 182, 212, 0.3);
    color: rgb(var(--v-theme-on-surface, 255, 255, 255));
  }

  &:focus-visible {
    border-color: rgba(6, 182, 212, 0.8);
    box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.4), 0 0 12px rgba(6, 182, 212, 0.3);
  }

  &:active,
  &--active {
    transform: translateY(1px) scale(0.95);
    box-shadow: 0 0 4px rgba(6, 182, 212, 0.4);
    border-color: rgba(6, 182, 212, 0.6);
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-search-hotkey {
    transition: none !important;
    transform: none !important;

    &:hover,
    &:active,
    &--active {
      transform: none !important;
    }
  }
}
</style>
