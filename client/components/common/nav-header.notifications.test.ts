import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/wiki/page'
})
const browserWindow = dom.window
const browserGlobals: Record<string, unknown> = {
  document: browserWindow.document,
  window: browserWindow,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement
}
const browserGlobalRestorations: Array<() => void> = []
const installBrowserGlobals = (): void => {
  const previousDescriptors: Record<string, PropertyDescriptor | undefined> = {}
  for (const [name, value] of Object.entries(browserGlobals)) {
    previousDescriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  browserGlobalRestorations.push(() => {
    for (const name of Object.keys(browserGlobals)) {
      const descriptor = previousDescriptors[name]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
}
if (!browserWindow.requestAnimationFrame) {
  browserWindow.requestAnimationFrame = callback => browserWindow.setTimeout(callback, 0)
  browserWindow.cancelAnimationFrame = handle => browserWindow.clearTimeout(handle)
}

// The custom renderer below is bound to browserWindow, so Vue can load without
// installing this test's JSDOM on process globals.
const VueRuntime = await import('vue')

// Use a renderer bound to this JSDOM instead of runtime-dom's module-global nodeOps.
// Other Bun test files can replace global document while their tests are running.
const staticTemplate = browserWindow.document.createElement('template')
const testRenderer = VueRuntime.createRenderer<Node, Element>({
  patchProp: VueRuntime.patchProp,
  insert: (node, parent, anchor = null) => {
    parent.insertBefore(node, anchor)
  },
  remove: node => {
    node.parentNode?.removeChild(node)
  },
  createElement: (type, namespace, isCustomizedBuiltIn) => {
    if (namespace === 'svg') return browserWindow.document.createElementNS('http://www.w3.org/2000/svg', type)
    if (namespace === 'mathml') return browserWindow.document.createElementNS('http://www.w3.org/1998/Math/MathML', type)
    return isCustomizedBuiltIn ? browserWindow.document.createElement(type, { is: isCustomizedBuiltIn }) : browserWindow.document.createElement(type)
  },
  createText: text => browserWindow.document.createTextNode(text),
  createComment: text => browserWindow.document.createComment(text),
  setText: (node, text) => {
    node.nodeValue = text
  },
  setElementText: (element, text) => {
    element.textContent = text
  },
  parentNode: node => node.parentNode as Element | null,
  nextSibling: node => node.nextSibling,
  querySelector: selector => browserWindow.document.querySelector(selector),
  setScopeId: (element, id) => {
    element.setAttribute(id, '')
  },
  cloneNode: node => node.cloneNode(true),
  insertStaticContent: (content, parent, anchor, namespace, start, end) => {
    const before = anchor ? anchor.previousSibling : parent.lastChild
    if (start && (start === end || start.nextSibling)) {
      let current = start
      while (true) {
        parent.insertBefore(current.cloneNode(true), anchor)
        if (current === end || !current.nextSibling) break
        current = current.nextSibling
      }
    } else {
      staticTemplate.innerHTML = namespace === 'svg' ? `<svg>${content}</svg>` : namespace === 'mathml' ? `<math>${content}</math>` : content
      const fragment = staticTemplate.content
      if (namespace === 'svg' || namespace === 'mathml') {
        const wrapper = fragment.firstChild
        if (wrapper) {
          while (wrapper.firstChild) fragment.appendChild(wrapper.firstChild)
          fragment.removeChild(wrapper)
        }
      }
      parent.insertBefore(fragment, anchor)
    }
    return [(before ? before.nextSibling : parent.firstChild) as Node, (anchor ? anchor.previousSibling : parent.lastChild) as Node]
  }
})

const componentPath = path.join(process.cwd(), 'client/components/common/nav-header.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) throw new Error(`Could not parse nav-header.vue: ${parsed.errors.join(', ')}`)
if (!parsed.descriptor.script || !parsed.descriptor.template) {
  throw new Error('nav-header.vue script or template was not found')
}
const englishLocale = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8')) as { common: { header: Record<string, string> } }

const accountMenuStyles = componentSource.match(/\.nav-header-menu\.account-menu\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
const notificationStyles = componentSource.match(/\.account-menu__notifications\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
if (!accountMenuStyles || !notificationStyles) {
  throw new Error('Could not find account menu styles in nav-header.vue')
}

const testTranslations: Record<string, string> = {
  'common:header.account': 'Localized account',
  'common:header.accountNotificationsAvailable': '{{account}}, Localized notifications available',
  'common:header.accountNotificationsUnknown': '{{account}}, Localized notification status not fully checked'
}

interface TranslationCall {
  key: string
  params?: Record<string, unknown>
}

const translationCalls: TranslationCall[] = []
const translate = (key: string, params?: Record<string, unknown>): string => {
  translationCalls.push({ key, params })
  return Object.entries(params ?? {}).reduce((translated, [name, value]) => translated.split(`{{${name}}}`).join(String(value)), testTranslations[key] ?? key)
}

const notificationOverflowProperties = /(?:max-height|overflow-y|overscroll-behavior)\s*:/

interface NotificationCall {
  kind: 'initialize' | 'reset' | 'refresh' | 'refreshAuth'
  ownerId?: number
}

type AuthRefreshOutcome = 'authenticated' | 'anonymous' | 'unavailable'

interface HeaderUser {
  id: number
  name: string
  email: string
  pictureUrl: string
  permissions: string[]
  authenticated: boolean
}

const user = (id: number, authenticated = id > 0): HeaderUser => ({
  id,
  name: authenticated ? `User ${id}` : '',
  email: authenticated ? `user-${id}@example.test` : '',
  pictureUrl: '',
  permissions: [],
  authenticated
})

const connection = VueRuntime.reactive({ connection: 'online', connectionState: 'online', serverReachable: true, serverHealthy: true })
const calls: NotificationCall[] = []
let refreshAuthBehavior: () => Promise<AuthRefreshOutcome> = async () => 'authenticated'
const wikiStore = VueRuntime.reactive({
  site: {
    search: '',
    searchMode: 'search' as 'search' | 'ask',
    searchIsFocused: false,
    searchIsLoading: false,
    title: 'Wiki',
    logoUrl: '/logo.svg'
  },
  page: {
    path: 'home',
    mode: 'view',
    locale: 'en',
    visibility: 'public' as 'public' | 'private',
    id: 1,
    sourceRevision: '',
    effectivePermissions: {
      pages: { write: false, manage: false, delete: false },
      source: { read: false },
      history: { read: false },
      system: { manage: false }
    }
  },
  user: user(1),
  authRefreshPending: false,
  authRefreshSettled: true,
  authRefreshOutcome: 'authenticated' as AuthRefreshOutcome,
  offlineIdentityReady: true,
  isLoading: false,
  refreshAuth: async () => {
    calls.push({ kind: 'refreshAuth' })
    return await refreshAuthBehavior()
  },
  startLoading: () => {},
  stopLoading: () => {},
  showError: () => {}
})

const siteNotifications = VueRuntime.reactive({
  ownerId: 1 as number | null,
  watches: [] as unknown[],
  approvals: [] as unknown[],
  watchesLoading: false,
  approvalsLoading: false,
  watchesError: '',
  approvalsError: '',
  identityStale: false,
  approvalsNextCursor: null as string | null,
  notificationState: 'unknown' as 'available' | 'unknown' | 'clear',
  hasNotifications: false,
  initialize: async (ownerId: number) => {
    calls.push({ kind: 'initialize', ownerId })
    siteNotifications.ownerId = ownerId
    siteNotifications.identityStale = false
    siteNotifications.notificationState = 'available'
  },
  refresh: async () => {
    calls.push({ kind: 'refresh' })
  },
  refreshWatches: async () => {},
  refreshApprovals: async () => {},
  markWatchRead: async () => true,
  loadMoreApprovals: async () => {},
  reset: () => {
    calls.push({ kind: 'reset' })
    siteNotifications.ownerId = null
    siteNotifications.watches = []
    siteNotifications.approvals = []
    siteNotifications.identityStale = false
    siteNotifications.notificationState = 'unknown'
  }
})

const globals = globalThis as typeof globalThis & {
  __headerConnection: typeof connection
  __headerWikiStore: typeof wikiStore
  __headerSiteNotifications: typeof siteNotifications
  siteConfig: Record<string, unknown>
  siteLangs: Array<{ code: string; name: string }>
}
globals.__headerConnection = connection
globals.__headerWikiStore = wikiStore
globals.__headerSiteNotifications = siteNotifications
globals.siteConfig = {
  agentsEnabled: false,
  devMode: false
}
globals.siteLangs = []

const compiledScript = compileScript(parsed.descriptor, {
  id: 'nav-header-notifications-test',
  genDefaultAs: '__sfc__'
})
const compiledTemplate = compileTemplate({
  source: parsed.descriptor.template.content,
  filename: componentPath,
  id: 'nav-header-notifications-test',
  preprocessLang: parsed.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  transformAssetUrls: false,
  compilerOptions: {
    bindingMetadata: compiledScript.bindings,
    expressionPlugins: ['typescript']
  }
})
if (compiledTemplate.errors.length > 0) {
  throw new Error(`Could not compile nav-header.vue: ${compiledTemplate.errors.join(', ')}`)
}
const compiledComponent = `${compiledScript.content}
${compiledTemplate.code}
__sfc__.render = render
export default __sfc__
`

const bundle = await Bun.build({
  entrypoints: ['virtual:NavHeader.vue'],
  external: ['vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'nav-header-notifications-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:NavHeader\.vue$/ }, () => ({
          path: componentPath
        }))
        build.onLoad({ filter: /nav-header\.vue$/, namespace: 'file' }, () => ({
          contents: compiledComponent,
          loader: 'ts',
          resolveDir: path.dirname(componentPath)
        }))
        build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', external: true }))
        build.onResolve({ filter: /^.*$/ }, args => ({ path: args.path, namespace: 'header-notifications-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'header-notifications-stub' }, args => {
          if (args.path === '@/store/index.ts') {
            return {
              contents: 'export const wikiStore = globalThis.__headerWikiStore; export const invalidateOfflineIdentity = async () => true',
              loader: 'js'
            }
          }
          if (args.path.endsWith('/helpers/pwa.ts')) {
            return {
              contents:
                'export const pwaState = globalThis.__headerConnection; export const pwaConnectionPresentation = () => ({ label: "Connected", tone: "success", icon: "mdi-check-network-outline" })',
              loader: 'js'
            }
          }
          if (args.path === '../../store/site-notifications.ts') {
            return { contents: 'export const useSiteNotificationsStore = () => globalThis.__headerSiteNotifications', loader: 'js' }
          }
          if (args.path.endsWith('/pwa-status.vue')) {
            return {
              contents:
                "import { defineComponent, h } from 'vue'; export default defineComponent({ name: 'PwaStatusStub', setup: () => () => h('section', { class: 'pwa-status-panel', role: 'region', 'aria-label': 'Offline app and connection status: Connected' }, 'offline app status') })",
              loader: 'js'
            }
          }
          if (args.path.endsWith('/account-notifications.vue')) {
            return {
              contents:
                "import { defineComponent, h } from 'vue'; export default defineComponent({ name: 'AccountNotificationsStub', setup: () => () => h('div', { class: 'account-menu__notifications' }, 'stale-notification-item') })",
              loader: 'js'
            }
          }
          if (args.path.endsWith('/control-border-beam.vue')) {
            return {
              contents: "import { defineComponent } from 'vue'; export default defineComponent({ name: 'ControlBorderBeamStub', setup: () => () => null })",
              loader: 'js'
            }
          }
          if (args.path.endsWith('/pages-api')) {
            return { contents: 'export const fetchPageLocaleRelations = async () => []; export const movePage = async () => {}', loader: 'js' }
          }
          if (args.path.endsWith('/agent-chat-pin')) {
            return { contents: 'export const clearAgentChatPin = () => {}', loader: 'js' }
          }
          if (args.path.endsWith('/page-action-events')) {
            return {
              contents:
                'export const onPageConvert=()=>{}; export const onPageDelete=()=>{}; export const onPageDuplicate=()=>{}; export const onPageEdit=()=>{}; export const onPageHistory=()=>{}; export const onPageMove=()=>{}; export const onPageSource=()=>{}; export const offPageConvert=()=>{}; export const offPageDelete=()=>{}; export const offPageDuplicate=()=>{}; export const offPageEdit=()=>{}; export const offPageHistory=()=>{}; export const offPageMove=()=>{}; export const offPageSource=()=>{}',
              loader: 'js'
            }
          }
          if (args.path.endsWith('/search-navigation-events')) {
            return {
              contents:
                'export const emitSearchEnter=()=>{}; export const emitSearchExit=()=>{}; export const emitSearchMove=()=>{}; export const onSearchFocus=()=>{}; export const offSearchFocus=()=>{}',
              loader: 'js'
            }
          }
          return {
            contents: "import { defineComponent } from 'vue'; export default defineComponent({ name: 'HeaderAsyncStub', setup: () => () => null })",
            loader: 'js'
          }
        })
      }
    }
  ],
  target: 'bun'
})
if (!bundle.success || bundle.outputs.length !== 1) {
  throw new Error(`Could not bundle nav-header.vue: ${bundle.logs.map(log => log.message).join(', ')}`)
}
const bundleCode = await bundle.outputs[0]!.text()
const moduleStart = bundleCode.indexOf('(function(')
if (moduleStart < 0) throw new Error('Compiled nav-header.vue did not produce a CommonJS module')
interface CompiledModule {
  exports: { default?: VueRuntime.Component }
}
const moduleFactory = new Function(`return ${bundleCode.slice(moduleStart)}`)() as (
  exports: CompiledModule['exports'],
  require: (specifier: string) => unknown,
  module: CompiledModule,
  filename: string,
  dirname: string
) => void
const compiledModule: CompiledModule = { exports: {} }
moduleFactory(
  compiledModule.exports,
  specifier => {
    if (specifier === 'vue') return VueRuntime
    throw new Error(`Unexpected import in nav-header.vue: ${specifier}`)
  },
  compiledModule,
  componentPath,
  path.dirname(componentPath)
)
const NavHeader = compiledModule.exports.default
if (!NavHeader) throw new Error('nav-header.vue did not export a component')

interface HeaderVm {
  handleNotificationFocus: () => void
  handleNotificationVisibility: () => void
  accountMenuVisibilityChanged: (open: boolean) => void
}

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await VueRuntime.nextTick()
    await Promise.resolve()
  }
}
const slotForwardingStub = VueRuntime.defineComponent({
  setup(_, { slots }) {
    return () => VueRuntime.h('div', [slots.activator?.({ props: {} }), slots.default?.()])
  }
})
const menuSlotForwardingStub = VueRuntime.defineComponent({
  setup(_, { slots }) {
    return () =>
      VueRuntime.h('div', { class: 'menu-stub' }, [
        VueRuntime.h('div', { class: 'menu-stub__activator' }, slots.activator?.({ props: {} })),
        VueRuntime.h('div', { class: 'menu-stub__content' }, slots.default?.())
      ])
  }
})

interface HeaderMountOptions {
  hideSearch?: boolean
  smAndDown?: boolean
}

const mountHeader = async ({ hideSearch = true, smAndDown = false }: HeaderMountOptions = {}) => {
  installBrowserGlobals()
  const host = browserWindow.document.createElement('div')
  browserWindow.document.body.append(host)
  const app = testRenderer.createApp(NavHeader, { dense: true, hideSearch })
  app.component('v-menu', menuSlotForwardingStub)
  app.component('v-tooltip', slotForwardingStub)
  app.config.globalProperties.$t = translate
  app.config.globalProperties.$vuetify = {
    display: { smAndDown, mdAndUp: !smAndDown },
    locale: { isRtl: false }
  }
  app.mount(host)
  await settle()
  mountedApps.push(() => {
    app.unmount()
    host.remove()
  })
  return {
    host,
    vm: (app as unknown as { _instance?: { proxy?: HeaderVm } })._instance?.proxy as HeaderVm
  }
}
afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  browserWindow.document.body.replaceChildren()
  for (const restore of browserGlobalRestorations.splice(0).reverse()) restore()
  calls.splice(0)
  Object.assign(connection, { connection: 'online', connectionState: 'online', serverReachable: true, serverHealthy: true })
  translationCalls.splice(0)
  wikiStore.user = user(1)
  wikiStore.authRefreshPending = false
  wikiStore.authRefreshSettled = true
  wikiStore.authRefreshOutcome = 'authenticated'
  wikiStore.offlineIdentityReady = true
  siteNotifications.ownerId = 1
  siteNotifications.identityStale = false
  siteNotifications.notificationState = 'unknown'
  refreshAuthBehavior = async () => 'authenticated'
})

describe('search header affordances', () => {
  it('omits Browse by Tags from the desktop header when search is hidden', async () => {
    const mounted = await mountHeader({ hideSearch: true, smAndDown: false })

    expect(mounted.host.querySelector('.nav-header-browse')).toBeNull()
  })

  it('omits Browse by Tags from the mobile header when search is hidden', async () => {
    const mounted = await mountHeader({ hideSearch: true, smAndDown: true })

    expect(mounted.host.querySelector('.nav-header-browse')).toBeNull()
  })
})

describe('notification header identity recovery', () => {
  it('recovers an A-to-B shared-cookie identity without displaying stale items or retrying while stale', async () => {
    const mounted = await mountHeader()
    calls.splice(0)

    let releaseRefresh!: () => void
    refreshAuthBehavior = () =>
      new Promise<AuthRefreshOutcome>(resolve => {
        releaseRefresh = () => {
          wikiStore.user = user(2)
          resolve('authenticated')
        }
      })
    siteNotifications.watches = [{ id: 'stale-watch', title: 'Stale notification item' }]
    siteNotifications.identityStale = true
    await settle()

    expect(calls.filter(call => call.kind === 'refreshAuth')).toHaveLength(1)
    expect(mounted.host.querySelector('.account-menu__notifications')).toBeNull()
    mounted.vm.handleNotificationFocus?.()
    mounted.vm.handleNotificationVisibility?.()
    mounted.vm.accountMenuVisibilityChanged?.(true)
    expect(calls.filter(call => call.kind === 'refresh')).toHaveLength(0)
    expect(calls.filter(call => call.kind === 'initialize')).toHaveLength(0)

    releaseRefresh()
    await settle()

    expect(calls.filter(call => call.kind === 'initialize').map(call => call.ownerId)).toEqual([2])
    expect(calls.filter(call => call.kind === 'initialize').map(call => call.ownerId)).not.toContain(1)
    expect(siteNotifications.identityStale).toBe(false)
  })

  it('resets notifications after auth refresh resolves to a guest', async () => {
    await mountHeader()
    calls.splice(0)
    refreshAuthBehavior = async () => {
      wikiStore.user = user(0, false)
      return 'anonymous'
    }
    siteNotifications.identityStale = true
    await settle()

    expect(calls.filter(call => call.kind === 'refreshAuth')).toHaveLength(1)
    expect(calls.filter(call => call.kind === 'initialize')).toHaveLength(0)
    expect(calls.some(call => call.kind === 'reset')).toBe(true)
    expect(siteNotifications.ownerId).toBeNull()
  })

  it('retries identity refresh after a transient failure without remounting', async () => {
    const mounted = await mountHeader()
    calls.splice(0)

    let refreshAttempts = 0
    let releaseRetry!: () => void
    refreshAuthBehavior = () => {
      refreshAttempts += 1
      if (refreshAttempts === 1) return Promise.resolve('unavailable')
      return new Promise<AuthRefreshOutcome>(resolve => {
        releaseRetry = () => {
          wikiStore.user = user(2)
          resolve('authenticated')
        }
      })
    }
    siteNotifications.watches = [{ id: 'stale-watch', title: 'Stale notification item' }]
    siteNotifications.identityStale = true
    await settle()

    expect(calls.filter(call => call.kind === 'refreshAuth')).toHaveLength(1)
    expect(siteNotifications.identityStale).toBe(true)
    expect(mounted.host.querySelector('.account-menu__notifications')).toBeNull()

    mounted.vm.handleNotificationFocus?.()
    mounted.vm.accountMenuVisibilityChanged?.(true)
    await settle()

    expect(calls.filter(call => call.kind === 'refreshAuth')).toHaveLength(2)
    expect(calls.filter(call => call.kind === 'initialize')).toHaveLength(0)
    expect(siteNotifications.identityStale).toBe(true)

    releaseRetry()
    await settle()

    expect(calls.filter(call => call.kind === 'initialize').map(call => call.ownerId)).toEqual([2])
    expect(calls.filter(call => call.kind === 'initialize').map(call => call.ownerId)).not.toContain(1)
    expect(siteNotifications.identityStale).toBe(false)
  })
})

describe('account menu containment', () => {
  it('keeps authenticated profile, offline app, and session controls inside the account menu surface', async () => {
    const mounted = await mountHeader()
    const accountMenus = mounted.host.querySelectorAll('.nav-header-menu.account-menu')
    const accountMenu = accountMenus[0]
    const profileLink = mounted.host.querySelector('[aria-label="Open profile for User 1"]')
    const offlinePanels = mounted.host.querySelectorAll('.account-menu__offline')
    const offlinePanel = offlinePanels[0]
    const notifications = mounted.host.querySelector('.account-menu__notifications')
    const preferences = mounted.host.querySelector('.account-menu__preferences')
    const logoutForm = mounted.host.querySelector('form[action="/logout"][method="post"]')

    expect(accountMenus).toHaveLength(1)
    expect(offlinePanels).toHaveLength(1)
    expect(accountMenu?.getAttribute('aria-label')).toBe('Account menu')
    expect(profileLink?.closest('.account-menu')).toBe(accountMenu)
    expect(offlinePanel?.closest('.account-menu')).toBe(accountMenu)
    expect(offlinePanel?.getAttribute('href')).toBe('/p/offline')
    expect(offlinePanel?.getAttribute('aria-label')).toBe('Connection and offline access')
    expect(mounted.host.querySelector('.pwa-status-panel')).toBeNull()
    expect(notifications?.closest('.account-menu')).toBe(accountMenu)
    expect(preferences?.closest('.account-menu')).toBe(accountMenu)
    expect(logoutForm?.closest('.account-menu')).toBe(accountMenu)
    expect(mounted.host.querySelector('[aria-label="Sign in"]')).toBeNull()
    expect(mounted.host.querySelector('.nav-header-app-status-menu')).toBeNull()
    expect(mounted.host.querySelector('.nav-header-app-status-trigger')).toBeNull()
    expect(accountMenu?.closest('.menu-stub__content')).not.toBeNull()
    expect(accountMenu?.closest('.menu-stub__activator')).toBeNull()
  })

  it('keeps guest sign-in and offline app controls inside the account menu without authenticated actions', async () => {
    wikiStore.user = user(0, false)
    wikiStore.authRefreshOutcome = 'anonymous'
    siteNotifications.ownerId = null
    const mounted = await mountHeader()
    const accountMenus = mounted.host.querySelectorAll('.nav-header-menu.account-menu')
    const accountMenu = accountMenus[0]
    const offlinePanels = mounted.host.querySelectorAll('.account-menu__offline')
    const offlinePanel = offlinePanels[0]
    const signIn = mounted.host.querySelector('[aria-label="Sign in"]')
    const button = mounted.host.querySelector<HTMLElement>('.account-menu__trigger')
    const connectivityIndicator = mounted.host.querySelector<HTMLElement>('[data-connectivity-indicator]')

    expect(accountMenus).toHaveLength(1)
    expect(offlinePanels).toHaveLength(1)
    expect(accountMenu?.getAttribute('aria-label')).toBe('Account menu')
    expect(offlinePanel?.closest('.account-menu')).toBe(accountMenu)
    expect(offlinePanel?.getAttribute('href')).toBe('/p/offline')
    expect(offlinePanel?.getAttribute('aria-label')).toBe('Connection and offline access')
    expect(mounted.host.querySelector('.pwa-status-panel')).toBeNull()
    expect(signIn?.closest('.account-menu')).toBe(accountMenu)
    expect(mounted.host.querySelector('[aria-label^="Open profile for "]')).toBeNull()
    expect(mounted.host.querySelector('.account-menu__notifications')).toBeNull()
    expect(mounted.host.querySelector('.account-menu__preferences')).toBeNull()
    expect(mounted.host.querySelector('form[action="/logout"][method="post"]')).toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Localized account')
    expect(connectivityIndicator?.classList.contains('account-menu__connectivity-indicator--success')).toBe(true)
    expect(connectivityIndicator?.getAttribute('title')).toBe('Connected')
    expect(mounted.host.querySelector('.nav-header-app-status-menu')).toBeNull()
    expect(mounted.host.querySelector('.nav-header-app-status-trigger')).toBeNull()
    expect(accountMenu?.closest('.menu-stub__content')).not.toBeNull()
    expect(accountMenu?.closest('.menu-stub__activator')).toBeNull()
  })
})

describe('notification header tri-state indicator', () => {
  it('announces localized available, unknown, and clear states while keeping account-menu as the only scroller', async () => {
    const mounted = await mountHeader()
    const button = () => mounted.host.querySelector<HTMLElement>('.account-menu__trigger')
    const indicator = () => mounted.host.querySelector<HTMLElement>('.account-menu__notification-indicator')
    const connectivityIndicator = () => mounted.host.querySelector<HTMLElement>('[data-connectivity-indicator]')

    expect(englishLocale.common.header.accountNotificationsAvailable).toBe('{{account}}, Notifications available')
    expect(englishLocale.common.header.accountNotificationsUnknown).toBe('{{account}}, Notification status not fully checked')
    expect(accountMenuStyles).toMatch(/overflow-y\s*:\s*auto/)
    expect(accountMenuStyles).toMatch(/overscroll-behavior\s*:\s*contain/)
    expect(notificationStyles).toMatch(/min-height\s*:\s*0/)
    expect(notificationStyles).not.toMatch(notificationOverflowProperties)

    expect(calls.filter(call => call.kind === 'initialize').map(call => call.ownerId)).toEqual([1])
    expect(button()?.getAttribute('aria-label')).toBe('Localized account, Localized notifications available')
    expect(translationCalls.some(call => call.key === 'common:header.accountNotificationsAvailable' && call.params?.account === 'Localized account')).toBe(true)
    expect(indicator()?.classList.contains('account-menu__notification-indicator--available')).toBe(true)
    expect(connectivityIndicator()?.classList.contains('account-menu__connectivity-indicator--success')).toBe(true)
    expect(connectivityIndicator()?.getAttribute('title')).toBe('Connected')

    translationCalls.splice(0)
    siteNotifications.notificationState = 'unknown'
    await settle()
    expect(indicator()?.classList.contains('account-menu__notification-indicator--unknown')).toBe(true)
    expect(button()?.getAttribute('aria-label')).toBe('Localized account, Localized notification status not fully checked')
    expect(translationCalls.some(call => call.key === 'common:header.accountNotificationsUnknown' && call.params?.account === 'Localized account')).toBe(true)

    translationCalls.splice(0)
    siteNotifications.notificationState = 'clear'
    await settle()
    expect(indicator()).toBeNull()
    expect(button()?.getAttribute('aria-label')).toBe('Localized account')
    expect(translationCalls.every(call => call.key === 'common:header.account')).toBe(true)
  })
})


describe('account continuity without a verified connection', () => {
  it('does not present a cold offline session as signed out, then offers sign in only after anonymous verification', async () => {
    wikiStore.user = user(0, false)
    wikiStore.authRefreshSettled = false
    Object.assign(connection, { connection: 'offline', connectionState: 'offline', serverReachable: false, serverHealthy: false })
    const { host } = await mountHeader()
    expect(host.textContent).toContain('Account not verified')
    expect(host.textContent).toContain('Reconnect to verify your session')
    expect(host.querySelector('[aria-label="Sign in"]')).toBeNull()
    expect(host.querySelector('.account-menu__offline')?.getAttribute('href')).toBe('/p/offline')

    Object.assign(connection, { connection: 'online', connectionState: 'online', serverReachable: true, serverHealthy: true })
    wikiStore.authRefreshPending = true
    await settle()
    expect(host.textContent).toContain('Checking account')
    expect(host.querySelector('[aria-label="Sign in"]')).toBeNull()
    wikiStore.authRefreshPending = false
    wikiStore.authRefreshSettled = true
    wikiStore.authRefreshOutcome = 'unavailable'
    await settle()
    expect(host.querySelector('[aria-label="Sign in"]')).toBeNull()
    wikiStore.authRefreshOutcome = 'anonymous'
    await settle()
    expect(host.querySelector('[aria-label="Sign in"]')?.getAttribute('href')).toBe('/login')
    expect(host.querySelector('.account-menu__unverified')).toBeNull()
  })

  it('keeps the warm account visible while pausing server actions and allowing Home', async () => {
    const { host } = await mountHeader()
    Object.assign(connection, { connection: 'offline', connectionState: 'offline', serverReachable: false, serverHealthy: false })
    wikiStore.authRefreshOutcome = 'unavailable'
    await settle()
    const profile = host.querySelector('.account-menu__profile')
    expect(profile?.textContent).toContain('User 1')
    expect(profile?.textContent).toContain('Last verified account')
    expect(profile?.hasAttribute('href')).toBe(false)
    expect(host.querySelector('.account-menu__notifications')).toBeNull()
    expect(host.querySelector('[aria-label="Sign in"]')).toBeNull()
    const form = host.querySelector('form[action="/logout"]')
    expect(form?.querySelector('[type="submit"]')?.hasAttribute('disabled')).toBe(true)
    const before = calls.filter(call => call.kind === 'reset').length
    form?.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(calls.filter(call => call.kind === 'reset')).toHaveLength(before)
    const home = host.querySelector('.nav-header-logo')
    const click = new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true })
    home?.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    calls.splice(0)
    Object.assign(connection, { connection: 'online', connectionState: 'online', serverReachable: true, serverHealthy: true })
    await settle()
    expect(calls.filter(call => call.kind === 'refreshAuth')).toHaveLength(1)
  })
})
