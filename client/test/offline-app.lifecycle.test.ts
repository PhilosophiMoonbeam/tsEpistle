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
import type { OfflinePageSnapshotV1, OfflineSnapshotRecord, OfflineSnapshotSelector } from '../../shared/offline.ts'
import { OfflineStorageError, type OfflineStorageGenerationOptions, type OfflineStorageNoticeListener } from '../helpers/offline-storage.ts'
import type { OfflineReadingHandleV1 } from '../helpers/offline-session.ts'
import * as offlineSearch from '../helpers/offline-search.ts'
import * as offlineRoutes from '../helpers/offline-routes.ts'
import * as offlineRenderer from '../helpers/offline-renderer.ts'
import { offlineServerReasonDetail } from '../helpers/offline-page-status.ts'
import { createOfflineSyncUnavailableResult, OFFLINE_SYNC_COORDINATOR_KEY, type OfflineSyncService } from '../helpers/offline-sync.ts'

function compileComponent(relativePath: string, id: string): (modules: Record<string, Record<string, unknown>>) => Vue.Component {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url))
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  if (errors.length) throw new Error(`Cannot parse ${relativePath}: ${errors}`)
  const compiled = compileScript(descriptor, { id, genDefaultAs: 'TestComponent', inlineTemplate: true })
  const imports = babelParse(compiled.content, { sourceType: 'module', plugins: ['typescript'] }).program.body.filter(node => node.type === 'ImportDeclaration')
  let script = compiled.content
  for (const declaration of [...imports].reverse()) {
    script = script.slice(0, declaration.start!) + script.slice(declaration.end!)
  }
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script + '\nreturn TestComponent')

  // Exercise real component behavior, replacing only storage/session services
  // and visual children, never the selection, policy or removal logic.
  return modules => {
    const bindings: Record<string, unknown> = {}
    for (const declaration of imports) {
      if (declaration.importKind === 'type') continue
      const module: Record<string, unknown> = declaration.source.value === 'vue' ? Vue : modules[declaration.source.value]
      if (!module) throw new Error(`Missing component dependency: ${declaration.source.value}`)
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
}
const shellComponent = compileComponent('../offline-app.vue', 'offline-date-lifecycle')
const libraryComponent = compileComponent('../components/pwa/offline-library.vue', 'offline-library-lifecycle')
const settingsComponent = compileComponent('../components/pwa/offline-settings.vue', 'offline-settings-lifecycle')

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
const originalScrollY = Object.getOwnPropertyDescriptor(browserWindow, 'scrollY')
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
  vi.restoreAllMocks()
  if (originalScrollY) Object.defineProperty(browserWindow, 'scrollY', originalScrollY)
  else Reflect.deleteProperty(browserWindow, 'scrollY')
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

const lifecycleTranslate = (key: string, options: Record<string, unknown> = {}): string => {
  const labels: Record<string, string> = {
    'common:offlineLibrary.manual': 'Manual',
    'common:offlineLibrary.automatic': 'Automatic',
    'common:offlineLibrary.tagSubscription': 'Tag subscription',
    'common:offlineLibrary.policyDetailsUnavailable': 'Policy details unavailable',
    'common:offlineLibrary.provenance2': `Provenance: ${options.record}`,
    'common:offlineLibrary.availability2': `Availability: ${options.record}`
  }
  return labels[key] ?? String(options.defaultValue ?? key).replace(/\{\{(\w+)\}\}/gu, (_match, name: string) => String(options[name] ?? ''))
}

async function savedRecord(siteId: string, pageId: number, title: string, html = `<p>${title} body</p>`): Promise<OfflineSnapshotRecord> {
  const snapshot: OfflinePageSnapshotV1 = {
    schemaVersion: 1, pageId, locale: 'en', path: `saved/${pageId}`, canonicalPath: `saved/${pageId}`,
    title, description: '', sourceRevision: 'r1', capturedAt: '2026-09-01T00:00:00.000Z', expiresAt: null,
    content: { representation: 'sanitized-html-fragment', sanitizerVersion: 'offline-html-allowlist-v1', html },
    searchText: `${title} body`, contentType: 'sanitized-html-fragment', integrity: 'pending'
  }
  snapshot.integrity = await offlineRenderer.offlineSnapshotIntegrity(snapshot)
  return { siteId, pageId, locale: 'en', snapshot, lastOpenedAt: snapshot.capturedAt, byteSize: 512 }
}

async function offlineFixture(options: { privateVault?: boolean; unlocked?: boolean; privateOnly?: boolean; guest?: boolean } = {}) {
  setLocation('/p/offline')
  vi.stubGlobal('siteConfig', { title: 'Saved reader test', lang: 'en' })
  const origin = browserWindow.location.origin
  const privateSite = 'current-private-site'
  const handle = {
    context: { canonicalOrigin: origin, siteId: privateSite, accountId: 1, authVersion: 1, keyId: 'A'.repeat(22) },
    sessionGeneration: 0
  } as unknown as OfflineReadingHandleV1
  const state = {
    generation: 0, revision: 1, epoch: 0,
    activeHandle: options.unlocked ? handle : null as OfflineReadingHandleV1 | null,
    publicBodies: options.privateOnly ? [] : [await savedRecord(origin, 1, 'Reader A'), await savedRecord(origin, 2, 'Reader B')],
    privateBodies: options.privateVault ? [await savedRecord(privateSite, 1, 'Private reader')] : [],
    publicPolicyRevision: 3, privatePolicyRevision: 17,
    beforePolicyRead: null as ((options: OfflineStorageGenerationOptions) => Promise<void>) | null
  }
  const listeners = new Set<OfflineStorageNoticeListener>()
  const pendingPreparations = new Set<Promise<unknown>>()
  const settleLibrary = () => settleOffline(pendingPreparations)
  const publish = (kind: 'corpus' | 'generation' | 'policy') => {
    for (const listener of listeners) listener({ kind, sessionGeneration: state.generation, corpusRevision: state.revision })
  }
  const check = (opts: OfflineStorageGenerationOptions) => {
    if (opts.expectedSessionGeneration !== undefined && opts.expectedSessionGeneration !== state.generation)
      throw new OfflineStorageError('generation-fenced', 'Session changed.')
    if (opts.readingHandle && opts.readingHandle !== state.activeHandle)
      throw new OfflineStorageError('generation-fenced', 'Private reading changed.')
    const revision = opts.readingHandle ? state.privatePolicyRevision : state.publicPolicyRevision
    if (opts.expectedPolicyRevision !== undefined && opts.expectedPolicyRevision !== revision)
      throw new OfflineStorageError('policy-revision-fenced', 'Policy changed.')
  }
  const policyFor = (privateAudience: boolean) => ({
    sessionGeneration: state.generation,
    state: {
      key: 'state', recordType: 'state', schemaVersion: 1, automaticSavingEnabled: false, selectedTags: [],
      policyRevision: privateAudience ? state.privatePolicyRevision : state.publicPolicyRevision, byteSize: 1,
      syncDiagnostics: { status: 'idle', lastAttemptAt: null, lastSuccessAt: null, lastError: null, pendingCount: 0, retainedCount: 0, removedCount: 0 }
    },
    pages: (privateAudience ? state.privateBodies : state.publicBodies).map(record => ({
      key: `${record.siteId}/${record.pageId}/${record.locale}`, recordType: 'page', schemaVersion: 1,
      siteId: record.siteId, pageId: record.pageId, locale: record.locale,
      manual: !privateAudience, automatic: false, tag: privateAudience, tagNames: [],
      availability: privateAudience ? 'transient-failure' : 'available', excluded: false,
      visitCount: 0, lastVisitedAt: null, lastEditedAt: null, automaticSelectedAt: null, byteSize: 1
    }))
  })
  const storage = {
    close: vi.fn(),
    currentSessionGeneration: async () => state.generation,
    getReadingVault: async () => options.privateVault ? { keyId: handle.context.keyId } : null,
    storageStatus: async () => ({ snapshotCount: state.publicBodies.length + state.privateBodies.length, managedBytes: 512, persisted: false, usageBytes: null, quotaBytes: null, lockedDraftCount: 0 }),
    readOfflinePolicy: vi.fn(async (opts: OfflineStorageGenerationOptions = {}) => {
      await state.beforePolicyRead?.(opts)
      check(opts)
      return policyFor(Boolean(opts.readingHandle))
    }),
    readSnapshotCorpus: vi.fn(async (opts: OfflineStorageGenerationOptions & { selector?: OfflineSnapshotSelector } = {}) => {
      check(opts)
      if (opts.expectedCorpusRevision !== undefined && opts.expectedCorpusRevision !== state.revision)
        throw new OfflineStorageError('transaction', 'Corpus changed.')
      const bodies = opts.readingHandle ? state.privateBodies : state.publicBodies
      return {
        sessionGeneration: state.generation, corpusRevision: state.revision,
        snapshots: structuredClone(bodies.filter(record => !opts.selector || (
          record.siteId === opts.selector.siteId && record.pageId === opts.selector.pageId && record.locale === opts.selector.locale
        )))
      }
    }),
    markSnapshotOpened: vi.fn(async () => true),
    removeOfflinePage: vi.fn(async (selector: OfflineSnapshotSelector, opts: OfflineStorageGenerationOptions) => {
      check(opts)
      const keep = (record: OfflineSnapshotRecord) => record.siteId !== selector.siteId || record.pageId !== selector.pageId
      if (opts.readingHandle) {
        state.privateBodies = state.privateBodies.filter(keep)
        state.privatePolicyRevision += 1
      } else {
        state.publicBodies = state.publicBodies.filter(keep)
        state.publicPolicyRevision += 1
      }
      state.revision += 1
      publish('corpus')
      publish('policy')
    })
  }
  const sessionModule = {
    currentOfflineReadingHandle: () => state.activeHandle,
    currentOfflineReadingEpoch: () => state.epoch,
    isCurrentOfflineReadingHandle: (candidate: OfflineReadingHandleV1) => candidate === state.activeHandle && candidate.sessionGeneration === state.generation,
    OFFLINE_READING_STATE_EVENT: 'test-private-reading-change',
    OFFLINE_SESSION_INVALIDATED_EVENT: 'test-session-invalidated',
    lockOfflineReading: () => {
      state.activeHandle = null
      state.epoch += 1
      browserWindow.dispatchEvent(new browserWindow.Event('test-private-reading-change'))
    }
  }
  const modules: Record<string, Record<string, unknown>> = {
    '../../helpers/offline-storage.ts': {
      OfflineStorageError, openOfflineStorage: async () => storage,
      subscribeOfflineStorageChanges: (listener: OfflineStorageNoticeListener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    '../../helpers/offline-search.ts': {
      ...offlineSearch,
      prepareOfflineSearchCorpus: (...args: Parameters<typeof offlineSearch.prepareOfflineSearchCorpus>) => {
        const preparation = offlineSearch.prepareOfflineSearchCorpus(...args)
        pendingPreparations.add(preparation)
        void preparation.then(
          () => pendingPreparations.delete(preparation),
          () => pendingPreparations.delete(preparation)
        )
        return preparation
      }
    },
    '../../helpers/offline-routes.ts': offlineRoutes,
    '../../helpers/offline-renderer.ts': offlineRenderer,
    '../../helpers/offline-page-status.ts': { offlineServerReasonDetail },
    '../../helpers/index.ts': presentation,
    '../../helpers/offline-session.ts': sessionModule,
    '../../helpers/offline-sync.ts': { OFFLINE_SYNC_COORDINATOR_KEY, createOfflineSyncUnavailableResult },
    '../../helpers/use-translate.ts': { useTranslate: () => lifecycleTranslate },
    '../../store/index.ts': { wikiStore: Vue.reactive({ authRefreshOutcome: options.guest ? 'anonymous' : 'authenticated', offlineIdentityReady: true, user: { authenticated: !options.guest, id: 1, authVersion: 1 } }) },
    '../../helpers/pwa.ts': { notifyReloadSafetyChanged: () => undefined, setReloadSafetyProvider: () => undefined },
    '../common/modal-focus-scope.ts': { createModalFocusScope: () => { throw new Error('Unexpected modal in library regression') } },
    './pwa-status.vue': { default: empty }
  }
  const library = libraryComponent(modules)
  modules['./offline-library.vue'] = { default: library }
  const mount = async (settings = false) => {
    const props = Vue.reactive({ storage, storageState: 'available', showSettings: true, refreshToken: 0 })
    app = Vue.createApp(settings ? settingsComponent(modules) : Vue.defineComponent({ setup: () => () => Vue.h(library, props) }))
    app.provide<OfflineSyncService>(OFFLINE_SYNC_COORDINATOR_KEY, {
      reconcile: async () => createOfflineSyncUnavailableResult('No server connection in lifecycle fixture.')
    })
    for (const name of ['v-container', 'v-avatar', 'v-icon', 'v-card', 'v-chip', 'v-divider', 'v-alert']) app.component(name, passthrough)
    app.component('v-btn', Vue.defineComponent({ setup: (_props, { attrs, slots }) => () => Vue.h('button', attrs, slots.default?.()) }))
    app.component('v-text-field', empty)
    app.config.globalProperties.$t = lifecycleTranslate
    const errors: unknown[] = []
    app.config.errorHandler = error => errors.push(error)
    const host = document.createElement('div')
    document.body.append(host)
    app.mount(host)
    await settleLibrary()
    return { host, props, errors }
  }
  return { origin, privateSite, handle, state, storage, publish, mount, sessionModule, settle: settleLibrary }
}

async function settleOffline(pendingPreparations: ReadonlySet<Promise<unknown>>) {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve()
    // Await the real preparation signal: it yields beyond the microtask queue.
    // Rejected preparations are handled by the component (including cancellation).
    if (pendingPreparations.size) await Promise.allSettled([...pendingPreparations])
    await Vue.nextTick()
  }
}

describe('saved-page reader and library settings lifecycle', () => {
  it('focuses direct and in-app saved-page fragments in the guest-capable settings surface', async () => {
    const fixture = await offlineFixture({ guest: true })
    setLocation('/p/offline#downloaded-pages-title')
    const scroll = vi.spyOn(browserWindow.Element.prototype, 'scrollIntoView')
    const { host, errors } = await fixture.mount(true)
    const heading = host.querySelector('#downloaded-pages-title')!
    expect(document.activeElement).toBe(heading)
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })

    host.querySelector<HTMLElement>('h1')!.setAttribute('tabindex', '-1')
    host.querySelector<HTMLElement>('h1')!.focus()
    setLocation('/p/offline#offline-policy-title')
    browserWindow.dispatchEvent(new browserWindow.Event('hashchange'))
    await Vue.nextTick()
    expect(host.querySelector('details')!.open).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('#offline-policy-title'))
    expect(errors).toEqual([])
  })

  it('keeps the current article DOM, URL, focus and position when another saved page changes', async () => {
    const fixture = await offlineFixture()
    const { host, props, errors } = await fixture.mount()
    host.querySelector<HTMLButtonElement>('.page-card .secondary-button')!.click()
    await vi.waitFor(() => expect(host.querySelector('.offline-page-body')?.textContent).toBe('Reader A body'))
    const body = host.querySelector<HTMLElement>('.offline-page-body')!
    const paragraph = body.querySelector('p')
    const heading = document.activeElement
    const url = browserWindow.location.href
    body.scrollTop = 123
    let windowScrollY = 456
    Object.defineProperty(browserWindow, 'scrollY', { configurable: true, get: () => windowScrollY })
    vi.spyOn(browserWindow, 'scrollTo').mockImplementation((leftOrOptions: ScrollToOptions | number, top?: number) => {
      windowScrollY = typeof leftOrOptions === 'object' ? leftOrOptions.top ?? windowScrollY : top ?? windowScrollY
    })

    fixture.state.publicBodies[1] = await savedRecord(fixture.origin, 2, 'Reader B updated')
    fixture.state.revision += 1
    fixture.publish('corpus')
    props.refreshToken += 1
    await fixture.settle()

    expect(body.querySelector('p')).toBe(paragraph)
    expect(body.textContent).toBe('Reader A body')
    expect(body.scrollTop).toBe(123)
    expect(browserWindow.location.href).toBe(url)
    expect(document.activeElement).toBe(heading)
    expect(browserWindow.scrollY).toBe(456)
    const back = [...host.querySelectorAll<HTMLButtonElement>('.reader-actions button')].find(button => button.textContent === 'common:offlineLibrary.backSavedPages')!
    back.click()
    await vi.waitFor(() => expect(host.querySelector('.page-list')?.textContent).toContain('Reader B updated'))
    expect(errors).toEqual([])
  })

  it('finishes opening the live selection when an unrelated corpus reload was already awaiting storage', async () => {
    const fixture = await offlineFixture()
    const { host, errors } = await fixture.mount()
    const { promise: reachedRead, resolve: started } = Promise.withResolvers<void>()
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    fixture.state.beforePolicyRead = async () => {
      started()
      await gate
    }
    fixture.state.publicBodies[1] = await savedRecord(fixture.origin, 2, 'Reader B updated')
    fixture.state.revision += 1
    fixture.publish('corpus')
    await reachedRead
    host.querySelector<HTMLButtonElement>('.page-card .secondary-button')!.click()
    release()

    await vi.waitFor(() => expect(host.querySelector('.offline-page-body')?.textContent).toBe('Reader A body'))
    expect(host.querySelector('#offline-reader-status')!.classList.contains('is-ready')).toBe(true)
    expect(errors).toEqual([])
  })

  it('renders a changed authoritative selected body without resetting its reading position', async () => {
    const fixture = await offlineFixture()
    const { host, errors } = await fixture.mount()
    host.querySelector<HTMLButtonElement>('.page-card .secondary-button')!.click()
    await vi.waitFor(() => expect(host.querySelector('.offline-page-body')?.textContent).toBe('Reader A body'))
    const body = host.querySelector<HTMLElement>('.offline-page-body')!
    body.scrollTop = 90
    const url = browserWindow.location.href
    fixture.state.publicBodies[0] = await savedRecord(fixture.origin, 1, 'Reader A', '<p>New authoritative body</p>')
    fixture.state.revision += 1
    fixture.publish('corpus')
    await vi.waitFor(() => expect(host.querySelector('.offline-page-body')?.textContent).toBe('New authoritative body'))

    expect(host.querySelector('.offline-page-body')!.textContent).toBe('New authoritative body')
    expect(body.scrollTop).toBe(90)
    expect(browserWindow.location.href).toBe(url)
    expect(errors).toEqual([])
  })

  it('clears a removed or expired selected page and immediately clears an identity generation boundary', async () => {
    const fixture = await offlineFixture()
    const { host, errors } = await fixture.mount()
    const openFirst = async () => {
      host.querySelector<HTMLButtonElement>('.page-card .secondary-button')!.click()
      await vi.waitFor(() => expect(host.querySelector('.offline-page-body')?.textContent).toBe('Reader A body'))
      expect(host.querySelector('.offline-page-body')!.textContent).toBe('Reader A body')
    }
    await openFirst()
    fixture.state.publicBodies = fixture.state.publicBodies.slice(1)
    fixture.state.revision += 1
    fixture.publish('corpus')
    await fixture.settle()
    expect(host.querySelector('.offline-reader')).toBeNull()

    fixture.state.publicBodies.unshift(await savedRecord(fixture.origin, 1, 'Reader A'))
    fixture.state.revision += 1
    fixture.publish('corpus')
    await fixture.settle()
    await openFirst()
    fixture.state.publicBodies[0]!.snapshot.expiresAt = '2026-01-01T00:00:00.000Z'
    fixture.state.revision += 1
    fixture.publish('corpus')
    await fixture.settle()
    expect(host.querySelector('.offline-reader')).toBeNull()

    fixture.state.publicBodies[0] = await savedRecord(fixture.origin, 1, 'Reader A')
    fixture.state.revision += 1
    fixture.publish('corpus')
    await fixture.settle()
    await openFirst()
    fixture.state.generation += 1
    fixture.publish('generation')
    expect(host.querySelector('.offline-page-body')!.textContent).toBe('')
    await fixture.settle()
    expect(host.querySelector('.offline-reader')).toBeNull()
    expect(errors).toEqual([])
  })

  it('clears the selected reader at its expiry deadline without waiting for the minute refresh', async () => {
    let now = Date.parse('2026-09-01T12:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fixture = await offlineFixture()
    const expiring = fixture.state.publicBodies[0]!
    expiring.snapshot.expiresAt = new Date(now + 1500).toISOString()
    expiring.snapshot.integrity = await offlineRenderer.offlineSnapshotIntegrity(expiring.snapshot)
    const { host, errors } = await fixture.mount()
    let fireExpiry: (() => void) | undefined
    let scheduledDelay: number | undefined
    vi.spyOn(browserWindow, 'setTimeout').mockImplementation((handler: TimerHandler, delay?: number) => {
      if (typeof handler === 'function') fireExpiry = handler as () => void
      scheduledDelay = delay
      return 9_000_001
    })
    vi.spyOn(browserWindow, 'clearTimeout').mockImplementation(() => undefined)
    host.querySelector<HTMLButtonElement>('.page-card .secondary-button')!.click()
    await vi.waitFor(() => expect(host.querySelector('.offline-page-body')?.textContent).toBe('Reader A body'))
    expect(scheduledDelay).toBe(1500)
    expect(fireExpiry).toBeDefined()

    now += 1500
    fireExpiry!()
    await Vue.nextTick()
    expect(host.querySelector('.offline-reader')).toBeNull()
    expect(errors).toEqual([])
  })

  it('keeps public provenance after private unlock and puts cards before the closed policy disclosure', async () => {
    const fixture = await offlineFixture({ privateVault: true })
    const { host, errors } = await fixture.mount()
    const publicCard = () => [...host.querySelectorAll('.page-card')].find(card => card.textContent!.includes('Reader A'))!
    expect(publicCard().textContent).toContain('Provenance: Manual')
    fixture.state.activeHandle = fixture.handle
    fixture.state.epoch += 1
    browserWindow.dispatchEvent(new browserWindow.Event('test-private-reading-change'))
    await fixture.settle()

    expect(publicCard().textContent).toContain('Provenance: Manual')
    expect(publicCard().textContent).toContain('Availability: available')
    const privateCard = [...host.querySelectorAll('.page-card')].find(card => card.textContent!.includes('Private reader'))!
    expect(privateCard.textContent).toContain('Provenance: Tag subscription')
    expect(privateCard.textContent).toContain('Availability: transient-failure')
    const disclosure = host.querySelector('details')!
    expect(disclosure.open).toBe(false)
    expect(disclosure.querySelector('summary')!.textContent).toContain('common:offlineLibrary.whatGetsSaved')
    expect(host.querySelector('.page-list')!.compareDocumentPosition(disclosure) & browserWindow.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(errors).toEqual([])
  })

  it('removes current-site public and current unlocked-vault copies, leaving other sites untouched with truthful completion', async () => {
    const fixture = await offlineFixture({ privateVault: true, unlocked: true })
    fixture.state.publicBodies.push(await savedRecord('https://other.test', 9, 'Other site'))
    const { host, errors } = await fixture.mount(true)
    const remove = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'common:offlineSettings.removeSavedPages')!
    expect(remove.disabled).toBe(false)
    remove.click()
    await vi.waitFor(() => expect(host.textContent).toContain('Public saved pages for this site and saved pages in the unlocked private vault were removed.'))

    expect(fixture.state.publicBodies.map(record => record.snapshot.title)).toEqual(['Other site'])
    expect(fixture.state.privateBodies).toEqual([])
    expect(fixture.storage.removeOfflinePage).toHaveBeenCalledWith(
      { siteId: fixture.privateSite, pageId: 1, locale: 'en' },
      { readingHandle: fixture.handle, expectedSessionGeneration: 0, expectedPolicyRevision: 17 }
    )
    expect(host.textContent).toContain('Public saved pages for this site and saved pages in the unlocked private vault were removed.')
    expect(host.textContent).not.toContain('all saved pages')
    expect(errors).toEqual([])
  })

  it('requires unlocking a locked private-only library instead of silently removing nothing', async () => {
    const fixture = await offlineFixture({ privateVault: true, privateOnly: true })
    const { host, errors } = await fixture.mount(true)
    const remove = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'common:offlineSettings.removeSavedPages')!
    expect(remove.disabled).toBe(true)
    expect(host.querySelector('a[href="#offline-private-reading-title"]')!.textContent).toBe('Unlock private reading before removing saved pages.')
    remove.click()
    await fixture.settle()
    expect(fixture.storage.removeOfflinePage).not.toHaveBeenCalled()
    expect(fixture.state.privateBodies).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('stops bulk removal at a private-handle boundary without deleting the new vault or announcing completion', async () => {
    const fixture = await offlineFixture({ privateVault: true, unlocked: true, privateOnly: true })
    const { host, errors } = await fixture.mount(true)
    const { promise: reachedPrivateRead, resolve: started } = Promise.withResolvers<void>()
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    fixture.state.beforePolicyRead = async opts => {
      if (!opts.readingHandle) return
      started()
      await gate
    }
    const remove = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'common:offlineSettings.removeSavedPages')!
    remove.click()
    await reachedPrivateRead
    fixture.state.activeHandle = { ...fixture.handle, context: { ...fixture.handle.context, accountId: 2, keyId: 'B'.repeat(22) } } as OfflineReadingHandleV1
    fixture.state.epoch += 1
    release()
    await vi.waitFor(() => expect(host.textContent).toContain('Private reading changed.'))

    expect(fixture.storage.removeOfflinePage.mock.calls.some(([_selector, opts]) => opts.readingHandle)).toBe(false)
    expect(fixture.state.privateBodies).toHaveLength(1)
    expect(host.textContent).not.toContain('Public saved pages for this site and saved pages in the unlocked private vault were removed.')
    expect(errors).toEqual([])
  })
})
