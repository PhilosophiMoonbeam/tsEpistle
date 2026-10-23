import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody, setLocation } from '../../test/browser-dom.mts'

import { translateEnglish } from '../../test/english-translate.mts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import type { PageApprovalInboxItem, PageWatchNotification } from '../../../shared/site-notifications.ts'
resetBody()
setLocation('/wiki/page')

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

const testTranslations: Record<string, string> = {
  'common:header.account': 'Localized account',
  'common:header.accountNotificationsAvailable': '{{account}}, Localized notifications available',
  'common:header.accountNotificationsUnknown': '{{account}}, Localized notification status not fully checked',
  'common:header.agent': 'Agent localisé',
  'common:header.agentOpen': 'Ouvrir l’agent',
  'common:header.searchOpen': 'Ouvrir la recherche'
}

const translate = (key: string, params?: Record<string, unknown>): string => {
  const template = testTranslations[key] ?? (typeof params?.defaultValue === 'string' ? params.defaultValue : translateEnglish(key, params))
  return Object.entries(params ?? {}).reduce((translated, [name, value]) => translated.split(`{{${name}}}`).join(String(value)), template)
}

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

const watchItem = (id: string, title: string): PageWatchNotification => ({
  id,
  pageId: 12,
  eventType: 'page.updated',
  category: 'pageWatch',
  commentId: null,
  actorName: 'Editor',
  title,
  path: `docs/${id}`,
  localeCode: 'en',
  visibility: 'public',
  createdAt: '2026-09-11T10:00:00.000Z',
  readAt: null
})

const approvalItem = (id: string): PageApprovalInboxItem => ({
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
  title: `Approval ${id}`,
  path: `reviews/${id}`,
  localeCode: 'en',
  visibility: 'public'
})

const connection = VueRuntime.reactive({ connection: 'online', connectionState: 'online', serverReachable: true, serverHealthy: true })
const calls: NotificationCall[] = []
let agentDestroyCalls = 0
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
  watches: [] as PageWatchNotification[],
  approvals: [] as PageApprovalInboxItem[],
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
  __headerDestroyAgents: () => void
  __headerMarkOfflineLogoutPending: (accountId?: number) => boolean
  __headerInvalidateOfflineIdentity: () => Promise<boolean>
  __headerOfflineIdentityCleanupFailureMessage: string
  siteConfig: Record<string, unknown>
  siteLangs: Array<{ code: string; name: string }>
}
const markOfflineLogoutPendingCalls: Array<number | undefined> = []
globals.__headerConnection = connection
globals.__headerWikiStore = wikiStore
globals.__headerSiteNotifications = siteNotifications
globals.__headerDestroyAgents = () => {
  agentDestroyCalls += 1
}
globals.__headerMarkOfflineLogoutPending = accountId => {
  markOfflineLogoutPendingCalls.push(accountId)
  return true
}
globals.__headerInvalidateOfflineIdentity = async () => true
globals.__headerOfflineIdentityCleanupFailureMessage = 'Offline identity cleanup failed. Reconnect and try again.'
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
        build.onResolve({ filter: /^\.\.\/\.\.\/helpers\/user-picture\.ts$/ }, () => ({
          path: path.resolve(path.dirname(componentPath), '../../helpers/user-picture.ts')
        }))
        build.onResolve({ filter: /^\.\.\/\.\.\/helpers\/offline-sync-status\.ts$/ }, () => ({
          path: path.resolve(path.dirname(componentPath), '../../helpers/offline-sync-status.ts')
        }))
        build.onResolve({ filter: /^.*$/ }, args => ({ path: args.path, namespace: 'header-notifications-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'header-notifications-stub' }, args => {
          if (args.path === '@/store/index.ts') {
            return {
              contents: [
                'export const wikiStore = globalThis.__headerWikiStore;',
                'export const invalidateOfflineIdentity = () => globalThis.__headerInvalidateOfflineIdentity();',
                'export const markOfflineLogoutPending = accountId => (globalThis.__headerMarkOfflineLogoutPending ? globalThis.__headerMarkOfflineLogoutPending(accountId) : false);',
                'export const OFFLINE_IDENTITY_CLEANUP_FAILURE_MESSAGE = globalThis.__headerOfflineIdentityCleanupFailureMessage'
              ].join('\n'),
              loader: 'js'
            }
          }
          if (args.path.endsWith('/helpers/pwa.ts')) {
            return {
              contents:
                'export const pwaState = globalThis.__headerConnection; export const pwaConnectionPresentation = () => ({ key: "connected", label: "Connected", tone: "success", icon: "mdi-check-network-outline" })',
              loader: 'js'
            }
          }
          if (args.path === '../../store/site-notifications.ts') {
            return { contents: 'export const useSiteNotificationsStore = () => globalThis.__headerSiteNotifications', loader: 'js' }
          }
          if (args.path.endsWith('/helpers/offline-session.ts')) {
            return { contents: `export const OFFLINE_SESSION_INVALIDATED_EVENT = ${JSON.stringify(OFFLINE_SESSION_INVALIDATED_EVENT)}`, loader: 'js' }
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
          if (args.path.endsWith('account-offline-summary.vue')) {
            return {
              contents:
                "import { defineComponent, h } from 'vue'; export default defineComponent({ name: 'AccountOfflineSummaryStub', setup: () => () => h('section', { class: 'account-offline-summary' }, [h('a', { class: 'account-offline-summary__manage', href: '/p/offline', 'aria-label': 'Manage offline access' })]) })",
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
          if (args.path === '../../store/agents.ts') {
            return { contents: 'export const useAgentsStore = () => ({ destroyWorkspace: globalThis.__headerDestroyAgents })', loader: 'js' }
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
  setAccountTooltip: (open: boolean) => void
  accountTooltipOpen: boolean
  applyNavHeaderTitleFit: () => void
  navHeaderTitleFitScale: number
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
  xs?: boolean
  smAndDown?: boolean
  dense?: boolean
}

const mountHeader = async ({ hideSearch = true, xs = false, smAndDown = xs, dense = true }: HeaderMountOptions = {}) => {
  installBrowserGlobals()
  const host = browserWindow.document.createElement('div')
  browserWindow.document.body.append(host)
  const app = testRenderer.createApp(NavHeader, { dense, hideSearch })
  app.component('v-menu', menuSlotForwardingStub)
  app.component('v-tooltip', slotForwardingStub)
  app.config.globalProperties.$t = translate
  app.config.globalProperties.$vuetify = {
    display: { xs, smAndDown, mdAndUp: !smAndDown },
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
  agentDestroyCalls = 0
  globals.__headerInvalidateOfflineIdentity = async () => true
  Object.assign(connection, { connection: 'online', connectionState: 'online', serverReachable: true, serverHealthy: true })
  wikiStore.site.title = 'Wiki'
  wikiStore.site.search = ''
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
  it.each([false, true])('retains a dismissed search and allows explicit clear and replacement (small screen: %s)', async smAndDown => {
    const mounted = await mountHeader({ hideSearch: false, smAndDown })
    const vm = mounted.vm as unknown as { search: string | null, searchIsFocused: boolean, searchClose: () => void }
    vm.search = 'initial query'
    vm.searchIsFocused = true
    vm.searchClose()
    await settle()
    expect(vm.searchIsFocused).toBe(false)
    expect(vm.search).toBe('initial query')
    vm.search = null
    await settle()
    expect(wikiStore.site.search).toBe('')
    expect(vm.search).toBe('')
    vm.search = 'replacement query'
    await settle()
    expect(wikiStore.site.search).toBe('replacement query')
    expect(vm.search).toBe('replacement query')
  })

  it('omits Browse by Tags from the desktop header when search is hidden', async () => {
    const mounted = await mountHeader({ hideSearch: true, smAndDown: false })

    expect(mounted.host.querySelector('.nav-header-browse')).toBeNull()
  })

  it.each([false, true])('omits Browse by Tags when mobile search is hidden (phone: %s)', async xs => {
    const mounted = await mountHeader({ hideSearch: true, smAndDown: true, xs })

    expect(mounted.host.querySelector('.nav-header-browse')).toBeNull()
  })

  it('keeps tag browsing reachable on phones without granting anonymous visitors an Agent action', async () => {
    globals.siteConfig = { ...globals.siteConfig, agentsEnabled: true }
    wikiStore.user = user(0)
    wikiStore.authRefreshOutcome = 'anonymous'
    try {
      const mounted = await mountHeader({ hideSearch: false, xs: true, dense: false })
      expect(mounted.host.querySelector('.nav-header-mobile-actions')).not.toBeNull()
      expect(mounted.host.querySelector('.menu-stub__content [href="/t"]')).not.toBeNull()
      expect(mounted.host.querySelector('.nav-header-menu__note')).toBeNull()
      expect(mounted.host.querySelector('[aria-label="Ouvrir l’agent"]')).toBeNull()
    } finally {
      globals.siteConfig = { ...globals.siteConfig, agentsEnabled: false }
    }
  })
})

describe('workspace title responsiveness', () => {
  // JSDOM has no text layout. Model only the browser's measured widths, leaving
  // the component to choose the scale and restore its word-breaking behavior.
  const titleGeometry = (host: HTMLElement) => {
    const box = host.querySelector<HTMLElement>('.nav-header-title-stacked')!
    const geometry = { width: 100, naturalWidth: 120, overflowReads: 0 }
    box.style.fontSize = '13px'
    Object.defineProperties(box, {
      clientWidth: { get: () => geometry.width },
      clientHeight: { get: () => 48 },
      scrollHeight: { get: () => 48 }
    })
    box.getBoundingClientRect = () => new browserWindow.DOMRect(
      0, 0, geometry.width,
      (Number(box.style.getPropertyValue('--nav-header-title-fit')) || 1) * 32
    )
    for (const line of box.querySelectorAll<HTMLElement>('.nav-header-title-line')) {
      Object.defineProperties(line, {
        clientWidth: { get: () => geometry.width },
        scrollWidth: {
          get: () => {
            geometry.overflowReads += 1
            return geometry.naturalWidth * (Number(box.style.getPropertyValue('--nav-header-title-fit')) || 1)
          }
        },
        clientHeight: { get: () => 24 },
        scrollHeight: { get: () => 24 }
      })
    }
    return { box, geometry }
  }

  it.each([1, 0.92, 0.84, 0.76, 0.7])('keeps the largest fitting title scale (%s) without repeating unchanged layout walks', async expectedScale => {
    const mounted = await mountHeader({ smAndDown: true })
    const { box, geometry } = titleGeometry(mounted.host)
    geometry.naturalWidth = 100 / expectedScale

    mounted.vm.applyNavHeaderTitleFit()

    expect(mounted.vm.navHeaderTitleFitScale).toBe(expectedScale)
    expect(box.style.getPropertyValue('--nav-header-title-fit')).toBe(expectedScale.toFixed(3))
    expect(box.classList.contains('is-measuring')).toBe(false)
    const reads = geometry.overflowReads
    mounted.vm.applyNavHeaderTitleFit()
    mounted.vm.applyNavHeaderTitleFit()
    expect(geometry.overflowReads).toBe(reads)
  })

  it('refits changed width, title and typography while keeping minimum-scale word breaking', async () => {
    const mounted = await mountHeader({ smAndDown: true })
    const { box, geometry } = titleGeometry(mounted.host)
    geometry.naturalWidth = 300
    mounted.vm.applyNavHeaderTitleFit()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(0.7)
    expect(box.classList.contains('is-measuring')).toBe(false)

    geometry.width = 320
    mounted.vm.applyNavHeaderTitleFit()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(1)

    geometry.naturalWidth = 400
    wikiStore.site.title = 'Longer workspace'
    await settle()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(0.76)

    geometry.naturalWidth = 500
    box.style.fontFamily = 'Updated Heading'
    mounted.vm.applyNavHeaderTitleFit()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(0.7)

    geometry.width = 0
    mounted.vm.applyNavHeaderTitleFit()
    await settle()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(1)
    geometry.width = 320
    mounted.vm.applyNavHeaderTitleFit()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(0.7)
  })

  it('shares an unchanged font-ready fit but refits after a subsequent font load', async () => {
    const previousFonts = Object.getOwnPropertyDescriptor(browserWindow.document, 'fonts')
    const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>()
    const fonts = Object.assign(new browserWindow.EventTarget(), {
      status: 'loaded',
      ready
    })
    Object.defineProperty(browserWindow.document, 'fonts', { configurable: true, value: fonts })
    browserGlobalRestorations.push(() => {
      if (previousFonts) Object.defineProperty(browserWindow.document, 'fonts', previousFonts)
      else Reflect.deleteProperty(browserWindow.document, 'fonts')
    })
    const mounted = await mountHeader({ smAndDown: true })
    const { geometry } = titleGeometry(mounted.host)
    mounted.vm.applyNavHeaderTitleFit()
    expect(mounted.vm.navHeaderTitleFitScale).toBe(0.84)
    const reads = geometry.overflowReads

    resolveReady()
    await settle()
    fonts.dispatchEvent(new browserWindow.Event('loadingdone'))
    expect(geometry.overflowReads).toBe(reads)

    fonts.status = 'loading'
    fonts.dispatchEvent(new browserWindow.Event('loading'))
    geometry.naturalWidth = 140
    fonts.status = 'loaded'
    fonts.dispatchEvent(new browserWindow.Event('loadingdone'))
    expect(mounted.vm.navHeaderTitleFitScale).toBe(0.7)
    expect(geometry.overflowReads).toBeGreaterThan(reads)
  })

  it('splits multi-word workspace titles onto two balanced lines for the stacked small-screen variant', async () => {
    wikiStore.site.title = `Tim O'Pedia`
    const mounted = await mountHeader({ hideSearch: true, smAndDown: true })

    const stacked = mounted.host.querySelector('.nav-header-title-stacked')
    expect(stacked).not.toBeNull()
    expect([...stacked!.querySelectorAll('.nav-header-title-line')].map(line => line.textContent)).toEqual(['Tim', `O'Pedia`])
    expect(stacked?.querySelectorAll('.nav-header-title-line').length).toBe(2)
    expect(mounted.host.querySelector('.nav-header-title-single')?.textContent).toBe(`Tim O'Pedia`)
  })

  it('keeps a single-word title whole in the stacked variant', async () => {
    wikiStore.site.title = 'Encyclopedia'
    const mounted = await mountHeader({ hideSearch: true, smAndDown: true })

    expect(mounted.host.querySelector('.nav-header-title-stacked')?.textContent).toBe('Encyclopedia')
    expect(mounted.host.querySelector('.nav-header-title-stacked')?.querySelectorAll('.nav-header-title-line').length).toBe(1)
  })

  it('renders one balanced split for four-word titles by minimizing the longest line', async () => {
    wikiStore.site.title = 'Wiki Knowledge Base Portal'
    const mounted = await mountHeader({ hideSearch: true, smAndDown: true })

    expect([...mounted.host.querySelectorAll('.nav-header-title-stacked .nav-header-title-line')].map(line => line.textContent)).toEqual([
      'Wiki Knowledge',
      'Base Portal'
    ])
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
    siteNotifications.watches = [watchItem('stale-watch', 'Stale notification item')]
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
    siteNotifications.watches = [watchItem('stale-watch', 'Stale notification item')]
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
  it.each([false, true])('offers guests direct Sign in while retaining Account and offline controls (small screen: %s)', async smAndDown => {
    wikiStore.user = user(0, false)
    wikiStore.authRefreshOutcome = 'anonymous'
    const mounted = await mountHeader({ smAndDown })
    const signIn = mounted.host.querySelector('.nav-header-sign-in')
    expect(signIn?.getAttribute('href')).toBe('/login')
    expect(signIn?.textContent).toBe('Sign in')
    expect(signIn?.closest('.account-menu')).toBeNull()
    expect(mounted.host.querySelector('.account-menu__trigger')).not.toBeNull()
    expect(mounted.host.querySelector('.account-offline-summary')).not.toBeNull()
    wikiStore.user = user(1)
    wikiStore.authRefreshOutcome = 'authenticated'
    await settle()
    expect(mounted.host.querySelector('.nav-header-sign-in')).toBeNull()
    expect(mounted.host.querySelector('form[action="/logout"]')).not.toBeNull()
  })

  it('keeps the account button tooltip closed while the account menu is open', async () => {
    const mounted = await mountHeader({ smAndDown: true })
    mounted.vm.setAccountTooltip(true)
    expect(mounted.vm.accountTooltipOpen).toBe(true)
    mounted.vm.accountMenuVisibilityChanged(true)
    expect(mounted.vm.accountTooltipOpen).toBe(false)
    // A touch tap leaves the hover state; it must not reopen over the menu.
    mounted.vm.setAccountTooltip(true)
    expect(mounted.vm.accountTooltipOpen).toBe(false)
    mounted.vm.accountMenuVisibilityChanged(false)
    mounted.vm.setAccountTooltip(true)
    expect(mounted.vm.accountTooltipOpen).toBe(true)
  })

  it('keeps authenticated profile, offline app, and session controls inside the account menu surface', async () => {
    const mounted = await mountHeader()
    const accountMenus = mounted.host.querySelectorAll('.nav-header-menu.account-menu')
    const accountMenu = accountMenus[0]
    const profileLink = mounted.host.querySelector('[aria-label="Open profile for User 1"]')
    const offlinePanels = mounted.host.querySelectorAll('.account-menu__offline')
    const notifications = mounted.host.querySelector('.account-menu__notifications')
    const preferences = mounted.host.querySelector('.account-menu__preferences')
    const logoutForm = mounted.host.querySelector('form[action="/logout"][method="post"]')

    const offlineManage = mounted.host.querySelector('.account-offline-summary__manage')

    expect(accountMenus).toHaveLength(1)
    expect(offlinePanels).toHaveLength(0)
    expect(accountMenu?.getAttribute('aria-label')).toBe('Account menu')
    expect(profileLink?.closest('.account-menu')).toBe(accountMenu)
    expect(offlineManage?.closest('.account-menu')).toBe(accountMenu)
    expect(mounted.host.querySelector('.account-menu__tabs')).not.toBeNull()
    const tablist = mounted.host.querySelector<HTMLElement>('.account-menu__tabs')!
    expect(tablist.getAttribute('role')).toBe('tablist')
    const panels = [...mounted.host.querySelectorAll<HTMLElement>('.account-menu__panel')]
    expect(panels.every(panel => panel.getAttribute('role') === 'tabpanel')).toBe(true)
    const sections = [
      { label: 'Appearance', content: '.account-menu__preferences' },
      { label: 'Offline', content: '.account-offline-summary' },
      { label: 'Notifications', content: '.account-menu__notifications' }
    ]
    for (const section of sections) {
      const tabs = [...mounted.host.querySelectorAll<HTMLElement>('.account-menu__tab')]
      expect(tabs.map(candidate => candidate.textContent?.trim())).toEqual(['Notifications', 'Appearance', 'Offline'])
      const tab = tabs.find(candidate => candidate.textContent?.trim() === section.label)!
      tab.click()
      await settle()
      expect(tab.getAttribute('role')).toBe('tab')
      expect(tab.getAttribute('aria-selected')).toBe('true')
      expect(tab.getAttribute('tabindex')).toBe('0')
      expect(tabs.filter(candidate => candidate.getAttribute('aria-selected') === 'true')).toEqual([tab])
      expect(tabs.filter(candidate => candidate.getAttribute('tabindex') === '0')).toEqual([tab])
      const selectedPanel = mounted.host.querySelector(section.content)?.closest<HTMLElement>('.account-menu__panel')
      expect(selectedPanel).not.toBeNull()
      expect(tab.getAttribute('aria-controls')).toBe(selectedPanel!.id)
      expect(selectedPanel!.getAttribute('aria-labelledby')).toBe(tab.id)
      for (const panel of panels) {
        expect(panel.style.display === 'none').toBe(panel !== selectedPanel)
      }
    }
    // Arrow keys move selection and focus between tabs; Home and End jump to the ends.
    const keyTo = async (key: string): Promise<string | undefined> => {
      const active = mounted.host.querySelector<HTMLElement>('.account-menu__tab[aria-selected="true"]')!
      active.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await settle()
      return mounted.host.querySelector<HTMLElement>('.account-menu__tab[aria-selected="true"]')?.textContent?.trim()
    }
    expect(await keyTo('ArrowRight')).toBe('Appearance')
    expect(browserWindow.document.activeElement?.textContent?.trim()).toBe('Appearance')
    expect(await keyTo('End')).toBe('Offline')
    expect(await keyTo('ArrowRight')).toBe('Notifications')
    expect(await keyTo('ArrowLeft')).toBe('Offline')
    expect(await keyTo('Home')).toBe('Notifications')
    expect(mounted.host.querySelector('.account-offline-summary')).not.toBeNull()
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

    expect(accountMenus).toHaveLength(1)
    expect(offlinePanels).toHaveLength(1)
    expect(accountMenu?.getAttribute('aria-label')).toBe('Account menu')
    expect(offlinePanel?.closest('.account-menu')).toBe(accountMenu)
    expect(offlinePanel?.querySelector('.account-offline-summary__manage')?.getAttribute('href')).toBe('/p/offline')
    expect(mounted.host.querySelector('.account-menu__tabs')).toBeNull()
    expect(mounted.host.querySelector('.pwa-status-panel')).toBeNull()
    expect(signIn?.closest('.account-menu')).toBe(accountMenu)
    expect(mounted.host.querySelector('[aria-label^="Open profile for "]')).toBeNull()
    expect(mounted.host.querySelector('.account-menu__notifications')).toBeNull()
    expect(mounted.host.querySelector('.account-menu__preferences')).toBeNull()
    expect(mounted.host.querySelector('form[action="/logout"][method="post"]')).toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Localized account')
    expect(mounted.host.querySelector('.nav-header-app-status-menu')).toBeNull()
    expect(mounted.host.querySelector('.nav-header-app-status-trigger')).toBeNull()
    expect(accountMenu?.closest('.menu-stub__content')).not.toBeNull()
    expect(accountMenu?.closest('.menu-stub__activator')).toBeNull()
  })

  it('adds an Approvals tab with a count for reviewers and falls back to an icon avatar without a name', async () => {
    wikiStore.user = { ...user(1), permissions: ['write:pages'] }
    siteNotifications.approvals = [approvalItem('a1'), approvalItem('a2')]
    siteNotifications.approvalsNextCursor = 'next'
    try {
      const mounted = await mountHeader()
      const tabs = [...mounted.host.querySelectorAll<HTMLElement>('.account-menu__tab')]
      expect(tabs.map(tab => tab.dataset.tab)).toEqual(['notifications', 'approvals', 'appearance', 'offline'])
      const approvals = tabs[1]!
      expect(approvals.querySelector('.account-menu__tab-badge')?.textContent).toBe('2+')
      approvals.click()
      await settle()
      const panel = mounted.host.querySelector<HTMLElement>('#account-menu-panel-approvals')!
      expect(panel.style.display).not.toBe('none')

      wikiStore.user = { ...user(1), name: '', permissions: [] }
      siteNotifications.approvals = []
      await settle()
      expect(mounted.host.querySelector('.account-menu__tab[data-tab="approvals"]')).toBeNull()
      expect(mounted.host.querySelector('.account-menu__tab[aria-selected="true"]')?.getAttribute('data-tab')).toBe('notifications')
      const trigger = mounted.host.querySelector<HTMLElement>('.account-menu__trigger')!
      expect(trigger.querySelector('.account-menu__initials')).toBeNull()
      expect(trigger.textContent).toContain('mdi-account-circle')
    } finally {
      siteNotifications.approvals = []
      siteNotifications.approvalsNextCursor = null
    }
  })
})

describe('notification header tri-state indicator', () => {
  it('announces localized available, unknown, and clear states', async () => {
    const mounted = await mountHeader()
    const button = () => mounted.host.querySelector<HTMLElement>('.account-menu__trigger')
    const indicator = () => mounted.host.querySelector<HTMLElement>('.account-menu__notification-indicator')
    expect(button()?.getAttribute('aria-label')).toBe('Localized account, Localized notifications available')
    expect(indicator()?.classList.contains('account-menu__notification-indicator--available')).toBe(true)

    siteNotifications.notificationState = 'unknown'
    await settle()
    expect(indicator()?.classList.contains('account-menu__notification-indicator--unknown')).toBe(true)
    expect(button()?.getAttribute('aria-label')).toBe('Localized account, Localized notification status not fully checked')

    siteNotifications.notificationState = 'clear'
    await settle()
    expect(indicator()).toBeNull()
    expect(button()?.getAttribute('aria-label')).toBe('Localized account')
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
    expect(host.querySelector('.account-menu__offline .account-offline-summary__manage')?.getAttribute('href')).toBe('/p/offline')

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

  it('keeps native logout connected through auth retirement and retires Agent continuity before submission', async () => {
    const boundary = Promise.withResolvers<boolean>()
    globals.__headerInvalidateOfflineIdentity = () => boundary.promise
    const { host } = await mountHeader()
    const form = host.querySelector('form[action="/logout"]')
    if (!form) throw new Error('Logout form missing')
    let submitted = false
    Object.defineProperty(form, 'submit', {
      value: () => {
        expect(agentDestroyCalls).toBe(1)
        expect(form.isConnected).toBe(true)
        submitted = true
      }
    })
    form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    expect(agentDestroyCalls).toBe(1)
    expect(submitted).toBe(false)
    wikiStore.user = user(0, false)
    wikiStore.offlineIdentityReady = false
    await settle()
    expect(host.querySelector('form[action="/logout"]')).toBe(form)
    expect(form.isConnected).toBe(true)
    expect(submitted).toBe(false)
    boundary.resolve(true)
    await settle()
    expect(submitted).toBe(true)
  })

  it('does not submit logout when local identity cleanup fails', async () => {
    globals.__headerInvalidateOfflineIdentity = async () => false
    const { host } = await mountHeader()
    const form = host.querySelector('form[action="/logout"]')
    if (!form) throw new Error('Logout form missing')
    let submitted = false
    Object.defineProperty(form, 'submit', { value: () => { submitted = true } })
    form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(submitted).toBe(false)
    expect(form.getAttribute('aria-busy')).toBeNull()
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
    // Sign-out stays focusable and explains why it is paused; submit is blocked in code.
    expect(form?.querySelector('[type="submit"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(form?.textContent).toContain('Reconnect to sign out.')
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
