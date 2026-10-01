import { describe, expect, test, vi } from '../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from './test/browser-dom.mts'

const { defineAsyncComponent, h, nextTick } = await import('vue')

describe('client setup boot global compatibility', () => {
  test('publishes boot and mounts on DOM readiness without reading the mutable global', async () => {
    const descriptors = [
      [document, 'readyState', Object.getOwnPropertyDescriptor(document, 'readyState')],
      [browserWindow, 'boot', Object.getOwnPropertyDescriptor(browserWindow, 'boot')],
      [browserWindow, 'WIKI', Object.getOwnPropertyDescriptor(browserWindow, 'WIKI')]
    ]
    let publishedBoot
    const readBoot = vi.fn(() => {
      throw new Error('Setup startup must not read window.boot')
    })

    resetBody()
    document.body.innerHTML = '<div id="root"><setup></setup></div>'
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' })
    Object.defineProperty(browserWindow, 'boot', {
      configurable: true,
      get: readBoot,
      set(value) {
        publishedBoot = value
      }
    })

    // Control the SFC leaves only; boot, Vue mounting and the Vuetify plugin remain real.
    vi.mockModule('./components/common/async-component-state.vue', import.meta.url, () => ({
      createAsyncComponent: loader => defineAsyncComponent(loader)
    }))
    vi.mockModule('./components/setup.vue', import.meta.url, () => ({
      default: { render: () => h('h1', { id: 'setup-mounted' }, 'Setup mounted') }
    }))

    try {
      await vi.importFresh('./client-setup.ts', import.meta.url)
      const { default: boot } = await import('./modules/boot.ts')

      expect(publishedBoot).toBe(boot)
      expect(browserWindow.WIKI).toBeNull()
      expect(document.querySelector('#root').innerHTML).toBe('<setup></setup>')

      document.dispatchEvent(new browserWindow.Event('DOMContentLoaded'))
      await vi.waitFor(async () => {
        await nextTick()
        expect(document.querySelector('#root > #setup-mounted')?.textContent).toBe('Setup mounted')
      })
      expect(readBoot).not.toHaveBeenCalled()
    } finally {
      browserWindow.WIKI?.unmount()
      for (const [target, name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(target, name, descriptor)
        else Reflect.deleteProperty(target, name)
      }
      resetBody()
    }
  })
})
