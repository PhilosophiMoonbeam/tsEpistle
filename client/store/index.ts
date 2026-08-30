import { createPinia, defineStore } from 'pinia'
import Cookies from 'js-cookie'
import { decodeJwtPayload } from '../helpers/jwt.ts'
import { registerJsonPrincipalRefresh } from '../helpers/json-transport.ts'
import type { SystemSummary } from '../helpers/system-api.ts'

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

export const pinia = createPinia()

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
      }
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
    refreshAuth() {
      this.user = defaultUser()
      const token = Cookies.get('jwt')
      if (!token) return
      try {
        const payload = decodeJwtPayload(token)
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) {
          Cookies.remove('jwt')
          return
        }
        this.user.id = typeof payload.id === 'number' ? payload.id : 0
        this.user.email = typeof payload.email === 'string' ? payload.email : ''
        this.user.name = typeof payload.name === 'string' ? payload.name : ''
        this.user.pictureUrl = typeof payload.av === 'string' ? payload.av : ''
        this.user.localeCode = typeof payload.lc === 'string' ? payload.lc : ''
        this.user.timezone = typeof payload.tz === 'string' ? payload.tz : Intl.DateTimeFormat().resolvedOptions().timeZone || ''
        this.user.dateFormat = typeof payload.df === 'string' ? payload.df : ''
        this.user.appearance = typeof payload.ap === 'string' ? payload.ap : ''
        this.user.permissions = Array.isArray(payload.permissions)
          ? payload.permissions.filter((permission): permission is string => typeof permission === 'string')
          : []
        this.user.iat = typeof payload.iat === 'number' ? payload.iat : 0
        this.user.exp = payload.exp
        this.user.authenticated = true
      } catch {
        Cookies.remove('jwt')
        console.debug('Invalid JWT. Silent authentication skipped.')
      }
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
registerJsonPrincipalRefresh(() => wikiStore.refreshAuth())

export type WikiStore = typeof wikiStore
