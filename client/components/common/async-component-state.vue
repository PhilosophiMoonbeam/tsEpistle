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
    <v-icon v-if="error" class="async-component-state__icon" color="error" size="32" aria-hidden="true">
      mdi-cloud-alert-outline
    </v-icon>
    <template v-else>
      <v-progress-circular
        class="async-component-state__icon async-component-state__spinner"
        color="primary"
        indeterminate
        :size="32"
        :width="3"
        aria-hidden="true"
      />
      <v-icon class="async-component-state__icon async-component-state__still-icon" color="primary" size="32" aria-hidden="true">
        mdi-cloud-download-outline
      </v-icon>
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
      <v-btn color="primary" size="small" variant="flat" @click="$emit('retry')">
        {{ $t('common:asyncComponentState.tryAgain') }}
      </v-btn>
      <v-btn size="small" variant="text" @click="reloadPage">
        {{ $t('common:asyncComponentState.reloadPage') }}
      </v-btn>
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

.async-component-state--error {
  border-color: color-mix(in srgb, rgb(var(--v-theme-error)) 28%, transparent);
  background: color-mix(in srgb, rgb(var(--v-theme-error)) 6%, rgb(var(--v-theme-surface)));
}

.async-component-state__icon,
.async-component-state__actions {
  flex: 0 0 auto;
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
