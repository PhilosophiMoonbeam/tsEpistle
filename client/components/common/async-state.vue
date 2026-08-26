<template>
  <div
    class="async-state"
    :class="`async-state--${state}`"
    :role="state === 'error' ? 'alert' : 'status'"
    :aria-live="state === 'error' ? 'assertive' : 'polite'"
    :aria-busy="state === 'loading'"
  >
    <v-progress-circular
      v-if="state === 'loading'"
      class="async-state__icon"
      color="primary"
      indeterminate
      :size="32"
      :width="3"
      aria-label="Loading"
    />
    <v-icon v-else class="async-state__icon" :color="state === 'error' ? 'red' : 'grey'">
      {{ state === 'error' ? 'mdi-alert-circle-outline' : 'mdi-inbox-outline' }}
    </v-icon>
    <div class="async-state__copy">
      <div class="text-body-medium font-weight-medium">{{ title }}</div>
      <div v-if="message" class="text-body-small text-medium-emphasis">{{ message }}</div>
    </div>
    <v-btn
      v-if="state === 'error' && retryLabel"
      class="async-state__retry"
      color="primary"
      size="small"
      variant="text"
      @click="$emit('retry')"
    >
      {{ retryLabel }}
    </v-btn>
  </div>
</template>

<script setup lang="ts">
export type AsyncStateKind = 'loading' | 'empty' | 'error'

defineProps<{
  state: AsyncStateKind
  title: string
  message?: string
  retryLabel?: string
}>()

defineEmits<{
  retry: []
}>()
</script>

<style scoped>
.async-state {
  display: flex;
  min-height: 7rem;
  align-items: center;
  justify-content: center;
  gap: .85rem;
  padding: 1.25rem;
  border: 1px dashed rgba(var(--v-border-color), .18);
  border-radius: .875rem;
  background: color-mix(in srgb, rgb(var(--v-theme-surface)) 84%, transparent);
  text-align: start;
}

.async-state--error {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 6%, rgb(var(--v-theme-surface)));
}

.async-state__icon {
  flex: 0 0 auto;
}

.async-state__copy {
  min-width: 0;
}

.async-state__retry {
  flex: 0 0 auto;
}

@media (max-width: 599.98px) {
  .async-state {
    flex-direction: column;
    text-align: center;
  }
}

@media (forced-colors: active) {
  .async-state {
    border: 1px solid CanvasText;
  }
}
</style>
