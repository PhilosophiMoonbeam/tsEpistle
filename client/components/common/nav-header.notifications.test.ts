import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import type { Component } from 'vue'
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
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLButtonElement: browserWindow.HTMLButtonElement,
  HTMLElement: browserWindow.HTMLElement,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  Text: browserWindow.Text
}
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
if (!browserWindow.requestAnimationFrame) {
  browserWindow.requestAnimationFrame = callback => browserWindow.setTimeout(callback, 0)
  browserWindow.cancelAnimationFrame = handle => browserWindow.clearTimeout(handle)
}

const VueRuntime = await import('vue')
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
  __headerWikiStore: typeof wikiStore
  __headerSiteNotifications: typeof siteNotifications
  siteConfig: Record<string, unknown>
  siteLangs: Array<{ code: string; name: string }>
}
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
            return { contents: 'export const wikiStore = globalThis.__headerWikiStore', loader: 'js' }
          }
          if (args.path === '../../store/site-notifications.ts') {
            return { contents: 'export const useSiteNotificationsStore = () => globalThis.__headerSiteNotifications', loader: 'js' }
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
            return { contents: 'export const emitSearchEnter=()=>{}; export const emitSearchExit=()=>{}; export const emitSearchMove=()=>{}', loader: 'js' }
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
  exports: { default?: Component }
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

const mountHeader = async () => {
  const host = browserWindow.document.createElement('div')
  browserWindow.document.body.append(host)
  const app = VueRuntime.createApp(NavHeader, { dense: true, hideSearch: true })
  app.component('v-menu', slotForwardingStub)
  app.component('v-tooltip', slotForwardingStub)
  app.config.globalProperties.$t = translate
  app.config.globalProperties.$vuetify = {
    display: { smAndDown: false, mdAndUp: true },
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
  calls.splice(0)
  translationCalls.splice(0)
  wikiStore.user = user(1)
  siteNotifications.ownerId = 1
  siteNotifications.identityStale = false
  siteNotifications.notificationState = 'unknown'
  refreshAuthBehavior = async () => 'authenticated'
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

describe('notification header tri-state indicator', () => {
  it('announces localized available, unknown, and clear states while keeping account-menu as the only scroller', async () => {
    const mounted = await mountHeader()
    const button = () => mounted.host.querySelector<HTMLElement>('.account-menu__trigger')
    const indicator = () => mounted.host.querySelector<HTMLElement>('.account-menu__notification-indicator')

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
