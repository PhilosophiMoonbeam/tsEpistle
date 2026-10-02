import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, setLocation } from './browser-dom.mts'
import * as Vue from 'vue'
import moment from 'moment-timezone'
import * as presentation from '../helpers/index.ts'
import * as offlinePresentation from '../helpers/offline-presentation.ts'
import type { AuthRefreshOutcome } from '../store/index.ts'
import type { UserPresentationDefaults } from '../../shared/user-presentation.ts'

const filename = fileURLToPath(new URL('../offline-app.vue', import.meta.url))
const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
if (errors.length) throw new Error(`Cannot parse offline-app.vue: ${errors}`)
const compiled = compileScript(descriptor, { id: 'offline-date-lifecycle', genDefaultAs: 'OfflineApp', inlineTemplate: true })
const imports = babelParse(compiled.content, { sourceType: 'module', plugins: ['typescript'] }).program.body.filter(node => node.type === 'ImportDeclaration')
let script = compiled.content
for (const declaration of [...imports].reverse()) {
  script = script.slice(0, declaration.start!) + script.slice(declaration.end!)
}
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script + '\nreturn OfflineApp')

// Compile the real shell, replacing only external services and visual children.
// The date consumer deliberately uses the real reactive presentation helpers.
function shellComponent(modules: Record<string, Record<string, unknown>>): Vue.Component {
  const bindings: Record<string, unknown> = {}
  for (const declaration of imports) {
    if (declaration.importKind === 'type') continue
    const module: Record<string, unknown> = declaration.source.value === 'vue' ? Vue : modules[declaration.source.value]
    if (!module) throw new Error(`Missing shell dependency: ${declaration.source.value}`)
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
      bindings[specifier.local.name] = specifier.type === 'ImportDefaultSpecifier'
        ? module.default
        : specifier.type === 'ImportNamespaceSpecifier'
          ? module
          : module[specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value]
    }
  }
  return new Function(...Object.keys(bindings), executable)(...Object.values(bindings)) as Vue.Component
}

const instant = '2026-01-31T12:00:00.000Z'
const defaults = { timezone: '', dateFormat: '', timeFormat: 'locale' } as const
const cached = { timezone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' } as const
const reconnected = { timezone: 'Europe/Berlin', dateFormat: 'DD/MM/YYYY', timeFormat: '12h' } as const
const datesKey = 'tsepistle.offline.dates.v1'
const passthrough = Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('div', slots.default?.()) })
const empty = Vue.defineComponent({ setup: () => () => null })
const DateSettings = Vue.defineComponent({
  setup: () => () => Vue.h('output', { 'data-reader-dates': '', 'data-reader-zone': String(presentation.helpers.timeZoneKnown()) }, String(presentation.helpers.formatMoment(instant, 'L LT')))
})
let app: Vue.App | undefined
const originalLocale = moment.locale()
const originalLocation = browserWindow.location.href
const settle = async () => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.replaceChildren()
  presentation.applyUserPresentation(defaults)
  moment.locale(originalLocale)
  setLocation(originalLocation)
  vi.unstubAllGlobals()
})

describe('offline shell reader-date authentication lifecycle', () => {
  it('preserves cached dates through unavailable startup and updates reactive settings after reconnect and confirmed logout without navigation', async () => {
    setLocation('/p/offline')
    const values = new Map<string, string>([['unrelated-presentation-setting', 'preserved']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
    vi.stubGlobal('siteConfig', { title: 'Offline test', lang: 'en' })
    moment.locale('en')
    presentation.applyUserPresentation(defaults)
    offlinePresentation.rememberReaderDates(cached)
    // This is the cache restoration performed by mountOfflineApp before mount.
    presentation.applyUserPresentation(offlinePresentation.savedReaderDates()!)
    const cachedBytes = values.get(datesKey)
    const pending: Array<(outcome: AuthRefreshOutcome) => void> = []
    const store = Vue.reactive({
      page: { title: '', mode: 'view' },
      user: { authenticated: false, ...defaults } as UserPresentationDefaults & { authenticated: boolean },
      authRefreshOutcome: null as AuthRefreshOutcome | null,
      refreshAuth: vi.fn(() => {
        store.authRefreshOutcome = null
        return new Promise<AuthRefreshOutcome>(resolve => pending.push(resolve))
      })
    })
    const pwaState = Vue.reactive({ connectionState: 'online' })
    const component = shellComponent({
      './components/pwa/offline-library.vue': { default: empty },
      './components/pwa/offline-navigation.vue': { default: empty },
      './components/pwa/offline-settings.vue': { default: DateSettings },
      './helpers/offline-storage.ts': { openOfflineStorage: async () => { throw new Error('IndexedDB unavailable') } },
      './helpers/offline-session.ts': { currentOfflineReadingHandle: () => null, OFFLINE_READING_STATE_EVENT: 'test-reading-state' },
      './helpers/offline-sync.ts': { OFFLINE_SYNC_COORDINATOR_KEY: 'offline-sync-coordinator', createOfflineSyncUnavailableResult: () => ({ status: 'unavailable' }), createOfflineSyncCoordinator: () => { throw new Error('No storage') } },
      './helpers/pwa.ts': { pwaState, retryServerConnection: async () => true },
      './store/index.ts': { wikiStore: store },
      './helpers/use-translate.ts': { useTranslate: () => (key: string) => key },
      './helpers/index.ts': presentation,
      './helpers/offline-presentation.ts': offlinePresentation
    })
    app = Vue.createApp(component)
    for (const name of ['v-app', 'v-navigation-drawer', 'v-main', 'v-icon', 'v-btn', 'v-alert', 'nav-header', 'search-results', 'notify']) app.component(name, passthrough)
    app.config.globalProperties.$vuetify = { display: { mdAndUp: true, smAndDown: false } }
    app.config.globalProperties.$t = (key: string) => key
    const host = document.createElement('div')
    document.body.append(host)
    app.mount(host)
    await settle()
    const dates = () => host.querySelector('output')!
    expect(pending).toHaveLength(1)
    expect(dates().textContent).toBe('2026-01-31 07:00')
    expect(values.get(datesKey)).toBe(cachedBytes)

    async function publish(outcome: AuthRefreshOutcome, user?: typeof store.user): Promise<void> {
      if (user) store.user = user
      store.authRefreshOutcome = outcome
      pending.shift()!(outcome)
      await settle()
    }
    async function reconnect(): Promise<void> {
      pwaState.connectionState = 'offline'
      await settle()
      pwaState.connectionState = 'online'
      await settle()
    }
    await publish('unavailable')
    expect(dates().textContent).toBe('2026-01-31 07:00')
    expect(values.get(datesKey)).toBe(cachedBytes)
    expect(offlinePresentation.savedReaderDates()).toEqual(cached)

    await reconnect()
    expect(values.get(datesKey)).toBe(cachedBytes)
    await publish('authenticated', { authenticated: true, ...reconnected })
    expect(dates().textContent).toBe('31/01/2026 1:00 PM')
    expect(dates().getAttribute('data-reader-zone')).toBe('true')
    expect(offlinePresentation.savedReaderDates()).toEqual(reconnected)

    // A pending account boundary can reset user defaults before verification.
    // If that verification is unavailable, it must not act as a sign-out.
    await reconnect()
    store.user = { authenticated: false, ...defaults }
    await settle()
    expect(dates().textContent).toBe('31/01/2026 1:00 PM')
    await publish('unavailable')
    expect(offlinePresentation.savedReaderDates()).toEqual(reconnected)
    expect(dates().textContent).toBe('31/01/2026 1:00 PM')

    await reconnect()
    await publish('anonymous', { authenticated: false, ...defaults })
    const browserDate = new Date(instant)
    const pad = (value: number) => String(value).padStart(2, '0')
    const browserDates = `${pad(browserDate.getMonth() + 1)}/${pad(browserDate.getDate())}/${browserDate.getFullYear()} ${browserDate.getHours() % 12 || 12}:${pad(browserDate.getMinutes())} ${browserDate.getHours() >= 12 ? 'PM' : 'AM'}`
    expect(dates().textContent).toBe(browserDates)
    expect(dates().getAttribute('data-reader-zone')).toBe('false')
    expect(values.has(datesKey)).toBe(false)
    expect(offlinePresentation.savedReaderDates()).toBeNull()
    expect(values.get('unrelated-presentation-setting')).toBe('preserved')
    expect(browserWindow.location.pathname).toBe('/p/offline')
    expect(dates().isConnected).toBe(true)
  })
})
