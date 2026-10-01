import { afterEach, describe, expect, test, vi } from '../../server/test/bun-test.mts'

import * as rootUiStore from './root-ui-store.ts'

describe('root UI store facade', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('setLoading activates the named load until it is released', async () => {
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
    const { useWikiStore, pinia } = await vi.importFresh('../store/index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    rootUiStore.setLoading(store, 'watcher', true)

    expect(store.isLoading).toBe(true)
    expect(store.loadingCounts.watcher).toBe(1)

    rootUiStore.setLoading(store, 'watcher', false)

    expect(store.isLoading).toBe(false)
    expect(store.loadingCounts.watcher).toBeUndefined()
  })
})
