import { afterEach, describe, expect, it, vi } from '../server/test/bun-test.mts'
import type * as RouterModule from './router.ts'

const beforeEachHandlers: Array<() => void> = []
const afterEachHandlers: Array<() => void> = []
const loadingCounts: Record<string, number> = {}
const wikiStore = {
  startLoading: vi.fn((name: string) => {
    loadingCounts[name] = (loadingCounts[name] ?? 0) + 1
  }),
  stopLoading: vi.fn((name: string) => {
    const count = loadingCounts[name]
    if (count === 1) delete loadingCounts[name]
    else if (count !== undefined) loadingCounts[name] = count - 1
  })
}

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
    for (const key of Object.keys(loadingCounts)) delete loadingCounts[key]
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('retains loading while an overlapping profile navigation still owns the key', async () => {
    vi.stubGlobal('window', { location: { pathname: '/p' } })
    vi.mockModule('vue-router', import.meta.url, () => ({
      createWebHistory: vi.fn(() => ({})),
      createRouter: vi.fn(() => router)
    }))
    const routerUrl = new URL('./router.ts', import.meta.url).href
    vi.mockModule('./store/index.ts', routerUrl, () => ({ wikiStore }))
    // The router reads window.location and installs hooks at module initialization, so the test imports it after installing those boundaries.
    await vi.importFresh<typeof RouterModule>('./router.ts', import.meta.url)

    beforeEachHandlers[0]!()
    beforeEachHandlers[0]!()
    afterEachHandlers[0]!()

    expect(loadingCounts.profile).toBe(1)

    afterEachHandlers[0]!()
    expect(loadingCounts.profile).toBeUndefined()
  })
})
