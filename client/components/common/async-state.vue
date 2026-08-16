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
  min-height: 5rem;
  align-items: center;
  justify-content: center;
  gap: .75rem;
  padding: 1rem;
  text-align: left;
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

@media (max-width: 599px) {
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
