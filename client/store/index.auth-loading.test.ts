import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type * as WikiStoreModule from './index.ts'

type StorageStub = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const installWindow = (fetch: unknown = vi.fn(), localStorage?: StorageStub): void => {
  vi.stubGlobal('window', {
    fetch,
    location: { protocol: 'https:', pathname: '/', origin: 'https://wiki.example.test' },
    ...(localStorage ? { localStorage } : {}),
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
    const storage = {
      getReadingVault: vi.fn(async () => null),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
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
  it('retires a persisted reading vault before cold-start guest readiness', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 3),
      getReadingVault: vi.fn(async () => ({
        context: {
          canonicalOrigin: 'https://wiki.example.test',
          siteId: 'site-fixture',
          accountId: 42,
          authVersion: 3
        }
      })),
      bumpSessionGeneration: vi.fn(async () => 4),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
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

    await expect(store.refreshAuth()).resolves.toBe('anonymous')
    expect(storage.getReadingVault).toHaveBeenCalledOnce()
    expect(storage.bumpSessionGeneration).toHaveBeenCalledWith(undefined, { expectedSessionGeneration: 3 })
    expect(store.user.authenticated).toBe(false)
    expect(store.offlineIdentityReady).toBe(false)
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
      return new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'Alice', authVersion: 1 } }), {
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
  it('does not verify an authenticated identity without a current auth version', async () => {
    let attempt = 0
    const fetch = vi.fn(async () => {
      attempt += 1
      const payload =
        attempt === 1
          ? { authenticated: true, user: { id: 42, name: 'Alice' } }
          : attempt === 2
            ? { authenticated: true, user: { id: 42, name: 'Alice', authVersion: '7' } }
            : { authenticated: true, user: { id: 42, name: 'Alice', authVersion: 7 } }
      return new Response(JSON.stringify(payload), {
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
    await expect(store.refreshAuth()).resolves.toBe('unavailable')
    expect(store.user.authenticated).toBe(false)
    expect(store.user.id).toBe(0)
    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(store.user.authenticated).toBe(true)
    expect(store.user.authVersion).toBe(7)
  })

  it('preserves the warm identity epoch and actor during a transient whoami outage', async () => {
    const storage = {
      getReadingVault: vi.fn(async () => ({
        context: {
          canonicalOrigin: 'https://wiki.example.test',
          siteId: 'site-fixture',
          accountId: 42,
          authVersion: 7
        }
      })),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
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
    expect(storage.getReadingVault).not.toHaveBeenCalled()
    expect(store.offlineIdentityEpoch).toBe(7)
  })

  it('advances the identity epoch synchronously for an authoritative 401 boundary', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 9),
      bumpSessionGeneration: vi.fn(async () => 10),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
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
    const storage = {
      currentSessionGeneration: vi.fn(async () => 0),
      getReadingVault: vi.fn(async () => null),
      bumpSessionGeneration: vi.fn(async () => 1),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(async () =>
      authenticated
        ? new Response(JSON.stringify({ authenticated: true, user: { id: 42, authVersion: 1 } }), {
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
      new Response(JSON.stringify({ authenticated: true, user: { id: 7, authVersion: 1 } }), {
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
  it('ignores a delayed whoami success after explicit logout', async () => {
    let releaseResponse!: (response: Response) => void
    const fetch = vi.fn(
      async () =>
        await new Promise<Response>(resolve => {
          releaseResponse = resolve
        })
    )
    installWindow(fetch)
    const { invalidateOfflineIdentity, useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.name = 'Alice'
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'
    const dispatched: Event[] = []
    window.dispatchEvent = (event: Event): boolean => {
      dispatched.push(event)
      return true
    }

    const refresh = store.refreshAuth()
    const logout = invalidateOfflineIdentity(42)
    expect(store.offlineIdentityReady).toBe(false)
    releaseResponse(
      new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'Late Alice', authVersion: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(refresh).resolves.toBe('unavailable')
    await expect(logout).resolves.toBe(true)
    expect(store.user.id).toBe(42)
    expect(store.user.name).toBe('Alice')
    expect(store.user.authenticated).toBe(true)
    expect(store.offlineIdentityReady).toBe(false)
    expect(store.authRefreshOutcome).toBeNull()
    expect(store.authRefreshPending).toBe(false)
    expect(dispatched.filter(event => event.type === 'tsepistle:auth-outcome')).toHaveLength(0)
  })

  it('ignores a delayed whoami error after remote invalidation', async () => {
    let rejectResponse!: (error: unknown) => void
    const fetch = vi.fn(
      async () =>
        await new Promise<Response>((_resolve, reject) => {
          rejectResponse = reject
        })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.name = 'Alice'
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'
    const initialEpoch = store.offlineIdentityEpoch
    const refresh = store.refreshAuth()
    const remote = new BroadcastChannel('tsepistle-offline-session')
    try {
      remote.postMessage('invalidate')
      await vi.waitFor(() => {
        expect(store.offlineIdentityEpoch).toBe(initialEpoch + 1)
        expect(store.offlineIdentityReady).toBe(false)
      })
      rejectResponse(new Error('late network failure'))

      await expect(refresh).resolves.toBe('unavailable')
      expect(store.user.id).toBe(42)
      expect(store.user.name).toBe('Alice')
      expect(store.user.authenticated).toBe(true)
      expect(store.authRefreshOutcome).toBeNull()
      expect(store.authRefreshPending).toBe(false)
    } finally {
      remote.close()
    }
  })

  it('keeps A after a stale B response and accepts a later fresh A response', async () => {
    let attempt = 0
    let releaseB!: (response: Response) => void
    const fetch = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        return new Response(JSON.stringify({ authenticated: true, user: { id: 1, name: 'A-old', authVersion: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (attempt === 2) {
        return await new Promise<Response>(resolve => {
          releaseB = resolve
        })
      }
      return new Response(JSON.stringify({ authenticated: true, user: { id: 1, name: 'A-new', authVersion: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    installWindow(fetch)
    const { invalidateOfflineIdentity, useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(store.user.name).toBe('A-old')

    const staleB = store.refreshAuth()
    const logout = invalidateOfflineIdentity(1)
    expect(store.offlineIdentityReady).toBe(false)
    releaseB(
      new Response(JSON.stringify({ authenticated: true, user: { id: 2, name: 'B', authVersion: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(staleB).resolves.toBe('unavailable')
    await expect(logout).resolves.toBe(true)
    expect(store.user.id).toBe(1)
    expect(store.user.name).toBe('A-old')
    expect(store.offlineIdentityReady).toBe(false)

    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(store.user.id).toBe(1)
    expect(store.user.name).toBe('A-new')
    expect(store.offlineIdentityReady).toBe(true)
  })

  it('fences A before waiting for the durable purge that makes B usable', async () => {
    let releasePurge!: () => void
    let resolvePurgeStarted!: () => void
    const purgeStarted = new Promise<void>(resolve => {
      resolvePurgeStarted = resolve
    })
    const storage = {
      currentSessionGeneration: vi.fn(async () => 0),
      bumpSessionGeneration: vi.fn(async () => 1),
      invalidateAccountSession: vi.fn(async () => {
        resolvePurgeStarted()
        await new Promise<void>(resolve => {
          releasePurge = resolve
        })
        return { sessionGeneration: 1, deletedCount: 1, preservedOpaqueCount: 0, preservedReceiptCount: 1 }
      }),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    let attempt = 0
    const fetch = vi.fn(async () => {
      attempt += 1
      const id = attempt === 1 ? 1 : 2
      return new Response(JSON.stringify({ authenticated: true, user: { id, name: id === 1 ? 'A' : 'B', authVersion: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)

    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    const next = store.refreshAuth()
    await purgeStarted
    expect(store.user.authenticated).toBe(false)
    expect(store.user.id).toBe(0)
    expect(store.offlineIdentityReady).toBe(false)

    releasePurge()
    await expect(next).resolves.toBe('authenticated')
    expect(store.user.id).toBe(2)
    expect(store.user.name).toBe('B')
    expect(store.offlineIdentityReady).toBe(true)
  })

  it('purges ordinary drafts only for a confirmed account switch', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 3),
      bumpSessionGeneration: vi.fn(),
      invalidateAccountSession: vi.fn(async () => ({
        sessionGeneration: 4,
        deletedCount: 1,
        preservedOpaqueCount: 1,
        preservedReceiptCount: 1
      })),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 7, name: 'B', authVersion: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.name = 'A'
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'
    const initialEpoch = store.offlineIdentityEpoch

    await expect(store.refreshAuth()).resolves.toBe('authenticated')

    expect(storage.invalidateAccountSession).toHaveBeenCalledWith(42, { expectedSessionGeneration: 3 })
    expect(storage.bumpSessionGeneration).not.toHaveBeenCalled()
    expect(store.offlineIdentityEpoch).toBe(initialEpoch + 1)
    expect(store.user.id).toBe(7)
    expect(store.user.name).toBe('B')
    expect(store.offlineIdentityReady).toBe(true)
  })

  it('does not publish B when durable identity cleanup fails', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 2),
      bumpSessionGeneration: vi.fn(),
      invalidateAccountSession: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 7, name: 'B', authVersion: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.name = 'A'
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'

    await expect(store.refreshAuth()).resolves.toBe('unavailable')
    expect(store.user.authenticated).toBe(false)
    expect(store.user.id).toBe(0)
    expect(store.offlineIdentityReady).toBe(false)
    expect(store.notification.message).toBe('Offline identity cleanup failed. Reconnect and try again.')
  })

  it('keeps a matching vault for a configured installation identity', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 4),
      getReadingVault: vi.fn(async () => ({
        context: {
          canonicalOrigin: 'https://wiki.example.test',
          siteId: 'site-fixture',
          accountId: 42,
          authVersion: 1
        }
      })),
      bumpSessionGeneration: vi.fn(async () => 5),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'A', authVersion: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    installWindow(fetch)
    window.siteConfig.offlineDraftSiteId = 'site-fixture'
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.authVersion = 1
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'

    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(storage.getReadingVault).toHaveBeenCalledOnce()
    expect(storage.bumpSessionGeneration).not.toHaveBeenCalled()
    expect(store.offlineIdentityReady).toBe(true)
  })

  it('retires a persisted vault whose site or account authority no longer matches', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 4),
      getReadingVault: vi.fn(async () => ({
        context: {
          canonicalOrigin: 'https://wiki.example.test',
          siteId: 'other-site',
          accountId: 42,
          authVersion: 1
        }
      })),
      bumpSessionGeneration: vi.fn(async () => 5),
      invalidateAccountSession: vi.fn(),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'A', authVersion: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.authVersion = 1
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'

    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(storage.getReadingVault).toHaveBeenCalledOnce()
    expect(storage.bumpSessionGeneration).toHaveBeenCalledWith(undefined, { expectedSessionGeneration: 4 })
    expect(storage.invalidateAccountSession).not.toHaveBeenCalled()
    expect(store.user.id).toBe(42)
    expect(store.offlineIdentityReady).toBe(true)
  })

  it('retires the reading boundary when the verified security version changes', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 6),
      bumpSessionGeneration: vi.fn(async () => 7),
      invalidateAccountSession: vi.fn(),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'A', authVersion: 2 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.authVersion = 1
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'

    await expect(store.refreshAuth()).resolves.toBe('authenticated')
    expect(storage.bumpSessionGeneration).toHaveBeenCalledWith(undefined, { expectedSessionGeneration: 6 })
    expect(storage.invalidateAccountSession).not.toHaveBeenCalled()
    expect(store.user.authVersion).toBe(2)
    expect(store.offlineIdentityReady).toBe(true)
  })
  it('does not publish a new same-account identity when version cleanup fails', async () => {
    const storage = {
      currentSessionGeneration: vi.fn(async () => 6),
      bumpSessionGeneration: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 42, name: 'New Alice', authVersion: 2 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.user.name = 'Old Alice'
    store.user.authVersion = 1
    store.offlineIdentityReady = true
    store.authRefreshSettled = true
    store.authRefreshOutcome = 'authenticated'

    await expect(store.refreshAuth()).resolves.toBe('unavailable')
    expect(store.user.authenticated).toBe(false)
    expect(store.user.id).toBe(0)
    expect(store.user.name).toBe('')
    expect(store.offlineIdentityReady).toBe(false)
    expect(store.notification.message).toBe('Offline identity cleanup failed. Reconnect and try again.')
  })

  it('stores only a durable non-secret logout marker until explicit sign-in resolves it', async () => {
    let marker: string | null = null
    const localStorage: StorageStub = {
      getItem: vi.fn((_key: string) => marker),
      setItem: vi.fn((_key: string, value: string) => {
        marker = value
      }),
      removeItem: vi.fn((_key: string) => {
        marker = null
      })
    }
    installWindow(vi.fn(), localStorage)
    const { hasOfflineLogoutPending, markOfflineLogoutPending, resolvePendingOfflineLogoutAfterExplicitSignIn } = await vi.importFresh<typeof WikiStoreModule>(
      './index.ts',
      import.meta.url
    )

    expect(markOfflineLogoutPending(42)).toBe(true)
    expect(marker).toBe('42')
    expect(marker).not.toContain('secret')
    expect(hasOfflineLogoutPending()).toBe(true)
    resolvePendingOfflineLogoutAfterExplicitSignIn()
    expect(marker).toBeNull()
    expect(hasOfflineLogoutPending()).toBe(false)
  })

  it('uses a generation-only boundary for involuntary 401 loss', async () => {
    const generationCalls: number[] = []
    const storage = {
      currentSessionGeneration: vi.fn(async () => 9),
      bumpSessionGeneration: vi.fn(async (_nextGeneration?: number, options?: { expectedSessionGeneration?: number }) => {
        generationCalls.push(options?.expectedSessionGeneration ?? -1)
        return 10
      }),
      invalidateAccountSession: vi.fn(),
      close: vi.fn()
    }
    vi.mockModule('../helpers/offline-storage.ts', import.meta.url, () => ({
      openOfflineStorage: vi.fn(async () => storage)
    }))
    const fetch = vi.fn(async () => new Response('', { status: 401 }))
    installWindow(fetch)
    const { useWikiStore, pinia } = await vi.importFresh<typeof WikiStoreModule>('./index.ts', import.meta.url)
    const store = useWikiStore(pinia)
    store.user.authenticated = true
    store.user.id = 42
    store.offlineIdentityReady = true

    await expect(store.refreshAuth()).resolves.toBe('anonymous')

    expect(generationCalls).toEqual([9])
    expect(storage.bumpSessionGeneration).toHaveBeenCalledTimes(1)
    expect(storage.invalidateAccountSession).not.toHaveBeenCalled()
    expect(store.user.authenticated).toBe(false)
    expect(store.offlineIdentityReady).toBe(false)
  })
})
