import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { PageApprovalInboxItem, PageWatchNotification } from '../../shared/site-notifications.ts'
import { useSiteNotificationsStore } from './site-notifications.ts'

const WATCH_PATH = '/_api/pages/watches/notifications'
const APPROVAL_PATH = '/_api/pages/approvals/inbox'
const OWNER_HEADER = 'X-Notification-Owner'
const FIRST_CURSOR = '00000000-0000-4000-8000-000000000001'
const SECOND_CURSOR = '00000000-0000-4000-8000-000000000002'

const watchItem = (id: string, title: string, readAt: string | null = null): PageWatchNotification => ({
  id,
  pageId: 12,
  eventType: 'page-updated',
  actorName: 'Editor',
  title,
  path: `docs/${id}`,
  localeCode: 'en',
  visibility: 'public',
  createdAt: '2026-09-11T10:00:00.000Z',
  readAt
})

const approvalItem = (id: string, title: string): PageApprovalInboxItem => ({
  id,
  pageId: 13,
  submitterId: 4,
  assigneeId: null,
  status: 'submitted',
  revisionId: 8,
  revisionUpdatedAt: '2026-09-11T09:00:00.000Z',
  createdAt: '2026-09-11T09:00:00.000Z',
  updatedAt: '2026-09-11T09:30:00.000Z',
  closedAt: null,
  stale: false,
  canReview: true,
  title,
  path: `reviews/${id}`,
  localeCode: 'en',
  visibility: 'public'
})

const watchEnvelope = (
  ownerId: number,
  items: PageWatchNotification[] = [],
  unreadCount = items.filter(item => item.readAt === null).length,
  nextCursor: string | null = null,
  unreadComplete = true
): Response => Response.json({ ownerId, items, unreadCount, nextCursor, unreadComplete })

const approvalEnvelope = (ownerId: number, items: PageApprovalInboxItem[] = [], nextCursor: string | null = null): Response =>
  Response.json({ ownerId, items, nextCursor })

const errorResponse = (status: number, error: string, code?: string): Response =>
  new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { 'content-type': 'application/json' }
  })

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const requestPath = (url: string): string => new URL(url, 'http://localhost').pathname
const requestCursor = (url: string): string | null => new URL(url, 'http://localhost').searchParams.get('cursor')
const ownerHeader = (init: RequestInit | undefined): string | null => new Headers(init?.headers).get(OWNER_HEADER)

const installWindow = (fetch: typeof window.fetch): void => {
  vi.stubGlobal('window', { fetch })
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('site notifications store', () => {
  it('exposes only the C3 state and notification API', () => {
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()
    const stateKeys = Object.keys(store.$state).sort()
    const publicStore = store as unknown as Record<string, unknown>

    expect(stateKeys).toEqual([
      'approvals',
      'approvalsError',
      'approvalsLoading',
      'approvalsNextCursor',
      'identityStale',
      'ownerId',
      'watches',
      'watchesError',
      'watchesLoading',
      'watchesNextCursor',
      'watchesUnreadComplete'
    ])
    expect(store.ownerId).toBeNull()
    expect(store.watches).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.watchesUnreadComplete).toBe(false)
    expect(store.approvals).toEqual([])
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(false)
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.hasNotifications).toBe(false)
    expect(store.notificationState).toBe('unknown')

    for (const obsoleteName of ['watchItems', 'approvalItems', 'watchUnreadCount', 'items']) {
      expect(publicStore[obsoleteName]).toBeUndefined()
    }
  })
  it('binds every helper request to the owner and only continues approvals explicitly', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let watchAttempt = 0
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const path = requestPath(url)
      if (path === WATCH_PATH) {
        watchAttempt += 1
        return watchAttempt === 1
          ? watchEnvelope(7, [watchItem('watch-1', 'Unread')])
          : watchEnvelope(7, [watchItem('watch-1', 'Read now', '2026-09-11T10:01:00.000Z')])
      }
      if (path === APPROVAL_PATH) {
        return requestCursor(url) === null
          ? approvalEnvelope(7, [approvalItem('approval-1', 'First page')], FIRST_CURSOR)
          : approvalEnvelope(7, [approvalItem('approval-2', 'Second page')])
      }
      if (path.endsWith('/read')) return new Response(null, { status: 204 })
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    expect(calls).toHaveLength(2)
    expect(calls.map(call => requestPath(call.url))).toEqual([WATCH_PATH, APPROVAL_PATH])
    expect(calls.every(call => ownerHeader(call.init) === '7')).toBe(true)
    expect(calls.every(call => (call.init?.method ?? 'GET') === 'GET')).toBe(true)
    expect(store.approvalsNextCursor).toBe(FIRST_CURSOR)

    await store.loadMoreApprovals()
    expect(calls).toHaveLength(3)
    expect(requestCursor(calls[2]!.url)).toBe(FIRST_CURSOR)
    expect(ownerHeader(calls[2]!.init)).toBe('7')
    expect(store.approvals.map(item => item.id)).toEqual(['approval-1', 'approval-2'])
    expect(store.approvalsNextCursor).toBeNull()

    await expect(store.markWatchRead('watch-1')).resolves.toBe(true)
    expect(calls).toHaveLength(5)
    expect(requestPath(calls[3]!.url)).toBe(`${WATCH_PATH}/watch-1/read`)
    expect(calls[3]!.init?.method).toBe('PATCH')
    expect(ownerHeader(calls[3]!.init)).toBe('7')
    expect(requestPath(calls[4]!.url)).toBe(WATCH_PATH)
    expect(requestCursor(calls[4]!.url)).toBeNull()
    expect(store.watches[0]?.readAt).toBe('2026-09-11T10:01:00.000Z')
  })

  it('treats a successful envelope for another owner as an identity change', async () => {
    let watchAttempt = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (requestPath(String(input)) === WATCH_PATH) {
        watchAttempt += 1
        return watchAttempt === 1 ? watchEnvelope(7, [watchItem('watch-1', 'Current owner')]) : watchEnvelope(8, [watchItem('watch-foreign', 'Foreign owner')])
      }
      return approvalEnvelope(7, [approvalItem('approval-1', 'Current approval')])
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    expect(store.notificationState).toBe('available')
    await store.refreshWatches()

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
  })

  it('clears and invalidates both sources after NOTIFICATION_OWNER_CHANGED', async () => {
    let phase: 'initial' | 'changed' = 'initial'
    const lateApproval = deferred<Response>()
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(String(input))
      if (path === WATCH_PATH) {
        return phase === 'initial'
          ? watchEnvelope(7, [watchItem('watch-1', 'Current owner')])
          : errorResponse(409, 'Account changed. Refresh your account.', 'NOTIFICATION_OWNER_CHANGED')
      }
      if (phase === 'initial') return approvalEnvelope(7, [approvalItem('approval-1', 'Current approval')])
      return lateApproval.promise
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    phase = 'changed'
    const refresh = store.refresh()
    const watchRefresh = store.refreshWatches()
    await watchRefresh

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')

    lateApproval.resolve(approvalEnvelope(7, [approvalItem('approval-late', 'Late old owner')]))
    await refresh
    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.identityStale).toBe(true)
  })
  it('invalidates identity after a 401 from the first watch page', async () => {
    let watchAttempt = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(String(input))
      if (path === WATCH_PATH) {
        watchAttempt += 1
        return watchAttempt === 1
          ? watchEnvelope(7, [watchItem('private-watch', 'Private watch')], 1, FIRST_CURSOR, false)
          : errorResponse(401, 'Authentication required')
      }
      return approvalEnvelope(7, [approvalItem('private-approval', 'Private approval')], FIRST_CURSOR)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.refreshWatches()

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')
  })

  it('invalidates identity after a 401 from a watch continuation', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const path = requestPath(url)
      if (path === WATCH_PATH) {
        return requestCursor(url) === null
          ? watchEnvelope(7, [watchItem('private-watch', 'Private watch')], 1, FIRST_CURSOR, false)
          : errorResponse(401, 'Authentication required')
      }
      return approvalEnvelope(7, [approvalItem('private-approval', 'Private approval')], FIRST_CURSOR)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.loadMoreWatches()

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')
  })

  it('invalidates identity after a 401 from the first approvals page', async () => {
    let approvalAttempt = 0
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(String(input))
      if (path === APPROVAL_PATH) {
        approvalAttempt += 1
        return approvalAttempt === 1
          ? approvalEnvelope(7, [approvalItem('private-approval', 'Private approval')], FIRST_CURSOR)
          : errorResponse(401, 'Authentication required')
      }
      return watchEnvelope(7, [watchItem('private-watch', 'Private watch')], 1, FIRST_CURSOR, false)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.refreshApprovals()

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')
  })

  it('invalidates identity after a 401 from an approvals continuation', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const path = requestPath(url)
      if (path === APPROVAL_PATH) {
        return requestCursor(url) === null
          ? approvalEnvelope(7, [approvalItem('private-approval', 'Private approval')], FIRST_CURSOR)
          : errorResponse(401, 'Authentication required')
      }
      return watchEnvelope(7, [watchItem('private-watch', 'Private watch')], 1, FIRST_CURSOR, false)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.loadMoreApprovals()

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')
  })

  it('invalidates identity after a 401 from mark-read', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(String(input))
      if (path.endsWith('/read')) return errorResponse(401, 'Authentication required')
      if (path === WATCH_PATH) return watchEnvelope(7, [watchItem('private-watch', 'Private watch')], 1, FIRST_CURSOR, false)
      return approvalEnvelope(7, [approvalItem('private-approval', 'Private approval')], FIRST_CURSOR)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await expect(store.markWatchRead('private-watch')).resolves.toBe(false)

    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(true)
    expect(store.notificationState).toBe('unknown')
  })

  it('retains current-owner state and reports ordinary continuation and mark-read failures', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const path = requestPath(url)
      if (path === WATCH_PATH) {
        return requestCursor(url) === null
          ? watchEnvelope(7, [watchItem('private-watch', 'Private watch')], 1, FIRST_CURSOR, false)
          : errorResponse(403, 'Forbidden')
      }
      if (path === APPROVAL_PATH) {
        return requestCursor(url) === null
          ? approvalEnvelope(7, [approvalItem('private-approval', 'Private approval')], FIRST_CURSOR)
          : errorResponse(500, 'Notification service unavailable')
      }
      return Promise.reject(new Error('Network unavailable'))
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.loadMoreWatches()
    expect(store.watches.map(item => item.title)).toEqual(['Private watch'])
    expect(store.watchesNextCursor).toBe(FIRST_CURSOR)
    expect(store.watchesError).toBe('Forbidden')
    expect(store.identityStale).toBe(false)

    await store.loadMoreApprovals()
    expect(store.approvals.map(item => item.title)).toEqual(['Private approval'])
    expect(store.approvalsNextCursor).toBe(FIRST_CURSOR)
    expect(store.approvalsError).toBe('Notification service unavailable')
    expect(store.identityStale).toBe(false)

    await expect(store.markWatchRead('private-watch')).resolves.toBe(false)
    expect(store.watches.map(item => item.title)).toEqual(['Private watch'])
    expect(store.watchesError).toBe('Network unavailable')
    expect(store.approvals.map(item => item.title)).toEqual(['Private approval'])
    expect(store.approvalsError).toBe('Notification service unavailable')
    expect(store.identityStale).toBe(false)
    expect(store.notificationState).toBe('available')
  })

  it('ignores late GET completions from an old owner after reinitialization', async () => {
    const requests: Array<{ owner: string | null; url: string; response: Deferred<Response> }> = []
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const response = deferred<Response>()
      requests.push({ owner: ownerHeader(init), url: String(input), response })
      return response.promise
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    const oldInitialization = store.initialize(7)
    await settle()
    expect(requests).toHaveLength(2)

    const newInitialization = store.initialize(8)
    await settle()
    expect(requests).toHaveLength(4)

    for (const request of requests.filter(request => request.owner === '7')) {
      request.response.resolve(
        requestPath(request.url) === WATCH_PATH
          ? watchEnvelope(7, [watchItem('old-watch', 'Old owner')])
          : approvalEnvelope(7, [approvalItem('old-approval', 'Old owner')])
      )
    }
    await settle()
    expect(store.watches).toEqual([])
    expect(store.approvals).toEqual([])

    for (const request of requests.filter(request => request.owner === '8')) {
      request.response.resolve(
        requestPath(request.url) === WATCH_PATH
          ? watchEnvelope(8, [watchItem('new-watch', 'New owner')])
          : approvalEnvelope(8, [approvalItem('new-approval', 'New owner')])
      )
    }
    await Promise.all([oldInitialization, newInitialization])

    expect(store.ownerId).toBe(8)
    expect(store.identityStale).toBe(false)
    expect(store.watches.map(item => item.id)).toEqual(['new-watch'])
    expect(store.approvals.map(item => item.id)).toEqual(['new-approval'])
    expect(store.notificationState).toBe('available')
  })

  it('does not mutate the new owner when an old-owner mark-read request completes', async () => {
    const readResponse = deferred<Response>()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const path = requestPath(url)
      if (path.endsWith('/read')) return readResponse.promise
      if (ownerHeader(init) === '7') {
        return path === WATCH_PATH ? watchEnvelope(7, [watchItem('old-watch', 'Old owner')]) : approvalEnvelope(7)
      }
      return path === WATCH_PATH ? watchEnvelope(8, [watchItem('new-watch', 'New owner')]) : approvalEnvelope(8)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    const oldRead = store.markWatchRead('old-watch')
    await settle()
    expect(fetch).toHaveBeenCalledTimes(3)
    const readCall = fetch.mock.calls[2]
    expect(ownerHeader(readCall?.[1])).toBe('7')

    await store.initialize(8)
    readResponse.resolve(new Response(null, { status: 204 }))
    await expect(oldRead).resolves.toBe(false)

    expect(store.ownerId).toBe(8)
    expect(store.watches.map(item => item.id)).toEqual(['new-watch'])
    expect(store.watches[0]?.readAt).toBeNull()
    expect(store.watchesError).toBe('')
  })

  it('coalesces concurrent refreshes for each source', async () => {
    const watchResponse = deferred<Response>()
    const approvalResponse = deferred<Response>()
    const fetch = vi.fn((input: RequestInfo | URL) => {
      return requestPath(String(input)) === WATCH_PATH ? watchResponse.promise : approvalResponse.promise
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    const initialized = store.initialize(7)
    await settle()
    const watchRefresh = store.refreshWatches()
    const watchRetry = store.refreshWatches()
    const approvalRefresh = store.refreshApprovals()
    const approvalRetry = store.refreshApprovals()

    expect(fetch).toHaveBeenCalledTimes(2)
    watchResponse.resolve(watchEnvelope(7))
    approvalResponse.resolve(approvalEnvelope(7))
    await Promise.all([initialized, watchRefresh, watchRetry, approvalRefresh, approvalRetry])

    expect(store.watchesLoading).toBe(false)
    expect(store.approvalsLoading).toBe(false)
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.notificationState).toBe('clear')
  })

  it('reports known approvals despite one source failure', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      return requestPath(String(input)) === WATCH_PATH
        ? errorResponse(503, 'watch source unavailable')
        : approvalEnvelope(7, [approvalItem('approval-1', 'Needs review')])
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)

    expect(store.watches).toEqual([])
    expect(store.approvals.map(item => item.id)).toEqual(['approval-1'])
    expect(store.watchesError).toBe('watch source unavailable')
    expect(store.approvalsError).toBe('')
    expect(store.hasNotifications).toBe(true)
    expect(store.notificationState).toBe('available')
  })

  it('does not auto-drain an empty approval continuation and reports unknown state', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      return requestPath(String(input)) === WATCH_PATH ? watchEnvelope(7) : approvalEnvelope(7, [], FIRST_CURSOR)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.approvals).toEqual([])
    expect(store.approvalsNextCursor).toBe(FIRST_CURSOR)
    expect(store.hasNotifications).toBe(false)
    expect(store.notificationState).toBe('unknown')
  })

  it('appends explicit approval pages while deduplicating IDs and stops at the final cursor', async () => {
    const calls: string[] = []
    const first = approvalItem('approval-1', 'First')
    const overlap = approvalItem('approval-2', 'Overlap')
    const older = approvalItem('approval-3', 'Older')
    const oldest = approvalItem('approval-4', 'Oldest')
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      expect(ownerHeader(init)).toBe('7')
      const path = requestPath(url)
      if (path === WATCH_PATH) return watchEnvelope(7)
      switch (requestCursor(url)) {
        case null:
          return approvalEnvelope(7, [first, overlap], FIRST_CURSOR)
        case FIRST_CURSOR:
          return approvalEnvelope(7, [overlap, older], SECOND_CURSOR)
        case SECOND_CURSOR:
          return approvalEnvelope(7, [older, oldest])
        default:
          throw new Error(`Unexpected cursor in ${url}`)
      }
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    expect(calls).toHaveLength(2)
    expect(store.approvals.map(item => item.id)).toEqual(['approval-1', 'approval-2'])

    await store.loadMoreApprovals()
    expect(store.approvals.map(item => item.id)).toEqual(['approval-1', 'approval-2', 'approval-3'])
    expect(store.approvalsNextCursor).toBe(SECOND_CURSOR)

    await store.loadMoreApprovals()
    expect(store.approvals.map(item => item.id)).toEqual(['approval-1', 'approval-2', 'approval-3', 'approval-4'])
    expect(store.approvalsNextCursor).toBeNull()

    await store.loadMoreApprovals()
    expect(calls).toHaveLength(4)
    expect(store.notificationState).toBe('available')
  })

  it('retains approvals and their cursor on expiry, then permits an explicit refresh', async () => {
    let initialRequest = true
    const current = approvalItem('approval-1', 'Still visible')
    const refreshed = approvalItem('approval-2', 'Refreshed')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const path = requestPath(url)
      if (path === WATCH_PATH) return watchEnvelope(7)
      if (requestCursor(url) === FIRST_CURSOR) {
        return errorResponse(409, 'Approval cursor expired', 'APPROVAL_CURSOR_EXPIRED')
      }
      if (initialRequest) {
        initialRequest = false
        return approvalEnvelope(7, [current], FIRST_CURSOR)
      }
      return approvalEnvelope(7, [current, refreshed])
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.loadMoreApprovals()

    expect(store.approvals.map(item => item.id)).toEqual(['approval-1'])
    expect(store.approvalsNextCursor).toBe(FIRST_CURSOR)
    expect(store.approvalsError).toBe('Approval cursor expired')
    expect(store.hasNotifications).toBe(true)
    expect(store.notificationState).toBe('available')

    await store.refreshApprovals()
    expect(store.approvals.map(item => item.id)).toEqual(['approval-1', 'approval-2'])
    expect(store.approvalsNextCursor).toBeNull()
    expect(store.approvalsError).toBe('')
    expect(store.notificationState).toBe('available')
  })

  it('keeps an empty incomplete unread window unknown until continuation is requested', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (requestPath(url) === WATCH_PATH) {
        return requestCursor(url) === null ? watchEnvelope(7, [], 0, FIRST_CURSOR, false) : watchEnvelope(7, [watchItem('watch-late', 'Beyond first window')])
      }
      return approvalEnvelope(7)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)

    expect(calls).toHaveLength(2)
    expect(store.watches).toEqual([])
    expect(store.watchesNextCursor).toBe(FIRST_CURSOR)
    expect(store.watchesUnreadComplete).toBe(false)
    expect(store.hasNotifications).toBe(false)
    expect(store.notificationState).toBe('unknown')

    await store.loadMoreWatches()

    expect(calls).toHaveLength(3)
    expect(requestCursor(calls[2]!.url)).toBe(FIRST_CURSOR)
    expect(store.watches.map(item => item.id)).toEqual(['watch-late'])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.watchesUnreadComplete).toBe(true)
    expect(store.notificationState).toBe('available')
  })

  it('allows a clear state when unread history is complete despite a read-history cursor', async () => {
    const older = watchItem('watch-older', 'Older', '2026-09-11T09:00:00.000Z')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (requestPath(url) === WATCH_PATH) {
        return requestCursor(url) === null
          ? watchEnvelope(7, [watchItem('watch-read', 'Read', '2026-09-11T10:00:00.000Z')], 0, FIRST_CURSOR, true)
          : watchEnvelope(7, [older])
      }
      return approvalEnvelope(7)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)

    expect(store.watchesNextCursor).toBe(FIRST_CURSOR)
    expect(store.watchesUnreadComplete).toBe(true)
    expect(store.notificationState).toBe('clear')

    await store.loadMoreWatches()

    expect(store.watches.map(item => item.id)).toEqual(['watch-read', 'watch-older'])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.notificationState).toBe('clear')
  })

  it('coalesces watch continuations and reconciles duplicate notification IDs', async () => {
    const continuation = deferred<Response>()
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (requestPath(url) === WATCH_PATH) {
        if (requestCursor(url) === FIRST_CURSOR) return continuation.promise
        if (requestCursor(url) === null) return Promise.resolve(watchEnvelope(7, [watchItem('watch-1', 'Original')], 1, FIRST_CURSOR, false))
      }
      return Promise.resolve(approvalEnvelope(7))
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    const firstLoad = store.loadMoreWatches()
    await settle()
    const secondLoad = store.loadMoreWatches()

    expect(fetch).toHaveBeenCalledTimes(3)
    continuation.resolve(
      watchEnvelope(7, [watchItem('watch-1', 'Reconciled', '2026-09-11T10:02:00.000Z'), watchItem('watch-2', 'New unread')], 1, SECOND_CURSOR, true)
    )
    await Promise.all([firstLoad, secondLoad])

    expect(store.watches.map(item => item.id)).toEqual(['watch-1', 'watch-2'])
    expect(store.watches[0]?.title).toBe('Reconciled')
    expect(store.watches[0]?.readAt).toBe('2026-09-11T10:02:00.000Z')
    expect(store.watchesNextCursor).toBe(SECOND_CURSOR)
    expect(store.watchesUnreadComplete).toBe(true)
    expect(store.notificationState).toBe('available')
  })

  it('retains the watch window and cursor on expiry, then refreshes explicitly', async () => {
    let initial = true
    const current = watchItem('watch-current', 'Current')
    const refreshed = watchItem('watch-current', 'Current', '2026-09-11T10:03:00.000Z')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (requestPath(url) === WATCH_PATH) {
        if (requestCursor(url) === FIRST_CURSOR) return errorResponse(409, 'Watch cursor expired', 'WATCH_CURSOR_EXPIRED')
        if (initial) {
          initial = false
          return watchEnvelope(7, [current], 1, FIRST_CURSOR, false)
        }
        return watchEnvelope(7, [refreshed], 0, null, true)
      }
      return approvalEnvelope(7)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    await store.loadMoreWatches()

    expect(store.watches).toEqual([current])
    expect(store.watchesNextCursor).toBe(FIRST_CURSOR)
    expect(store.watchesUnreadComplete).toBe(false)
    expect(store.watchesError).toBe('Watch cursor expired')
    expect(store.notificationState).toBe('available')

    await store.refreshWatches()

    expect(store.watches).toEqual([refreshed])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.watchesUnreadComplete).toBe(true)
    expect(store.watchesError).toBe('')
    expect(store.notificationState).toBe('clear')
  })

  it('ignores a late watch continuation after owner reinitialization', async () => {
    const oldContinuation = deferred<Response>()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const ownerId = Number(ownerHeader(init))
      if (requestPath(url) === WATCH_PATH) {
        if (ownerId === 7 && requestCursor(url) === FIRST_CURSOR) return oldContinuation.promise
        return watchEnvelope(ownerId, [watchItem(`watch-${ownerId}`, `Owner ${ownerId}`)], 1, null, true)
      }
      return approvalEnvelope(ownerId)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    const oldLoad = store.loadMoreWatches()
    await settle()
    await store.initialize(8)
    oldContinuation.resolve(watchEnvelope(7, [watchItem('old-late', 'Old owner')], 1, null, true))
    await oldLoad

    expect(store.ownerId).toBe(8)
    expect(store.watches.map(item => item.id)).toEqual(['watch-8'])
    expect(store.watchesError).toBe('')
    expect(store.identityStale).toBe(false)
  })

  it('refreshes the first watch window after mark-read and coalesces retries', async () => {
    const refreshed = deferred<Response>()
    let watchAttempt = 0
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const path = requestPath(url)
      if (path === WATCH_PATH) {
        watchAttempt += 1
        return watchAttempt === 1 ? Promise.resolve(watchEnvelope(7, [watchItem('watch-1', 'Read this')], 1, FIRST_CURSOR, false)) : refreshed.promise
      }
      if (path.endsWith('/read')) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(approvalEnvelope(7))
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    const read = store.markWatchRead('watch-1')
    await settle()
    const retry = store.refreshWatches()

    expect(fetch).toHaveBeenCalledTimes(4)
    refreshed.resolve(watchEnvelope(7, [watchItem('watch-next', 'Next unread')], 1, null, true))
    await Promise.all([read, retry])

    expect(store.watches.map(item => item.id)).toEqual(['watch-next'])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.watchesUnreadComplete).toBe(true)
    expect(store.notificationState).toBe('available')
  })

  it('resets all account-bound state before allowing a new owner to initialize', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const ownerId = Number(ownerHeader(init))
      return requestPath(String(input)) === WATCH_PATH
        ? watchEnvelope(ownerId, [watchItem(`watch-${ownerId}`, `Owner ${ownerId}`)])
        : approvalEnvelope(ownerId, [approvalItem(`approval-${ownerId}`, `Owner ${ownerId}`)], FIRST_CURSOR)
    }) as unknown as typeof window.fetch
    installWindow(fetch)
    setActivePinia(createPinia())
    const store = useSiteNotificationsStore()

    await store.initialize(7)
    expect(store.watches.map(item => item.id)).toEqual(['watch-7'])
    expect(store.approvals.map(item => item.id)).toEqual(['approval-7'])

    store.reset()
    expect(store.ownerId).toBeNull()
    expect(store.watches).toEqual([])
    expect(store.watchesNextCursor).toBeNull()
    expect(store.watchesUnreadComplete).toBe(false)
    expect(store.approvals).toEqual([])
    expect(store.watchesLoading).toBe(false)
    expect(store.approvalsLoading).toBe(false)
    expect(store.watchesError).toBe('')
    expect(store.approvalsError).toBe('')
    expect(store.identityStale).toBe(false)
    expect(store.approvalsNextCursor).toBeNull()

    await store.initialize(8)
    expect(store.ownerId).toBe(8)
    expect(store.watches.map(item => item.id)).toEqual(['watch-8'])
    expect(store.approvals.map(item => item.id)).toEqual(['approval-8'])
    expect(store.identityStale).toBe(false)
  })
})
