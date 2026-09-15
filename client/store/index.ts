import { createPinia, defineStore } from 'pinia'
import { sameOriginJsonFetch } from '../helpers/json-transport.ts'
import { invalidateOfflineSession } from '../helpers/offline-session.ts'
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
 * Establishes the persisted identity boundary before an auth transition is
 * published. Immutable submission receipts deliberately survive the purge.
 */
export const invalidateOfflineIdentity = async (accountId?: number): Promise<boolean> => {
  invalidateOfflineSession()
  let storage: OfflineStorage | null = null
  try {
    storage = await openOfflineStorage()
    const currentGeneration = await storage.currentSessionGeneration()
    const nextGeneration = await storage.bumpSessionGeneration(undefined, {
      expectedSessionGeneration: currentGeneration
    })
    if (accountId !== undefined && accountId > 0) {
      await storage.purgeAccount(accountId, { expectedSessionGeneration: nextGeneration })
    }
    return true
  } catch {
    return false
  } finally {
    storage?.close()
  }
}
let authRefresh: Promise<AuthRefreshOutcome> | undefined
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
      const authWasSettled = this.authRefreshSettled
      this.authRefreshPending = true
      this.authRefreshSettled = false
      this.authRefreshOutcome = null
      this.offlineIdentityReady = false

      const publishOutcome = (outcome: AuthRefreshOutcome, accountChanged: boolean): void => {
        this.authRefreshPending = false
        this.authRefreshSettled = true
        this.authRefreshOutcome = outcome
        dispatchAuthOutcome(outcome, accountChanged)
      }

      const settleAnonymous = async (outcome: Exclude<AuthRefreshOutcome, 'authenticated'>): Promise<AuthRefreshOutcome> => {
        const previousAccountId = this.user.authenticated && this.user.id > 0 ? this.user.id : undefined
        if (previousAccountId !== undefined) await invalidateOfflineIdentity(previousAccountId)
        this.user = defaultUser()
        this.offlineIdentityReady = false
        publishOutcome(outcome, previousAccountId !== undefined)
        return outcome
      }

      const refresh = (async (): Promise<AuthRefreshOutcome> => {
        try {
          const response = (await sameOriginJsonFetch(window.fetch.bind(window), '/_api/users/whoami', {
            credentials: 'same-origin',
            cache: 'no-store'
          })) as WhoAmIResponse
          if (!response.ok) return await settleAnonymous('unavailable')
          const payload = await response.json()
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return await settleAnonymous('unavailable')
          const record = payload as Record<string, unknown>
          if (record.authenticated === false) return await settleAnonymous('anonymous')
          if (record.authenticated !== true) return await settleAnonymous('unavailable')
          const user = record.user
          if (!user || typeof user !== 'object' || Array.isArray(user)) return await settleAnonymous('unavailable')
          const profile = user as Record<string, unknown>
          const id = profile.id
          if (!isPositiveAccountId(id)) return await settleAnonymous('unavailable')

          const previousAuthenticatedId = this.user.authenticated && this.user.id > 0 ? this.user.id : null
          const accountChanged = previousAuthenticatedId !== null && previousAuthenticatedId !== id
          const passiveLogin = authWasSettled && previousAuthenticatedId === null
          const boundaryReady = accountChanged || passiveLogin ? await invalidateOfflineIdentity(accountChanged ? previousAuthenticatedId : undefined) : true
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
          publishOutcome('authenticated', accountChanged)
          return 'authenticated'
        } catch {
          return await settleAnonymous('unavailable')
        }
      })()

      const settled = refresh.then(
        outcome => outcome,
        error => {
          this.authRefreshPending = false
          this.authRefreshSettled = true
          this.authRefreshOutcome = 'unavailable'
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

export type WikiStore = typeof wikiStore
