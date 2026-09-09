import { createPinia, defineStore } from 'pinia'
import { sameOriginJsonFetch } from '../helpers/json-transport.ts'
import type { PageOkfView } from '../helpers/pages-api.ts'
import type { SystemSummary } from '../helpers/system-api.ts'
import { normalizeUserFontFamily } from '../../shared/user-presentation.ts'
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

let authRefresh: Promise<void> | undefined
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
    async refreshAuth(): Promise<void> {
      if (authRefresh) return authRefresh

      const refresh = (async () => {
        try {
          const response = await sameOriginJsonFetch(
            window.fetch.bind(window),
            '/_api/users/whoami',
            { credentials: 'same-origin', cache: 'no-store' }
          ) as WhoAmIResponse
          const payload = await response.json()
          if (!response.ok || !payload || typeof payload !== 'object') {
            this.user = defaultUser()
            return
          }
          const record = payload as Record<string, unknown>
          const user = record.user
          if (record.authenticated !== true || !user || typeof user !== 'object') {
            this.user = defaultUser()
            return
          }
          const profile = user as Record<string, unknown>
          this.user = {
            ...defaultUser(),
            id: typeof profile.id === 'number' ? profile.id : 0,
            email: typeof profile.email === 'string' ? profile.email : '',
            name: typeof profile.name === 'string' ? profile.name : '',
            pictureUrl: typeof profile.pictureUrl === 'string' ? profile.pictureUrl : '',
            localeCode: typeof profile.localeCode === 'string' ? profile.localeCode : '',
            defaultEditor: typeof profile.defaultEditor === 'string' ? profile.defaultEditor : '',
            timezone: typeof profile.timezone === 'string' ? profile.timezone : '',
            dateFormat: typeof profile.dateFormat === 'string' ? profile.dateFormat : '',
            appearance: typeof profile.appearance === 'string' ? profile.appearance : '',
            fontFamily: normalizeUserFontFamily(profile.fontFamily),
            permissions: Array.isArray(profile.permissions)
              ? profile.permissions.filter((permission): permission is string => typeof permission === 'string')
              : [],
            authenticated: true
          }
        } catch {
          this.user = defaultUser()
        }
      })()

      const inFlight = refresh.finally(() => {
        if (authRefresh === inFlight) authRefresh = undefined
      })
      authRefresh = inFlight
      return inFlight
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
