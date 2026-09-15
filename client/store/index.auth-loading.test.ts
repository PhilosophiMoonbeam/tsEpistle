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

  it('preserves the warm identity epoch and actor during a transient whoami outage', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('network unavailable')
    })
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.offlineIdentityReady = true
    store.offlineIdentityEpoch = 7

    await expect(store.refreshAuth()).resolves.toBe('unavailable')

    expect(store.user.authenticated).toBe(true)
    expect(store.user.id).toBe(42)
    expect(store.offlineIdentityReady).toBe(true)
    expect(store.offlineIdentityEpoch).toBe(7)
  })

  it('advances the identity epoch synchronously for an authoritative 401 boundary', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 }))
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.offlineIdentityReady = true
    const previousEpoch = store.offlineIdentityEpoch

    await expect(store.refreshAuth()).resolves.toBe('anonymous')

    expect(store.offlineIdentityEpoch).toBe(previousEpoch + 1)
    expect(store.user.authenticated).toBe(false)
    expect(store.offlineIdentityReady).toBe(false)
  })

  it('advances the identity epoch for a newly verified login context', async () => {
    let authenticated = false
    const fetch = vi.fn(async () =>
      authenticated
        ? new Response(JSON.stringify({ authenticated: true, user: { id: 42 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        : new Response(JSON.stringify({ authenticated: false, user: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    await expect(store.refreshAuth()).resolves.toBe('anonymous')
    const previousEpoch = store.offlineIdentityEpoch
    authenticated = true
    await expect(store.refreshAuth()).resolves.toBe('authenticated')

    expect(store.offlineIdentityEpoch).toBe(previousEpoch + 1)
    expect(store.user.id).toBe(42)
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

  it('queues an explicit logout behind an in-flight key-denial generation boundary', async () => {
    let generation = 0
    let releaseBump!: () => void
    let resolveBumpStarted!: () => void
    const bumpStarted = new Promise<void>(resolve => {
      resolveBumpStarted = resolve
    })
    let releasePurge!: () => void
    let resolvePurgeStarted!: () => void
    const purgeStarted = new Promise<void>(resolve => {
      resolvePurgeStarted = resolve
    })
    let holdNextPurge = false
    const calls: string[] = []
    const storage = {
      currentSessionGeneration: vi.fn(async () => generation),
      bumpSessionGeneration: vi.fn(async (_nextGeneration?: number, options?: { expectedSessionGeneration?: number }) => {
        calls.push(`bump:${options?.expectedSessionGeneration ?? -1}`)
        resolveBumpStarted()
        await new Promise<void>(resolve => {
          releaseBump = resolve
        })
        expect(options?.expectedSessionGeneration).toBe(generation)
        generation += 1
        return generation
      }),
      invalidateAccountSession: vi.fn(async (accountId: number, options?: { expectedSessionGeneration?: number }) => {
        calls.push(`purge:${accountId}:${options?.expectedSessionGeneration ?? -1}`)
        expect(options?.expectedSessionGeneration).toBe(generation)
        if (holdNextPurge) {
          holdNextPurge = false
          resolvePurgeStarted()
          await new Promise<void>(resolve => {
            releasePurge = resolve
          })
        }
        generation += 1
        return {
          sessionGeneration: generation,
          deletedCount: 1,
          preservedOpaqueCount: 1,
          preservedReceiptCount: 1
        }
      }),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    installWindow()
    const { invalidateOfflineIdentity, useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    const initialEpoch = store.offlineIdentityEpoch

    const denial = invalidateOfflineIdentity(42, 'draft-key-denied')
    await bumpStarted
    expect(store.offlineIdentityEpoch).toBe(initialEpoch + 1)
    const logout = invalidateOfflineIdentity(42)
    expect(logout).not.toBe(denial)
    expect(store.offlineIdentityEpoch).toBe(initialEpoch + 2)
    const repeatedDenial = invalidateOfflineIdentity(42, 'unauthorized')
    expect(repeatedDenial).toBe(logout)
    let logoutSettled = false
    void logout.then(() => {
      logoutSettled = true
    })
    await Promise.resolve()
    expect(logoutSettled).toBe(false)

    releaseBump()
    await expect(denial).resolves.toBe(true)
    await expect(logout).resolves.toBe(true)
    expect(calls).toEqual(['bump:0', 'purge:42:1'])
    expect(storage.invalidateAccountSession).toHaveBeenCalledTimes(1)

    holdNextPurge = true
    const firstAccountPurge = invalidateOfflineIdentity(7)
    await purgeStarted
    const secondAccountPurge = invalidateOfflineIdentity(8)
    expect(secondAccountPurge).not.toBe(firstAccountPurge)
    releasePurge()
    await expect(firstAccountPurge).resolves.toBe(true)
    await expect(secondAccountPurge).resolves.toBe(true)
    expect(calls).toEqual(['bump:0', 'purge:42:1', 'purge:7:2', 'purge:8:3'])
    expect(storage.invalidateAccountSession).toHaveBeenCalledTimes(3)
  })

  it('fences a store actor on remote session invalidation before any key is acquired', async () => {
    installWindow()
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.offlineIdentityReady = true
    const initialEpoch = store.offlineIdentityEpoch
    const remote = new BroadcastChannel('tsepistle-offline-session')
    try {
      remote.postMessage('invalidate')
      await vi.waitFor(() => expect(store.offlineIdentityEpoch).toBe(initialEpoch + 1))
      expect(store.offlineIdentityReady).toBe(false)
    } finally {
      remote.close()
    }
  })
})
