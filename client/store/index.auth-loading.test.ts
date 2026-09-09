import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type * as WikiStoreModule from './index.ts'

const installWindow = (fetch: unknown = vi.fn()): void => {
  vi.stubGlobal('window', {
    fetch,
    location: { protocol: 'https:', pathname: '/' },
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
}

describe('root authentication and loading ownership', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('hydrates an anonymous session from an uncached cookie-backed whoami response', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: false, user: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.permissions = ['manage:system']

    await store.refreshAuth()

    expect(fetch).toHaveBeenCalledWith('/_api/users/whoami', { credentials: 'same-origin', cache: 'no-store' })
    expect(store.user.authenticated).toBe(false)
    expect(store.user.permissions).toEqual([])
    expect(store.user.id).toBe(0)
  })

  it('keeps a same-key load active until every owner releases it', async () => {
    installWindow()
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    store.startLoading('profile')
    store.startLoading('profile')
    store.stopLoading('profile')

    expect(store.isLoading).toBe(true)
    expect(store.loadingCounts.profile).toBe(1)

    store.stopLoading('profile')
    expect(store.isLoading).toBe(false)
    expect(store.loadingCounts.profile).toBeUndefined()
  })
})

