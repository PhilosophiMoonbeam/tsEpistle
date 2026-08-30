import { afterEach, describe, expect, it, vi } from '../server/test/bun-test.mts'
import type * as RouterModule from './router.ts'

const beforeEachHandlers: Array<() => void> = []
const afterEachHandlers: Array<() => void> = []

const router = {
  beforeEach: vi.fn((handler: () => void) => {
    beforeEachHandlers.push(handler)
  }),
  afterEach: vi.fn((handler: () => void) => {
    afterEachHandlers.push(handler)
  })
}

describe('profile route loading ownership', () => {
  afterEach(() => {
    beforeEachHandlers.length = 0
    afterEachHandlers.length = 0
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('retains loading while an overlapping profile navigation still owns the key', async () => {
    vi.stubGlobal('window', {
      location: { pathname: '/p' },
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
    vi.mockModule('vue-router', import.meta.url, () => ({
      createWebHistory: vi.fn(() => ({})),
      createRouter: vi.fn(() => router)
    }))
    // These runtime imports install the window boundary first and keep the assertion on the store instance owned by the router.
    await vi.importFresh<typeof RouterModule>('./router.ts', import.meta.url)
    const { wikiStore } = await import('./store/index.ts')

    beforeEachHandlers[0]!()
    beforeEachHandlers[0]!()
    afterEachHandlers[0]!()

    expect(wikiStore.loadingCounts.profile).toBe(1)

    afterEachHandlers[0]!()
    expect(wikiStore.loadingCounts.profile).toBeUndefined()
  })
})
