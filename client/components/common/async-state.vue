<template>
  <div
    class="async-state"
    :class="`async-state--${state}`"
    :role="announce !== false ? (state === 'error' ? 'alert' : 'status') : undefined"
    :aria-live="announce !== false ? (state === 'error' ? 'assertive' : 'polite') : undefined"
    :aria-atomic="announce !== false ? 'true' : undefined"
    :aria-busy="state === 'loading' ? 'true' : undefined"
  >
    <v-progress-circular
      v-if="state === 'loading'"
      class="async-state__icon"
      color="primary"
      indeterminate
      :size="32"
      :width="3"
      aria-hidden="true"
    />
    <v-icon v-else class="async-state__icon" :color="state === 'error' ? 'error' : undefined" aria-hidden="true">
      {{ state === 'error' ? 'mdi-alert-circle-outline' : 'mdi-inbox-outline' }}
    </v-icon>
    <div class="async-state__copy">
      <div class="async-state__title">{{ title }}</div>
      <div v-if="message" class="async-state__message">{{ message }}</div>
    </div>
    <v-btn
      v-if="state === 'error' && retryLabel"
      class="async-state__retry"
      color="primary"
      variant="outlined"
      @click="$emit('retry')"
    >
      {{ retryLabel }}
    </v-btn>
    <div v-if="$slots.actions" class="async-state__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
export type AsyncStateKind = 'loading' | 'empty' | 'error'

const {
  state,
  title,
  message,
  retryLabel,
  announce = true
} = defineProps<{
  state: AsyncStateKind
  title: string
  message?: string
  retryLabel?: string
  announce?: boolean
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
  gap: var(--wiki-space-4);
  padding: var(--wiki-space-5);
  border: 1px solid var(--wiki-surface-border);
  border-radius: var(--wiki-panel-radius);
  background: var(--wiki-surface-sunken);
  color: rgb(var(--v-theme-on-surface));
  text-align: start;
}

.async-state--error {
  border-inline-start: .1875rem solid var(--wiki-purpose-error-edge);
  background: var(--wiki-purpose-error-fill);
  color: var(--wiki-purpose-error-ink);
}

.async-state__icon {
  flex: 0 0 auto;
}

.async-state__copy {
  min-width: 0;
  flex: 1 1 auto;
  overflow-wrap: anywhere;
}

.async-state__title {
  font-size: var(--wiki-type-body-sm);
  font-weight: 650;
  line-height: 1.4;
}

.async-state__message {
  margin-block-start: var(--wiki-space-1);
  color: var(--wiki-text-muted);
  font-size: var(--wiki-type-label);
  line-height: 1.5;
}

.async-state--error .async-state__message {
  color: inherit;
}

.async-state__retry,
.async-state__actions {
  flex: 0 0 auto;
}

@media (max-width: 599.98px) {
  .async-state {
    flex-wrap: wrap;
    align-items: flex-start;
    padding: var(--wiki-space-4);
  }

  .async-state__copy {
    flex-basis: calc(100% - 3rem);
  }

  .async-state__retry,
  .async-state__actions {
    width: 100%;
    min-height: 2.75rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .async-state__icon :deep(svg),
  .async-state__icon :deep(.v-progress-circular__overlay) {
    animation: none !important;
    transition: none !important;
  }
}

@media (forced-colors: active) {
  .async-state {
    border: 1px solid CanvasText;
  }
}
</style>
