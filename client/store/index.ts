import { createPinia, defineStore } from 'pinia'
import { sameOriginJsonFetch } from '../helpers/json-transport.ts'
import {
  invalidateOfflineSession,
  lockOfflineReading,
  registerOfflineIdentityBoundaryOwner,
  registerOfflineSessionInvalidationOwner,
  type OfflineIdentityBoundaryReason,
  type OfflineIdentityBoundaryRequest
} from '../helpers/offline-session.ts'
import { openOfflineStorage, type OfflineStorage } from '../helpers/offline-storage.ts'
import type { PageOkfView } from '../helpers/pages-api.ts'
import type { SystemSummary } from '../helpers/system-api.ts'
import { isUserTimeFormat, normalizeUserFontFamily, type UserTimeFormat } from '../../shared/user-presentation.ts'
import type { PageBrandingAssignment, PageBrandingView } from '../../shared/page-branding.ts'
export type Notification = {
  message: string
  style: string
  icon: string
  isActive: boolean
}

const defaultUser = () => ({
  id: 0,
  email: '',
  name: '',
  pictureUrl: '',
  localeCode: '',
  defaultEditor: '',
  timezone: '',
  dateFormat: '',
  timeFormat: 'locale' as UserTimeFormat,
  appearance: '',
  fontFamily: normalizeUserFontFamily(undefined),
  permissions: [] as string[],
  authVersion: 0,
  iat: 0,
  exp: 0,
  authenticated: false
})

const defaultPermissions = () => ({
  comments: { read: false, write: false, manage: false },
  history: { read: false },
  source: { read: false },
  pages: { write: false, manage: false, delete: false, script: false, style: false },
  system: { manage: false }
})
const defaultPageOkf = (): PageOkfView => ({
  authority: { state: 'invalid', metadata: null, trust: null },
  projection: { state: 'pending', value: null }
})

export const pinia = createPinia()
type WhoAmIResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

type AuthenticatedWhoAmIUser = Record<string, unknown> & {
  id: number
  authVersion: number
}

type WhoAmIPayload = { authenticated: true; user: AuthenticatedWhoAmIUser } | { authenticated: false; user: null }

const isNonnegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const parseWhoAmIPayload = (value: unknown): WhoAmIPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.authenticated === false && record.user === null) return { authenticated: false, user: null }
  if (record.authenticated !== true || !record.user || typeof record.user !== 'object' || Array.isArray(record.user)) return null
  const user = record.user as Record<string, unknown>
  if (!isPositiveAccountId(user.id) || !isNonnegativeSafeInteger(user.authVersion)) return null
  return { authenticated: true, user: user as AuthenticatedWhoAmIUser }
}

export type AuthRefreshOutcome = 'authenticated' | 'anonymous' | 'unavailable'

type AuthOutcomeEvent = {
  outcome: AuthRefreshOutcome
  accountChanged: boolean
}

const dispatchAuthOutcome = (outcome: AuthRefreshOutcome, accountChanged: boolean): void => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return
  try {
    window.dispatchEvent(
      new CustomEvent<AuthOutcomeEvent>('tsepistle:auth-outcome', {
        detail: { outcome, accountChanged }
      })
    )
  } catch {
    // The auth result remains authoritative even if an optional observer fails.
  }
}

const isPositiveAccountId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const OFFLINE_LOGOUT_PENDING_STORAGE_KEY = 'tsepistle.offline-logout-pending.v1'
export const OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE = 'Offline identity cleanup failed. Reconnect and try again.'

type PendingOfflineLogout = {
  readonly present: boolean
  readonly accountId: number | undefined
}

const offlineLogoutStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    const storage = window.localStorage
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof storage.removeItem === 'function'
      ? storage
      : null
  } catch {
    return null
  }
}

const pendingOfflineLogout = (): PendingOfflineLogout => {
  const storage = offlineLogoutStorage()
  if (!storage) return { present: false, accountId: undefined }
  try {
    const raw = storage.getItem(OFFLINE_LOGOUT_PENDING_STORAGE_KEY)
    if (raw === null) return { present: false, accountId: undefined }
    const accountId = Number(raw)
    return {
      present: true,
      accountId: isPositiveAccountId(accountId) ? accountId : undefined
    }
  } catch {
    return { present: true, accountId: undefined }
  }
}

export const markOfflineLogoutPending = (accountId?: number): boolean => {
  const storage = offlineLogoutStorage()
  if (!storage) return false
  try {
    const marker = isPositiveAccountId(accountId) ? String(accountId) : 'pending'
    storage.setItem(OFFLINE_LOGOUT_PENDING_STORAGE_KEY, marker)
    return storage.getItem(OFFLINE_LOGOUT_PENDING_STORAGE_KEY) === marker
  } catch {
    return false
  }
}

const clearOfflineLogoutPending = (): void => {
  try {
    offlineLogoutStorage()?.removeItem(OFFLINE_LOGOUT_PENDING_STORAGE_KEY)
  } catch {
    // A failed optional marker cleanup cannot restore private access.
  }
}

export const resolvePendingOfflineLogoutAfterExplicitSignIn = (): void => {
  clearOfflineLogoutPending()
}

export const hasOfflineLogoutPending = (): boolean => pendingOfflineLogout().present

const currentOfflineOrigin = (): string => {
  if (typeof window === 'undefined') return ''
  try {
    const value = window.location?.origin
    if (typeof value !== 'string' || value.length < 1) return ''
    return new URL(value).origin
  } catch {
    return ''
  }
}

const currentOfflineSiteId = (origin: string): string => {
  if (typeof window === 'undefined') return origin
  try {
    const configured = Reflect.get(Reflect.get(window, 'siteConfig') ?? {}, 'offlineDraftSiteId')
    return typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : origin
  } catch {
    return origin
  }
}

const isMatchingReadingVault = (vault: unknown, accountId: number, authVersion: number): boolean => {
  if (!vault || typeof vault !== 'object' || Array.isArray(vault)) return false
  const context = Reflect.get(vault, 'context')
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false
  const origin = currentOfflineOrigin()
  const siteId = currentOfflineSiteId(origin)
  return (
    origin.length > 0 &&
    Reflect.get(context, 'canonicalOrigin') === origin &&
    Reflect.get(context, 'siteId') === siteId &&
    Reflect.get(context, 'accountId') === accountId &&
    Reflect.get(context, 'authVersion') === authVersion
  )
}

const inspectPersistedReadingVault = async (accountId: number | undefined, authVersion?: number): Promise<boolean | null> => {
  let storage: OfflineStorage | null = null
  try {
    storage = await openOfflineStorage()
    const getReadingVault = Reflect.get(storage, 'getReadingVault')
    if (typeof getReadingVault !== 'function') return true
    const vault = await getReadingVault.call(storage)
    if (vault === null || vault === undefined) return true
    return accountId !== undefined && authVersion !== undefined && isMatchingReadingVault(vault, accountId, authVersion)
  } catch {
    return null
  } finally {
    storage?.close()
  }
}

/**
 * Establishes one local identity boundary for an explicit logout, confirmed
 * account switch, or verified anonymous result. The synchronous session fence
 * runs before storage/network callbacks; the persisted generation and ordinary
 * account purge commit through one storage transaction.
 *
 * Boundaries raised by a failed draft-key acquisition or an authoritative
 * unauthorized response advance only the persisted generation. Their opaque
 * drafts and immutable receipts remain available for explicit same-account
 * recovery; explicit auth transitions still purge ordinary drafts only.
 */
type OfflineIdentityBoundaryMode = 'advance' | 'purge'
type OfflineIdentityBoundaryFlight = {
  readonly accountId: number | undefined
  readonly mode: OfflineIdentityBoundaryMode
  readonly promise: Promise<boolean>
}

let identityBoundaryTail: Promise<boolean> = Promise.resolve(true)
const identityBoundaryFlights: OfflineIdentityBoundaryFlight[] = []
let identityBoundarySetupLocked = false
let offlineIdentityEpoch = 0
let syncOfflineIdentityEpoch: ((epoch: number) => void) | undefined

const advanceOfflineIdentityEpoch = (): void => {
  const nextEpoch = offlineIdentityEpoch + 1
  if (!Number.isSafeInteger(nextEpoch)) throw new Error('Offline identity epoch overflowed.')
  offlineIdentityEpoch = nextEpoch
  syncOfflineIdentityEpoch?.(nextEpoch)
}

const runOfflineIdentityBoundary = async (accountId: number | undefined, mode: OfflineIdentityBoundaryMode): Promise<boolean> => {
  let storage: OfflineStorage | null = null
  try {
    storage = await openOfflineStorage()
    const currentGeneration = await storage.currentSessionGeneration()
    if (mode === 'purge' && accountId !== undefined) {
      await storage.invalidateAccountSession(accountId, {
        expectedSessionGeneration: currentGeneration
      })
    } else {
      await storage.bumpSessionGeneration(undefined, {
        expectedSessionGeneration: currentGeneration
      })
    }
    return true
  } catch {
    return false
  } finally {
    storage?.close()
  }
}

export const invalidateOfflineIdentity = (accountId?: number, reason?: OfflineIdentityBoundaryReason): Promise<boolean> => {
  const normalizedAccountId = accountId !== undefined && isPositiveAccountId(accountId) ? accountId : undefined
  const mode: OfflineIdentityBoundaryMode =
    reason === 'draft-key-denied' || reason === 'unauthorized' || normalizedAccountId === undefined ? 'advance' : 'purge'

  if (mode === 'advance') {
    for (let index = identityBoundaryFlights.length - 1; index >= 0; index -= 1) {
      const flight = identityBoundaryFlights[index]
      if (flight?.mode === 'purge' && flight.accountId === normalizedAccountId) return flight.promise
    }
  }
  for (let index = identityBoundaryFlights.length - 1; index >= 0; index -= 1) {
    const flight = identityBoundaryFlights[index]
    if (flight?.mode === mode && flight.accountId === normalizedAccountId) return flight.promise
  }
  if (identityBoundarySetupLocked) return Promise.resolve(false)

  identityBoundarySetupLocked = true
  try {
    lockOfflineReading()
    advanceOfflineIdentityEpoch()
    invalidateOfflineSession()
    const previous = identityBoundaryTail
    const operation = previous.then(
      () => runOfflineIdentityBoundary(normalizedAccountId, mode),
      () => runOfflineIdentityBoundary(normalizedAccountId, mode)
    )
    let settled: Promise<boolean>
    settled = operation.finally(() => {
      const index = identityBoundaryFlights.findIndex(flight => flight.promise === settled)
      if (index >= 0) identityBoundaryFlights.splice(index, 1)
    })
    const flight: OfflineIdentityBoundaryFlight = {
      accountId: normalizedAccountId,
      mode,
      promise: settled
    }
    identityBoundaryFlights.push(flight)
    const tail = settled.then(
      () => true,
      () => true
    )
    identityBoundaryTail = tail
    void tail.then(() => {
      if (identityBoundaryTail === tail && identityBoundaryFlights.length === 0) identityBoundaryTail = Promise.resolve(true)
    })
    return settled
  } finally {
    identityBoundarySetupLocked = false
  }
}
let authRefresh: Promise<AuthRefreshOutcome> | undefined
let authRefreshLifetime = 0
export const useWikiStore = defineStore('wiki', {
  state: () => ({
    loadingCounts: {} as Record<string, number>,
    notification: {
      message: '',
      style: 'primary',
      icon: 'cached',
      isActive: false
    } as Notification,
    admin: {
      info: {
        product: window.siteConfig.product,
        currentVersion: window.siteConfig.product.version,
        latestVersion: null,
        latestVersionReleaseDate: null,
        updateStatus: 'unavailable',
        groupsTotal: 0,
        pagesTotal: 0,
        usersTotal: 0,
        tagsTotal: 0
      } as SystemSummary
    },
    editor: {
      id: 0,
      editor: '',
      editorKey: '',
      content: '',
      mode: 'create',
      activeModal: '',
      activeModalData: null as unknown,
      media: {
        folderTree: [] as unknown[],
        currentFolderId: 0,
        currentFileId: null as number | null
      },
      checkoutDateActive: ''
    },
    page: {
      id: 0,
      authorId: 0,
      authorName: 'Unknown',
      createdAt: '',
      description: '',
      isPublished: true,
      isSearchable: true,
      visibility: 'public' as 'public' | 'private',
      ownerId: null as number | null,
      locale: 'en',
      path: '',
      publishEndDate: '',
      publishStartDate: '',
      tags: [] as string[],
      title: '',
      updatedAt: '',
      sourceRevision: '',
      editor: '',
      mode: '',
      scriptJs: '',
      scriptCss: '',
      effectivePermissions: defaultPermissions(),
      commentsCount: 0,
      editShortcuts: {
        editFab: false,
        editMenuBar: false,
        editMenuBtn: false,
        editMenuExternalBtn: false,
        editMenuExternalName: '',
        editMenuExternalIcon: '',
        editMenuExternalUrl: ''
      },
      brandingAssignment: null as PageBrandingAssignment | null,
      brandingView: null as PageBrandingView | null,
      okf: defaultPageOkf(),
      okfLoading: false,
      okfError: null as string | null
    },
    site: {
      company: window.siteConfig.company,
      contentLicense: window.siteConfig.contentLicense,
      footerOverride: window.siteConfig.footerOverride,
      banner: window.siteConfig.banner,
      dark: window.siteConfig.darkMode,
      tocPosition: window.siteConfig.tocPosition,
      mascot: true,
      title: window.siteConfig.title,
      logoUrl: window.siteConfig.logoUrl,
      product: window.siteConfig.product,
      search: '',
      searchMode: 'search' as 'search' | 'ask',
      searchIsFocused: false,
      searchIsLoading: false,
      searchRestrictLocale: false,
      searchRestrictPath: false,
      printView: false
    },
    authRefreshPending: false,
    authRefreshSettled: false,
    authRefreshOutcome: null as AuthRefreshOutcome | null,
    offlineIdentityReady: false,
    offlineIdentityEpoch,
    user: defaultUser()
  }),
  getters: {
    isLoading: state => Object.keys(state.loadingCounts).length > 0
  },
  actions: {
    startLoading(name: string) {
      this.loadingCounts[name] = (this.loadingCounts[name] ?? 0) + 1
    },
    stopLoading(name: string) {
      const count = this.loadingCounts[name]
      if (count === undefined) return
      if (count === 1) delete this.loadingCounts[name]
      else this.loadingCounts[name] = count - 1
    },
    showNotification(options: Partial<Notification>) {
      this.notification = {
        message: '',
        style: 'primary',
        icon: 'cached',
        isActive: true,
        ...options
      }
    },
    setNotificationActive(isActive: boolean) {
      this.notification.isActive = isActive
    },
    showError(error: unknown) {
      let message = String(error)
      if (error instanceof Error) {
        message = error.message
      } else if (error && typeof error === 'object') {
        const graphQLErrors = Reflect.get(error, 'graphQLErrors')
        const firstError = Array.isArray(graphQLErrors) ? graphQLErrors[0] : undefined
        const graphMessage = firstError && typeof firstError === 'object' ? Reflect.get(firstError, 'message') : undefined
        const errorMessage = Reflect.get(error, 'message')
        if (typeof graphMessage === 'string') message = graphMessage
        else if (typeof errorMessage === 'string') message = errorMessage
      }
      this.showNotification({ style: 'red', message, icon: 'alert' })
    },
    refreshAuth(): Promise<AuthRefreshOutcome> {
      if (authRefresh) return authRefresh
      const nextAuthRefreshLifetime = authRefreshLifetime + 1
      if (!Number.isSafeInteger(nextAuthRefreshLifetime)) throw new Error('Auth refresh lifetime overflowed.')
      authRefreshLifetime = nextAuthRefreshLifetime
      const refreshLifetime = nextAuthRefreshLifetime
      let capturedOfflineIdentityEpoch = this.offlineIdentityEpoch
      const isCurrentRefresh = (): boolean => authRefreshLifetime === refreshLifetime && this.offlineIdentityEpoch === capturedOfflineIdentityEpoch
      const settleStale = (): AuthRefreshOutcome => {
        if (authRefreshLifetime === refreshLifetime) {
          this.authRefreshPending = false
          this.authRefreshSettled = true
        }
        return 'unavailable'
      }
      const authWasSettled = this.authRefreshSettled
      const pendingLogoutAtStart = pendingOfflineLogout()
      const previousAccountIdAtStart = this.user.authenticated && isPositiveAccountId(this.user.id) ? this.user.id : undefined
      const pendingLogoutBlocksWarmIdentity =
        pendingLogoutAtStart.present && (pendingLogoutAtStart.accountId === undefined || pendingLogoutAtStart.accountId === previousAccountIdAtStart)
      if (pendingLogoutBlocksWarmIdentity) lockOfflineReading()
      const warmIdentityAtStart = previousAccountIdAtStart !== undefined && this.offlineIdentityReady && !pendingLogoutBlocksWarmIdentity
      this.authRefreshPending = true
      this.authRefreshSettled = false
      this.authRefreshOutcome = null
      // A verification attempt fences protected online work, but keeps a
      // previously verified actor/key boundary available for local capture.
      this.offlineIdentityReady = warmIdentityAtStart

      const publishOutcome = (outcome: AuthRefreshOutcome, accountChanged: boolean): boolean => {
        if (!isCurrentRefresh()) return false
        this.authRefreshPending = false
        this.authRefreshSettled = true
        this.authRefreshOutcome = outcome
        dispatchAuthOutcome(outcome, accountChanged)
        return true
      }

      const beginBoundary = (accountId: number | undefined, reason?: OfflineIdentityBoundaryReason): Promise<boolean> | null => {
        if (!isCurrentRefresh()) return null
        const boundary = invalidateOfflineIdentity(accountId, reason)
        // A boundary started by this refresh is authoritative for its own
        // response. Any later external boundary changes the epoch again and
        // therefore still fences this refresh.
        capturedOfflineIdentityEpoch = this.offlineIdentityEpoch
        return boundary
      }

      const settleAnonymous = async (
        outcome: Exclude<AuthRefreshOutcome, 'authenticated'>,
        reason?: OfflineIdentityBoundaryReason
      ): Promise<AuthRefreshOutcome> => {
        if (!isCurrentRefresh()) return settleStale()
        const previousAccountId = this.user.authenticated && isPositiveAccountId(this.user.id) ? this.user.id : undefined
        if (outcome === 'unavailable') {
          // Transport, server, and malformed verification results are not
          // proof of logout. Keep the verified actor and warm local boundary;
          // every protected online consumer still sees the unavailable
          // outcome and must wait for a fresh verification.
          return publishOutcome(outcome, false) ? outcome : settleStale()
        }
        let boundary: Promise<boolean> | null = null
        if (previousAccountId !== undefined) {
          boundary = beginBoundary(previousAccountId, reason)
          if (boundary === null) return settleStale()
        } else if (reason === 'unauthorized') {
          const vaultReady = await inspectPersistedReadingVault(undefined)
          if (!isCurrentRefresh()) return settleStale()
          if (vaultReady === null) {
            lockOfflineReading()
            this.user = defaultUser()
            this.offlineIdentityReady = false
            this.showNotification({
              style: 'red',
              message: OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE,
              icon: 'alert'
            })
            return publishOutcome('unavailable', false) ? 'unavailable' : settleStale()
          }
          if (!vaultReady) {
            boundary = beginBoundary(undefined, reason)
            if (boundary === null) return settleStale()
          }
        }
        if (!isCurrentRefresh()) return settleStale()
        this.user = defaultUser()
        this.offlineIdentityReady = false
        if (boundary !== null) {
          const boundaryReady = await boundary
          if (!isCurrentRefresh()) return settleStale()
          if (!boundaryReady) {
            this.showNotification({
              style: 'red',
              message: OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE,
              icon: 'alert'
            })
            return publishOutcome('unavailable', previousAccountId !== undefined) ? 'unavailable' : settleStale()
          }
        }
        clearOfflineLogoutPending()
        return publishOutcome(outcome, previousAccountId !== undefined) ? outcome : settleStale()
      }

      const refresh = (async (): Promise<AuthRefreshOutcome> => {
        try {
          const response = (await sameOriginJsonFetch(window.fetch.bind(window), '/_api/users/whoami', {
            credentials: 'same-origin',
            cache: 'no-store'
          })) as WhoAmIResponse
          if (!isCurrentRefresh()) return settleStale()
          if (!response.ok) {
            return await settleAnonymous(response.status === 401 ? 'anonymous' : 'unavailable', response.status === 401 ? 'unauthorized' : undefined)
          }
          const payload = parseWhoAmIPayload(await response.json())
          if (!isCurrentRefresh()) return settleStale()
          if (!payload) return await settleAnonymous('unavailable')
          if (payload.authenticated === false) return await settleAnonymous('anonymous', 'unauthorized')
          const profile = payload.user
          const id = profile.id
          if (!isCurrentRefresh()) return settleStale()
          const previousAuthenticatedId = this.user.authenticated && isPositiveAccountId(this.user.id) ? this.user.id : null
          const authVersion = profile.authVersion
          const accountChanged = previousAuthenticatedId !== null && previousAuthenticatedId !== id
          const passiveLogin = authWasSettled && previousAuthenticatedId === null
          const securityVersionChanged = previousAuthenticatedId === id && Number.isSafeInteger(this.user.authVersion) && this.user.authVersion !== authVersion
          const pendingLogout = pendingOfflineLogout()
          if (
            pendingLogout.present &&
            (pendingLogout.accountId === undefined || pendingLogout.accountId === id) &&
            (previousAuthenticatedId === null || previousAuthenticatedId === id) &&
            !accountChanged
          ) {
            this.user = defaultUser()
            this.offlineIdentityReady = false
            this.showNotification({
              style: 'red',
              message: OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE,
              icon: 'alert'
            })
            return publishOutcome('unavailable', false) ? 'unavailable' : settleStale()
          }
          if (accountChanged) {
            this.user = defaultUser()
            this.offlineIdentityReady = false
          }
          let boundaryReady = true
          if (accountChanged || passiveLogin || securityVersionChanged) {
            const boundary = beginBoundary(
              accountChanged || securityVersionChanged ? (previousAuthenticatedId ?? undefined) : undefined,
              securityVersionChanged ? 'unauthorized' : undefined
            )
            if (boundary === null) return settleStale()
            boundaryReady = await boundary
            if (!isCurrentRefresh()) return settleStale()
          } else if (!accountChanged && !passiveLogin) {
            const vaultMatches = await inspectPersistedReadingVault(id, authVersion)
            if (!isCurrentRefresh()) return settleStale()
            if (vaultMatches === null) {
              lockOfflineReading()
              boundaryReady = false
            } else if (!vaultMatches) {
              const boundary = beginBoundary(id, 'unauthorized')
              if (boundary === null) return settleStale()
              boundaryReady = await boundary
              if (!isCurrentRefresh()) return settleStale()
            }
          }
          if (!boundaryReady) {
            this.user = defaultUser()
            this.offlineIdentityReady = false
            this.showNotification({
              style: 'red',
              message: OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE,
              icon: 'alert'
            })
            return publishOutcome('unavailable', false) ? 'unavailable' : settleStale()
          }
          if (!isCurrentRefresh()) return settleStale()
          this.user = {
            ...defaultUser(),
            id,
            email: typeof profile.email === 'string' ? profile.email : '',
            name: typeof profile.name === 'string' ? profile.name : '',
            pictureUrl: typeof profile.pictureUrl === 'string' ? profile.pictureUrl : '',
            localeCode: typeof profile.localeCode === 'string' ? profile.localeCode : '',
            defaultEditor: typeof profile.defaultEditor === 'string' ? profile.defaultEditor : '',
            timezone: typeof profile.timezone === 'string' ? profile.timezone : '',
            timeFormat: isUserTimeFormat(profile.timeFormat) ? profile.timeFormat : 'locale',
            dateFormat: typeof profile.dateFormat === 'string' ? profile.dateFormat : '',
            appearance: typeof profile.appearance === 'string' ? profile.appearance : '',
            fontFamily: normalizeUserFontFamily(profile.fontFamily),
            permissions: Array.isArray(profile.permissions)
              ? profile.permissions.filter((permission): permission is string => typeof permission === 'string')
              : [],
            authVersion,
            authenticated: true
          }
          this.offlineIdentityReady = true
          return publishOutcome('authenticated', accountChanged) ? 'authenticated' : settleStale()
        } catch {
          if (!isCurrentRefresh()) return settleStale()
          return await settleAnonymous('unavailable')
        }
      })()

      const settled = refresh.then(
        outcome => outcome,
        error => {
          if (authRefreshLifetime === refreshLifetime) {
            this.authRefreshPending = false
            this.authRefreshSettled = true
          }
          throw error
        }
      )
      const inFlight = settled.finally(() => {
        if (authRefresh === inFlight) authRefresh = undefined
      })
      authRefresh = inFlight
      return inFlight
    },
    waitForAuthRefresh(): Promise<AuthRefreshOutcome | null> {
      return authRefresh ?? Promise.resolve(this.authRefreshOutcome)
    },
    pushMediaFolder(folder: unknown) {
      this.editor.media.folderTree.push(folder)
    },
    popMediaFolder() {
      this.editor.media.folderTree.pop()
    }
  }
})

export const wikiStore = useWikiStore(pinia)
syncOfflineIdentityEpoch = epoch => {
  wikiStore.offlineIdentityEpoch = epoch
  wikiStore.offlineIdentityReady = false
}
registerOfflineSessionInvalidationOwner(() => {
  advanceOfflineIdentityEpoch()
  wikiStore.offlineIdentityReady = false
})
registerOfflineIdentityBoundaryOwner((request: OfflineIdentityBoundaryRequest) => invalidateOfflineIdentity(request.accountId, request.reason))

export type WikiStore = typeof wikiStore
