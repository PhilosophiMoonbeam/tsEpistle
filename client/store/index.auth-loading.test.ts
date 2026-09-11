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
    const fetch = vi.fn(
      async () =>
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

    await expect(store.refreshAuth()).resolves.toBe('anonymous')

    expect(fetch).toHaveBeenCalledWith('/_api/users/whoami', { credentials: 'same-origin', cache: 'no-store' })
    expect(store.user.authenticated).toBe(false)
    expect(store.user.permissions).toEqual([])
    expect(store.user.id).toBe(0)
  })

  it('classifies malformed whoami data as unavailable and retries on the next refresh', async () => {
    let attempt = 0
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        return new Response('{malformed', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'Alice' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    await expect(store.refreshAuth()).resolves.toBe('unavailable')
    expect(store.user.authenticated).toBe(false)
    expect(store.user.id).toBe(0)

    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(store.user.authenticated).toBe(true)
    expect(store.user.id).toBe(42)
    expect(store.user.name).toBe('Alice')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent auth refreshes and releases the shared flight after completion', async () => {
    let attempt = 0
    let releaseFirst!: (response: Response) => void
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        return await new Promise<Response>(resolve => {
          releaseFirst = resolve
        })
      }
      return new Response(JSON.stringify({ authenticated: false, user: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    const first = store.refreshAuth()
    const second = store.refreshAuth()
    expect(fetch).toHaveBeenCalledTimes(1)

    releaseFirst(
      new Response(JSON.stringify({ authenticated: true, user: { id: 7 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    await expect(first).resolves.toBe('authenticated')
    await expect(store.refreshAuth()).resolves.toBe('anonymous')
    expect(fetch).toHaveBeenCalledTimes(2)
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
