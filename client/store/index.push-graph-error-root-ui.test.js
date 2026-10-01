import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'

const createStore = async () => {
  vi.stubGlobal('window', {
    siteConfig: {
      company: '',
      contentLicense: '',
      footerOverride: '',
      banner: {},
      darkMode: false,
      tocPosition: 'left',
      title: 'Test',
      logoUrl: '',
      product: { name: 'Test', version: '1.0.0' }
    }
  })
  vi.stubGlobal('WIKI', {
    get $store() {
      throw new Error('The legacy root store is unavailable')
    }
  })
  const { useWikiStore, pinia } = await vi.importFresh('./index.ts', import.meta.url)
  return useWikiStore(pinia)
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('store error notifications without the legacy root store', () => {
  it.each([
    ['an Error', new Error('Request offline'), 'Request offline'],
    ['a graph error before the outer message', { graphQLErrors: [{ message: 'Graph permission denied' }], message: 'Outer failure' }, 'Graph permission denied'],
    ['an object message', { message: 'Object failure' }, 'Object failure'],
    ['an invalid graph message with an object fallback', { graphQLErrors: [{ message: 42 }], message: 'Fallback failure' }, 'Fallback failure'],
    ['a numeric primitive', 503, '503']
  ])('publishes %s as an active error notification', async (_name, error, message) => {
    const store = await createStore()
    store.showNotification({ message: 'Previous success', style: 'success', icon: 'check', isActive: false })

    store.showError(error)

    expect(store.notification).toEqual({ message, style: 'red', icon: 'alert', isActive: true })
  })

  it('honors notification presentation and inactive-state overrides', async () => {
    const store = await createStore()
    store.showError(new Error('Previous failure'))

    store.showNotification({ message: 'Saved', style: 'success', icon: 'check', isActive: false })

    expect(store.notification).toEqual({ message: 'Saved', style: 'success', icon: 'check', isActive: false })
  })
})
