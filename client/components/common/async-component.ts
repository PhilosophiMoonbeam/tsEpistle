import { defineAsyncComponent, defineComponent, h, shallowRef } from 'vue'
import type { AsyncComponentLoader } from 'vue'
import AsyncComponentState from './async-component-state.vue'

const ASYNC_COMPONENT_DELAY_MS = 250
const ASYNC_COMPONENT_TIMEOUT_MS = 20_000

// Import the compiled default component; a named factory inside its SFC can
// retain the setup object while production tree shaking drops its render hook.
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

  // The browser contract targets ES2022, before Promise.withResolvers.
  const boundedLoader: AsyncComponentLoader = () => new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`Async component timed out after ${ASYNC_COMPONENT_TIMEOUT_MS}ms.`))
    }, ASYNC_COMPONENT_TIMEOUT_MS)

    try {
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
    } catch (error) {
      window.clearTimeout(timeout)
      reject(error)
    }
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
