import { defineStore } from 'pinia'
import type { PageApprovalInboxItem, PageWatchNotification } from '../../shared/site-notifications.ts'
import { fetchPageApprovalInbox, fetchPageWatchNotifications, markPageWatchNotificationRead } from '../helpers/site-notifications-api.ts'

interface NotificationStoreState {
  ownerId: number | null
  watches: PageWatchNotification[]
  watchesNextCursor: string | null
  watchesUnreadComplete: boolean
  approvals: PageApprovalInboxItem[]
  watchesLoading: boolean
  approvalsLoading: boolean
  watchesError: string
  approvalsError: string
  identityStale: boolean
  approvalsNextCursor: string | null
}

type NotificationStore = NotificationStoreState

type SourceRequest = {
  ownerId: number
  generation: number
  controller: AbortController
  promise: Promise<void>
}

type ReadRequest = {
  ownerId: number
  generation: number
  controller: AbortController
}

type NotificationStoreInternals = {
  generation: number
  initialized: boolean
  watchesLoaded: boolean
  approvalsLoaded: boolean
  watches?: SourceRequest
  approvals?: SourceRequest
  reads: Set<ReadRequest>
}

type NotificationState = 'available' | 'unknown' | 'clear'

const internals = new WeakMap<object, NotificationStoreInternals>()

const getInternals = (store: object): NotificationStoreInternals => {
  let value = internals.get(store)
  if (!value) {
    value = { generation: 0, initialized: false, watchesLoaded: false, approvalsLoaded: false, reads: new Set() }
    internals.set(store, value)
  }
  return value
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Notifications could not be loaded.'
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  if (typeof code === 'string') return code
  const name = Reflect.get(error, 'name')
  return typeof name === 'string' ? name : undefined
}

const validOwnerId = (ownerId: number | null | undefined): number | null =>
  typeof ownerId === 'number' && Number.isSafeInteger(ownerId) && ownerId > 0 ? ownerId : null

const isCurrent = (store: NotificationStore, ownerId: number, generation: number): boolean => {
  const state = getInternals(store)
  return !store.identityStale && store.ownerId === ownerId && state.generation === generation && state.initialized
}

const abortRequests = (store: NotificationStore): void => {
  const state = getInternals(store)
  state.watches?.controller.abort()
  state.approvals?.controller.abort()
  for (const request of state.reads) request.controller.abort()
  state.reads.clear()
}

const clearSourceState = (store: NotificationStore): void => {
  const state = getInternals(store)
  store.watches = []
  store.watchesNextCursor = null
  store.watchesUnreadComplete = false
  store.approvals = []
  store.watchesLoading = false
  store.approvalsLoading = false
  store.watchesError = ''
  store.approvalsError = ''
  store.approvalsNextCursor = null
  state.watchesLoaded = false
  state.approvalsLoaded = false
}

const invalidateIdentity = (store: NotificationStore, ownerId: number, generation: number): void => {
  if (store.ownerId !== ownerId || getInternals(store).generation !== generation || store.identityStale) return
  const state = getInternals(store)
  state.generation += 1
  state.initialized = false
  abortRequests(store)
  state.watches = undefined
  state.approvals = undefined
  clearSourceState(store)
  store.identityStale = true
}

const identityInvalidated = (error: unknown): boolean => {
  if (errorCode(error) === 'NOTIFICATION_OWNER_CHANGED') return true
  return typeof error === 'object' && error !== null && Reflect.get(error, 'status') === 401
}

const appendWatches = (store: NotificationStore, items: readonly PageWatchNotification[]): void => {
  const indexes = new Map(store.watches.map((item, index) => [item.id, index]))
  const next = [...store.watches]
  for (const item of items) {
    const index = indexes.get(item.id)
    if (index === undefined) {
      indexes.set(item.id, next.length)
      next.push(item)
    } else {
      next[index] = item
    }
  }
  store.watches = next
}

const appendApprovals = (store: NotificationStore, items: readonly PageApprovalInboxItem[]): void => {
  const seen = new Set(store.approvals.map(item => item.id))
  const next = [...store.approvals]
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    next.push(item)
  }
  store.approvals = next
}

export const useSiteNotificationsStore = defineStore('site-notifications', {
  state: (): NotificationStoreState => ({
    ownerId: null,
    watches: [],
    watchesNextCursor: null,
    watchesUnreadComplete: false,
    approvals: [],
    watchesLoading: false,
    approvalsLoading: false,
    watchesError: '',
    approvalsError: '',
    identityStale: false,
    approvalsNextCursor: null
  }),
  getters: {
    hasNotifications(state): boolean {
      return state.watches.some(item => item.readAt === null) || state.approvals.length > 0
    },
    notificationState(state): NotificationState {
      const store = this as unknown as NotificationStore
      const internal = getInternals(store)
      if (state.ownerId === null || state.identityStale || !internal.initialized) return 'unknown'
      const hasKnownAttention = state.watches.some(item => item.readAt === null) || state.approvals.length > 0
      if (hasKnownAttention) return 'available'
      if (
        !internal.watchesLoaded ||
        !internal.approvalsLoaded ||
        state.watchesLoading ||
        state.approvalsLoading ||
        state.watchesError !== '' ||
        state.approvalsError !== '' ||
        !state.watchesUnreadComplete ||
        state.approvalsNextCursor !== null
      ) {
        return 'unknown'
      }
      return 'clear'
    }
  },
  actions: {
    async initialize(ownerId: number | null | undefined): Promise<void> {
      const nextOwnerId = validOwnerId(ownerId)
      const state = getInternals(this)
      if (this.ownerId !== nextOwnerId) {
        state.generation += 1
        abortRequests(this)
        state.watches = undefined
        state.approvals = undefined
        state.initialized = false
        this.ownerId = nextOwnerId
        this.identityStale = false
        clearSourceState(this)
      }
      if (nextOwnerId === null || this.identityStale) {
        state.initialized = false
        return
      }
      state.initialized = true
      await this.refresh()
    },

    async refresh(): Promise<void> {
      if (this.ownerId === null || this.identityStale || !getInternals(this).initialized) return
      await Promise.all([this.refreshWatches(), this.refreshApprovals()])
    },

    refreshWatches(): Promise<void> {
      const ownerId = this.ownerId
      const state = getInternals(this)
      if (ownerId === null || this.identityStale || !state.initialized) return Promise.resolve()
      if (state.watches && state.watches.ownerId === ownerId && state.watches.generation === state.generation) return state.watches.promise

      const generation = state.generation
      const controller = new AbortController()
      const source: SourceRequest = { ownerId, generation, controller, promise: Promise.resolve() }
      this.watchesLoading = true
      this.watchesError = ''
      source.promise = fetchPageWatchNotifications(ownerId, undefined, controller.signal)
        .then(result => {
          if (!isCurrent(this, ownerId, generation)) return
          this.watches = result.items
          this.watchesNextCursor = result.nextCursor
          this.watchesUnreadComplete = result.unreadComplete
          state.watchesLoaded = true
        })
        .catch(error => {
          if (!isCurrent(this, ownerId, generation)) return
          if (identityInvalidated(error)) {
            invalidateIdentity(this, ownerId, generation)
            return
          }
          this.watchesError = errorMessage(error)
        })
        .finally(() => {
          if (!isCurrent(this, ownerId, generation)) return
          this.watchesLoading = false
          if (state.watches === source) state.watches = undefined
        })
      state.watches = source
      return source.promise
    },

    loadMoreWatches(): Promise<void> {
      const ownerId = this.ownerId
      const state = getInternals(this)
      if (ownerId === null || this.identityStale || !state.initialized) return Promise.resolve()
      if (state.watches && state.watches.ownerId === ownerId && state.watches.generation === state.generation) return state.watches.promise
      const cursor = this.watchesNextCursor
      if (cursor === null) return Promise.resolve()

      const generation = state.generation
      const controller = new AbortController()
      const source: SourceRequest = { ownerId, generation, controller, promise: Promise.resolve() }
      this.watchesLoading = true
      this.watchesError = ''
      source.promise = fetchPageWatchNotifications(ownerId, cursor, controller.signal)
        .then(result => {
          if (!isCurrent(this, ownerId, generation)) return
          appendWatches(this, result.items)
          this.watchesNextCursor = result.nextCursor
          this.watchesUnreadComplete = result.unreadComplete
          state.watchesLoaded = true
        })
        .catch(error => {
          if (!isCurrent(this, ownerId, generation)) return
          if (identityInvalidated(error)) {
            invalidateIdentity(this, ownerId, generation)
            return
          }
          this.watchesError = errorMessage(error)
        })
        .finally(() => {
          if (!isCurrent(this, ownerId, generation)) return
          this.watchesLoading = false
          if (state.watches === source) state.watches = undefined
        })
      state.watches = source
      return source.promise
    },

    refreshApprovals(): Promise<void> {
      const ownerId = this.ownerId
      const state = getInternals(this)
      if (ownerId === null || this.identityStale || !state.initialized) return Promise.resolve()
      if (state.approvals && state.approvals.ownerId === ownerId && state.approvals.generation === state.generation) return state.approvals.promise

      const generation = state.generation
      const controller = new AbortController()
      const source: SourceRequest = { ownerId, generation, controller, promise: Promise.resolve() }
      this.approvalsLoading = true
      this.approvalsError = ''
      source.promise = fetchPageApprovalInbox(ownerId, undefined, controller.signal)
        .then(result => {
          if (!isCurrent(this, ownerId, generation)) return
          this.approvals = result.items
          this.approvalsNextCursor = result.nextCursor
          state.approvalsLoaded = true
        })
        .catch(error => {
          if (!isCurrent(this, ownerId, generation)) return
          if (identityInvalidated(error)) {
            invalidateIdentity(this, ownerId, generation)
            return
          }
          this.approvalsError = errorMessage(error)
        })
        .finally(() => {
          if (!isCurrent(this, ownerId, generation)) return
          this.approvalsLoading = false
          if (state.approvals === source) state.approvals = undefined
        })
      state.approvals = source
      return source.promise
    },

    loadMoreApprovals(): Promise<void> {
      const ownerId = this.ownerId
      const state = getInternals(this)
      if (ownerId === null || this.identityStale || !state.initialized) return Promise.resolve()
      if (state.approvals && state.approvals.ownerId === ownerId && state.approvals.generation === state.generation) return state.approvals.promise
      const cursor = this.approvalsNextCursor
      if (cursor === null) return Promise.resolve()

      const generation = state.generation
      const controller = new AbortController()
      const source: SourceRequest = { ownerId, generation, controller, promise: Promise.resolve() }
      this.approvalsLoading = true
      this.approvalsError = ''
      source.promise = fetchPageApprovalInbox(ownerId, cursor, controller.signal)
        .then(result => {
          if (!isCurrent(this, ownerId, generation)) return
          appendApprovals(this, result.items)
          this.approvalsNextCursor = result.nextCursor
          state.approvalsLoaded = true
        })
        .catch(error => {
          if (!isCurrent(this, ownerId, generation)) return
          if (identityInvalidated(error)) {
            invalidateIdentity(this, ownerId, generation)
            return
          }
          this.approvalsError = errorMessage(error)
        })
        .finally(() => {
          if (!isCurrent(this, ownerId, generation)) return
          this.approvalsLoading = false
          if (state.approvals === source) state.approvals = undefined
        })
      state.approvals = source
      return source.promise
    },

    async markWatchRead(id: string): Promise<boolean> {
      const ownerId = this.ownerId
      const state = getInternals(this)
      if (ownerId === null || this.identityStale || !state.initialized) return false
      const generation = state.generation
      const controller = new AbortController()
      const request: ReadRequest = { ownerId, generation, controller }
      state.reads.add(request)
      try {
        await markPageWatchNotificationRead(ownerId, id, controller.signal)
      } catch (error) {
        if (isCurrent(this, ownerId, generation)) {
          if (identityInvalidated(error)) invalidateIdentity(this, ownerId, generation)
          else this.watchesError = errorMessage(error)
        }
        return false
      } finally {
        state.reads.delete(request)
      }
      if (!isCurrent(this, ownerId, generation)) return false
      const item = this.watches.find(candidate => candidate.id === id)
      if (item && item.readAt === null) item.readAt = new Date().toISOString()
      await this.refreshWatches()
      return isCurrent(this, ownerId, generation)
    },

    reset(): void {
      const state = getInternals(this)
      state.generation += 1
      state.initialized = false
      abortRequests(this)
      state.watches = undefined
      state.approvals = undefined
      this.ownerId = null
      this.identityStale = false
      clearSourceState(this)
    }
  }
})
