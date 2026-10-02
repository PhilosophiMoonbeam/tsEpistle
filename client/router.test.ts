import { afterEach, describe, expect, it, vi } from '../server/test/bun-test.mts'
import type * as RouterModule from './router.ts'

type RouteToken = object
type BeforeEachHandler = (to: RouteToken) => void
type AfterEachHandler = (to: RouteToken, from?: RouteToken, failure?: unknown) => void
type ErrorHandler = (error: unknown, to: RouteToken, from?: RouteToken) => void

const beforeEachHandlers: BeforeEachHandler[] = []
const afterEachHandlers: AfterEachHandler[] = []
const errorHandlers: ErrorHandler[] = []

const router = {
  beforeEach: vi.fn((handler: BeforeEachHandler) => {
    beforeEachHandlers.push(handler)
  }),
  afterEach: vi.fn((handler: AfterEachHandler) => {
    afterEachHandlers.push(handler)
  }),
  onError: vi.fn((handler: ErrorHandler) => {
    errorHandlers.push(handler)
  })
}

describe('profile route loading ownership', () => {
  afterEach(() => {
    beforeEachHandlers.length = 0
    afterEachHandlers.length = 0
    errorHandlers.length = 0
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('retains loading while an overlapping profile navigation still owns the key', async () => {
    vi.stubGlobal('window', {
      location: { pathname: '/p', reload: vi.fn() },
      confirm: vi.fn(() => false),
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

    const firstNavigation = {}
    const secondNavigation = {}

    beforeEachHandlers[0]!(firstNavigation)
    beforeEachHandlers[0]!(secondNavigation)
    afterEachHandlers[0]!(firstNavigation)

    expect(wikiStore.loadingCounts.profile).toBe(1)

    errorHandlers[0]!(new Error('late route error'), firstNavigation)
    expect(wikiStore.loadingCounts.profile).toBe(1)
    // The reload question goes through the shared confirm service (native fallback without a host).
    await Promise.resolve()
    const stubbedWindow = globalThis.window as unknown as { confirm: ReturnType<typeof vi.fn>; location: { reload: ReturnType<typeof vi.fn> } }
    expect(stubbedWindow.confirm).toHaveBeenCalledWith('This section could not be loaded.\n\nReload the page to try again.')
    expect(stubbedWindow.location.reload).not.toHaveBeenCalled()
    // The reload question is the only surface; no toast repeats it.
    expect(wikiStore.notification.isActive).toBe(false)

    afterEachHandlers[0]!(secondNavigation)
    expect(wikiStore.loadingCounts.profile).toBeUndefined()
  })

  it('asks the reload question in the reader language', async () => {
    vi.stubGlobal('window', {
      location: { pathname: '/a', reload: vi.fn() },
      confirm: vi.fn(() => true),
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
    const { default: i18next } = await import('i18next')
    await i18next.init({
      lng: 'de',
      resources: {
        de: {
          common: {
            routeLoad: { title: 'Dieser Bereich wurde nicht geladen.', message: 'Laden Sie die Seite neu.', reload: 'Neu laden', notNow: 'Nicht jetzt' }
          }
        }
      }
    })
    await vi.importFresh<typeof RouterModule>('./router.ts', import.meta.url)
    errorHandlers[0]!(new Error('chunk failed'), {})
    await Promise.resolve()
    await Promise.resolve()
    const stubbedWindow = globalThis.window as unknown as { confirm: ReturnType<typeof vi.fn>; location: { reload: ReturnType<typeof vi.fn> } }
    expect(stubbedWindow.confirm).toHaveBeenCalledWith('Dieser Bereich wurde nicht geladen.\n\nLaden Sie die Seite neu.')
    expect(stubbedWindow.location.reload).toHaveBeenCalledOnce()
  })
})
