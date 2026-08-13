import { createPinia, defineStore } from 'pinia'
import Cookies from 'js-cookie'

export type Notification = {
  message: string
  style: string
  icon: string
  isActive: boolean
}

type UnknownRecord = Record<string, unknown>

const defaultPermissions = () => ({
  comments: { read: false, write: false, manage: false },
  history: { read: false },
  source: { read: false },
  pages: { write: false, manage: false, delete: false, script: false, style: false },
  system: { manage: false }
})

const decodeJwtPayload = (token: string): UnknownRecord => {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('JWT payload is missing.')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const decoded: unknown = JSON.parse(window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')))
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('JWT payload is invalid.')
  return decoded as UnknownRecord
}


export const pinia = createPinia()

export const useWikiStore = defineStore('wiki', {
  state: () => ({
    loadingStack: [] as string[],
    notification: {
      message: '',
      style: 'primary',
      icon: 'cached',
      isActive: false
    } as Notification,
    admin: {
      info: {
        currentVersion: 'n/a',
        latestVersion: 'n/a',
        groupsTotal: 0,
        pagesTotal: 0,
        usersTotal: 0,
        tagsTotal: 0
      }
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
      locale: 'en',
      path: '',
      publishEndDate: '',
      publishStartDate: '',
      tags: [] as string[],
      title: '',
      updatedAt: '',
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
      dark: window.siteConfig.darkMode,
      tocPosition: window.siteConfig.tocPosition,
      mascot: true,
      title: window.siteConfig.title,
      logoUrl: window.siteConfig.logoUrl,
      search: '',
      searchIsFocused: false,
      searchIsLoading: false,
      searchRestrictLocale: false,
      searchRestrictPath: false,
      printView: false
    },
    user: {
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
    }
  }),
  getters: {
    isLoading: state => state.loadingStack.length > 0
  },
  actions: {
    startLoading (name: string) {
      if (!this.loadingStack.includes(name)) this.loadingStack.push(name)
    },
    stopLoading (name: string) {
      this.loadingStack = this.loadingStack.filter(item => item !== name)
    },
    showNotification (options: Partial<Notification>) {
      this.notification = {
        message: '',
        style: 'primary',
        icon: 'cached',
        isActive: true,
        ...options
      }
    },
    setNotificationActive (isActive: boolean) {
      this.notification.isActive = isActive
    },
    showError (error: unknown) {
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
    refreshAuth () {
      const token = Cookies.get('jwt')
      if (!token) return
      try {
        const payload = decodeJwtPayload(token)
        this.user.id = typeof payload.id === 'number' ? payload.id : 0
        this.user.email = typeof payload.email === 'string' ? payload.email : ''
        this.user.name = typeof payload.name === 'string' ? payload.name : ''
        this.user.pictureUrl = typeof payload.av === 'string' ? payload.av : ''
        this.user.localeCode = typeof payload.lc === 'string' ? payload.lc : ''
        this.user.timezone = typeof payload.tz === 'string' ? payload.tz : Intl.DateTimeFormat().resolvedOptions().timeZone || ''
        this.user.dateFormat = typeof payload.df === 'string' ? payload.df : ''
        this.user.appearance = typeof payload.ap === 'string' ? payload.ap : ''
        this.user.permissions = Array.isArray(payload.permissions) ? payload.permissions.filter((permission): permission is string => typeof permission === 'string') : []
        this.user.iat = typeof payload.iat === 'number' ? payload.iat : 0
        this.user.exp = typeof payload.exp === 'number' ? payload.exp : 0
        this.user.authenticated = true
      } catch {
        console.debug('Invalid JWT. Silent authentication skipped.')
      }
    },
    pushMediaFolder (folder: unknown) {
      this.editor.media.folderTree.push(folder)
    },
    popMediaFolder () {
      this.editor.media.folderTree.pop()
    },
  }
})

export const wikiStore = useWikiStore(pinia)

export type WikiStore = typeof wikiStore

