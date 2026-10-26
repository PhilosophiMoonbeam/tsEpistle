<template>
  <section
    class="async-component-state"
    :class="{ 'async-component-state--error': error }"
    :role="error ? 'alert' : 'status'"
    :aria-busy="error ? undefined : 'true'"
    :aria-live="error ? 'assertive' : 'polite'"
    :aria-labelledby="titleId"
    :aria-describedby="messageId"
  >
    <span v-if="error" class="async-component-state__icon async-component-state__error-icon mdi mdi-cloud-alert-outline" aria-hidden="true" />
    <template v-else>
      <span class="async-component-state__icon async-component-state__spinner" aria-hidden="true" />
      <span class="async-component-state__icon async-component-state__still-icon mdi mdi-cloud-download-outline" aria-hidden="true" />
    </template>

    <div class="async-component-state__copy">
      <div :id="titleId" class="text-body-medium font-weight-medium">
        {{ error ? $t('common:asyncComponentState.sectionCouldNotLoaded') : $t('common:asyncComponentState.loadingSection') }}
      </div>
      <div :id="messageId" class="text-body-small text-medium-emphasis">
        {{ error ? $t('common:asyncComponentState.tryLoadingAgainReload') : $t('common:asyncComponentState.willReadyMoment') }}
      </div>
    </div>

    <div v-if="error" class="async-component-state__actions">
      <button type="button" class="async-component-state__retry" @click="$emit('retry')">
        {{ $t('common:asyncComponentState.tryAgain') }}
      </button>
      <button type="button" @click="reloadPage">
        {{ $t('common:asyncComponentState.reloadPage') }}
      </button>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent, useId } from 'vue'
import type { PropType } from 'vue'

const AsyncComponentState = defineComponent({
  name: 'AsyncComponentState',
  props: {
    error: {
      type: Error as PropType<Error | undefined>,
      default: undefined
    }
  },
  emits: {
    retry: () => true
  },
  setup() {
    const id = useId()

    return {
      messageId: `${id}-message`,
      reloadPage: () => window.location.reload(),
      titleId: `${id}-title`
    }
  }
})

export default AsyncComponentState
</script>

<style scoped>
.async-component-state {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  min-height: 7rem;
  align-items: center;
  justify-content: center;
  gap: .9rem;
  padding: 1.25rem;
  border: 1px dashed transparent;
  border-radius: var(--wiki-control-radius, .875rem);
  color: rgb(var(--v-theme-on-surface));
  text-align: start;
}

.async-component-state--floating,
.async-component-state--header {
  position: fixed;
  z-index: 1000;
  inset-inline: 1rem;
  width: auto;
  max-width: 40rem;
  min-height: 0;
  max-height: calc((100dvh - 3rem) / 2);
  margin-inline: auto;
  align-items: flex-start;
  overflow: auto;
  border-color: rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
}

.async-component-state--floating {
  inset-block-end: 1rem;
}

.async-component-state--header {
  inset-block-start: 1rem;
}

.async-component-state--error {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 6%, rgb(var(--v-theme-surface)));
}

.async-component-state__icon,
.async-component-state__actions {
  flex: 0 0 auto;
}

.async-component-state__icon {
  width: 2rem;
  height: 2rem;
  font-size: 2rem;
  line-height: 1;
  color: var(--wiki-primary-ink);
}

.async-component-state__error-icon {
  color: rgb(var(--v-theme-error));
}

.async-component-state__spinner {
  box-sizing: border-box;
  border: 3px solid transparent;
  border-block-start-color: currentColor;
  border-inline-end-color: currentColor;
  border-radius: 50%;
  animation: async-component-spin 800ms linear infinite;
}

@keyframes async-component-spin {
  to { transform: rotate(360deg); }
}

.async-component-state__still-icon {
  display: none;
}

.async-component-state__copy {
  min-width: 0;
  max-width: 30rem;
}

.async-component-state__actions {
  display: flex;
  align-items: center;
  gap: .25rem;
}

.async-component-state__actions button {
  min-height: var(--wiki-control-height, 2.75rem);
  padding: .5rem .875rem;
  border: 1px solid transparent;
  border-radius: var(--wiki-control-radius, .875rem);
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.async-component-state__actions button:hover {
  border-color: currentColor;
}

.async-component-state__actions button:focus-visible {
  outline: 2px solid var(--wiki-focus-color, currentColor);
  outline-offset: 2px;
}

.async-component-state__actions .async-component-state__retry {
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
}

@media (max-width: 599.98px) {
  .async-component-state {
    flex-direction: column;
    text-align: center;
  }

  .async-component-state__actions {
    flex-wrap: wrap;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .async-component-state__spinner {
    display: none;
    animation: none;
  }

  .async-component-state__still-icon {
    display: inline-flex;
  }
}

@media (forced-colors: active) {
  .async-component-state--error {
    border-color: CanvasText;
  }
}
</style>
