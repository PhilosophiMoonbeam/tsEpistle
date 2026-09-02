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
        {{ error ? 'This section could not be loaded' : 'Loading this section' }}
      </div>
      <div :id="messageId" class="text-body-small text-medium-emphasis">
        {{ error ? 'Try loading it again, or reload the page if the problem continues.' : 'It will be ready in a moment.' }}
      </div>
    </div>

    <div v-if="error" class="async-component-state__actions">
      <v-btn ref="retryButton" color="primary" size="small" variant="flat" @click="$emit('retry')">
        Try again
      </v-btn>
      <v-btn size="small" variant="text" @click="reloadPage">
        Reload page
      </v-btn>
    </div>
  </section>
</template>

<script lang="ts">
import {
  defineAsyncComponent,
  defineComponent,
  h,
  nextTick,
  shallowRef,
  useId,
  watch
} from 'vue'
import type { AsyncComponentLoader, ComponentPublicInstance, PropType } from 'vue'

const ASYNC_COMPONENT_DELAY_MS = 250
const ASYNC_COMPONENT_TIMEOUT_MS = 20_000

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
  setup(props) {
    const id = useId()
    const retryButton = shallowRef<ComponentPublicInstance | null>(null)

    watch(
      () => props.error,
      async error => {
        if (!error) return
        await nextTick()
        const button = retryButton.value?.$el
        if (button instanceof HTMLElement) button.focus()
      },
      { flush: 'post', immediate: true }
    )

    return {
      messageId: `${id}-message`,
      reloadPage: () => window.location.reload(),
      retryButton,
      titleId: `${id}-title`
    }
  }
})

export function createAsyncComponent(loader: AsyncComponentLoader) {
  const loadError = shallowRef<Error>()
  let retryLoad: (() => void) | undefined

  const LoadingAndErrorState = defineComponent({
    name: 'AsyncComponentLoadState',
    setup() {
      const retry = () => {
        const pendingRetry = retryLoad
        if (!pendingRetry) return
        retryLoad = undefined
        loadError.value = undefined
        pendingRetry()
      }

      return () => h(AsyncComponentState, {
        error: loadError.value,
        onRetry: retry
      })
    }
  })

  const boundedLoader: AsyncComponentLoader = () => new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`Async component timed out after ${ASYNC_COMPONENT_TIMEOUT_MS}ms.`))
    }, ASYNC_COMPONENT_TIMEOUT_MS)

    loader().then(
      component => {
        window.clearTimeout(timeout)
        resolve(component)
      },
      error => {
        window.clearTimeout(timeout)
        reject(error)
      }
    )
  })

  return defineAsyncComponent({
    loader: boundedLoader,
    loadingComponent: LoadingAndErrorState,
    delay: ASYNC_COMPONENT_DELAY_MS,
    suspensible: false,
    onError(error, retry) {
      loadError.value = error
      retryLoad = retry
    }
  })
}

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
