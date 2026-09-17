import { createPinia, defineStore } from 'pinia'
import { sameOriginJsonFetch } from '../helpers/json-transport.ts'
import {
  invalidateOfflineSession,
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
      const previousAccountIdAtStart = this.user.authenticated && isPositiveAccountId(this.user.id) ? this.user.id : undefined
      const warmIdentityAtStart = previousAccountIdAtStart !== undefined && this.offlineIdentityReady
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
        const boundary = previousAccountId === undefined ? null : beginBoundary(previousAccountId, reason)
        if (previousAccountId !== undefined && boundary === null) return settleStale()
        if (!isCurrentRefresh()) return settleStale()
        this.user = defaultUser()
        this.offlineIdentityReady = false
        if (boundary !== null) {
          await boundary
          if (!isCurrentRefresh()) return settleStale()
        }
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
          const payload = await response.json()
          if (!isCurrentRefresh()) return settleStale()
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return await settleAnonymous('unavailable')
          const record = payload as Record<string, unknown>
          if (record.authenticated === false) return await settleAnonymous('anonymous', 'unauthorized')
          if (record.authenticated !== true) return await settleAnonymous('unavailable')
          const user = record.user
          if (!user || typeof user !== 'object' || Array.isArray(user)) return await settleAnonymous('unavailable')
          const profile = user as Record<string, unknown>
          const id = profile.id
          if (!isPositiveAccountId(id)) return await settleAnonymous('unavailable')
          if (!isCurrentRefresh()) return settleStale()
          const previousAuthenticatedId = this.user.authenticated && isPositiveAccountId(this.user.id) ? this.user.id : null
          const accountChanged = previousAuthenticatedId !== null && previousAuthenticatedId !== id
          const passiveLogin = authWasSettled && previousAuthenticatedId === null
          if (accountChanged) {
            this.user = defaultUser()
            this.offlineIdentityReady = false
          }
          let boundaryReady = true
          if (accountChanged || passiveLogin) {
            const boundary = beginBoundary(accountChanged ? (previousAuthenticatedId ?? undefined) : undefined)
            if (boundary === null) return settleStale()
            boundaryReady = await boundary
            if (!isCurrentRefresh()) return settleStale()
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
            authenticated: true
          }
          this.offlineIdentityReady = boundaryReady
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
