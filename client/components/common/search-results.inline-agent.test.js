import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { browserWindow, document, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { createModalFocusScope, activeOwnedOverlayRoots } from './modal-focus-scope'
import { createSearchHighlighter } from '../../helpers/search-highlight.ts'
import { offlinePageHref, requestOfflineSavedPageOpen } from '../../helpers/offline-routes.ts'
import {
  OFFLINE_CONTENT_TYPE,
  OFFLINE_HTML_SANITIZER_VERSION,
  OfflinePagePolicyRecordSchema,
  OfflinePolicyStateSchema,
  OfflinePrivateSearchDocumentV1Schema,
  OfflineSnapshotRecordSchema
} from '../../../shared/offline.ts'
import { currentOfflineReadingEpoch, currentOfflineReadingHandle, OFFLINE_READING_STATE_EVENT } from '../../helpers/offline-session.ts'
import { readPrivateCorpus } from '../../helpers/offline-crypto.ts'
import { mergeOfflineSearchCorpora, prepareOfflineSearchCorpus, searchPreparedOfflineDocumentsAsync } from '../../helpers/offline-search.ts'
import * as workingSet from '../../helpers/page-working-set.ts'
import * as searchNavigation from '../../helpers/search-navigation-events.ts'
import * as readerActions from '../../helpers/page-action-events.ts'

const compileSearchMethods = (source, names, dependencies, section = 'methods') => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Search component script was not found.')

  const sourceFile = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let methods
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === section && ts.isObjectLiteralExpression(node.initializer)) {
      methods = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!methods) throw new Error(`Search component ${section} were not found.`)

  const selected = names === null ? null : new Set(names)
  const declarations = methods.properties.filter(node => ts.isMethodDeclaration(node) && (selected === null || selected.has(node.name.getText(sourceFile))))
  if (selected !== null && declarations.length !== selected.size) throw new Error('A requested search method was not found.')

  const factorySource = `(searchPages, getErrorMessage, wikiStore, useAgentsStore, isAgentSessionId, emptySearchResponse, retryServerConnection, openOfflineStorage, isOfflineSnapshotRecord, isOfflineSnapshotExpired, toOfflineSearchDocument, prepareOfflineSearchCorpus, searchPreparedOfflineDocumentsAsync, OFFLINE_SEARCH_RESULT_LIMIT, currentOfflineReadingHandle, currentOfflineReadingEpoch, mergeOfflineSearchCorpora, readPrivateCorpus, toOfflinePrivateSearchDocument, siteConfig) => ({${declarations.map(node => node.getText(sourceFile)).join(',')}})`
  const compiled = ts.transpileModule(`const factory = ${factorySource}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None
    }
  }).outputText
  const factory = new Function(`${compiled}\nreturn factory`)()
  return factory(
    dependencies.searchPages,
    dependencies.getErrorMessage,
    dependencies.wikiStore,
    dependencies.useAgentsStore,
    dependencies.isAgentSessionId,
    dependencies.emptySearchResponse,
    dependencies.retryServerConnection,
    dependencies.openOfflineStorage,
    dependencies.isOfflineSnapshotRecord,
    dependencies.isOfflineSnapshotExpired,
    dependencies.toOfflineSearchDocument,
    dependencies.prepareOfflineSearchCorpus,
    dependencies.searchPreparedOfflineDocumentsAsync,
    dependencies.OFFLINE_SEARCH_RESULT_LIMIT,
    dependencies.currentOfflineReadingHandle ?? currentOfflineReadingHandle,
    dependencies.currentOfflineReadingEpoch ?? currentOfflineReadingEpoch,
    dependencies.mergeOfflineSearchCorpora ?? mergeOfflineSearchCorpora,
    dependencies.readPrivateCorpus ?? readPrivateCorpus,
    dependencies.toOfflinePrivateSearchDocument,
    dependencies.siteConfig
  )
}

const compileSnapshotAdapters = source => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Search component script was not found.')
  const sourceFile = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set([
    'OFFLINE_LOCALE_PATTERN',
    'isOfflineLocale',
    'isOfflineSnapshotRecord',
    'isOfflineSnapshotExpired',
    'toOfflineSearchDocument',
    'toOfflinePrivateSearchDocument'
  ])
  const declarations = sourceFile.statements.filter(
    statement =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
  )
  if (declarations.length !== names.size) throw new Error('Offline snapshot adapters were not found.')
  const compiled = ts.transpileModule(
    `${declarations.map(node => node.getText(sourceFile)).join('\n')}\nreturn { isOfflineSnapshotRecord, isOfflineSnapshotExpired, toOfflineSearchDocument, toOfflinePrivateSearchDocument }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  return new Function('OfflinePrivateSearchDocumentV1Schema', compiled)(OfflinePrivateSearchDocumentV1Schema)
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const useSearchScheduler = (targetWindow = null) => {
  const originalWindow = globalThis.window
  const originalSetTimeout = targetWindow?.setTimeout
  const originalClearTimeout = targetWindow?.clearTimeout
  let nextId = 0
  const timers = new Map()
  const setTimeout = (callback, milliseconds = 0) => {
    const id = ++nextId
    timers.set(id, { callback, milliseconds })
    return id
  }
  const clearTimeout = id => timers.delete(id)
  if (targetWindow) {
    targetWindow.setTimeout = setTimeout
    targetWindow.clearTimeout = clearTimeout
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: targetWindow ?? { clearTimeout, setTimeout, fetch: () => Promise.reject(new Error('Unexpected fetch')) }
  })
  return {
    pending: () => timers.size,
    runNext: (milliseconds = null) => {
      const entry = [...timers.entries()].find(([, timer]) => milliseconds === null || timer.milliseconds === milliseconds)
      if (!entry) throw new Error('No scheduled search was available.')
      timers.delete(entry[0])
      entry[1].callback()
    },
    restore: () => {
      if (targetWindow) {
        targetWindow.setTimeout = originalSetTimeout
        targetWindow.clearTimeout = originalClearTimeout
      }
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  }
}

const createPrivateExpirySearch = (source, { deferFirstRanking = false, targetWindow = null } = {}) => {
  const origin = 'https://wiki.example.test'
  const siteId = 'private-search-site'
  const capturedAt = '2026-09-01T12:00:00.000Z'
  let now = Date.parse(capturedAt)
  const expiresAt = now + 1000
  const corpusRevision = 1
  const adapters = compileSnapshotAdapters(source)
  const pairs = [
    { pageId: 1, title: 'Quasar stellar transient', searchText: 'quasar stellar transient', expiresAt: new Date(expiresAt).toISOString() },
    { pageId: 2, title: 'Observatory notes', searchText: 'quasar stellar durable', expiresAt: null }
  ].map(({ pageId, title, searchText, expiresAt }) => {
    const record = OfflineSnapshotRecordSchema.parse({
      siteId,
      pageId,
      locale: 'en',
      byteSize: 128,
      lastOpenedAt: capturedAt,
      snapshot: {
        schemaVersion: 1,
        pageId,
        locale: 'en',
        path: `private/page-${pageId}`,
        canonicalPath: `/en/private/page-${pageId}`,
        title,
        description: '',
        sourceRevision: `revision-${pageId}`,
        capturedAt,
        expiresAt,
        content: { representation: OFFLINE_CONTENT_TYPE, sanitizerVersion: OFFLINE_HTML_SANITIZER_VERSION, html: `<p>${searchText}</p>` },
        searchText,
        contentType: OFFLINE_CONTENT_TYPE,
        integrity: `snapshot-${pageId}`
      }
    })
    return {
      snapshot: record.snapshot,
      searchDocument: OfflinePrivateSearchDocumentV1Schema.parse({
        ...adapters.toOfflineSearchDocument(record),
        sourceRevision: record.snapshot.sourceRevision
      }),
      record
    }
  })
  const policies = [
    OfflinePolicyStateSchema.parse({
      key: 'state',
      recordType: 'state',
      schemaVersion: 1,
      automaticSavingEnabled: true,
      automaticSavingDefaultApplied: true,
      selectedTags: [],
      policyRevision: 1,
      byteSize: 0,
      syncDiagnostics: {
        status: 'idle',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        pendingCount: 0,
        retainedCount: 0,
        removedCount: 0
      }
    }),
    ...pairs.map(({ snapshot }) =>
      OfflinePagePolicyRecordSchema.parse({
        key: `${siteId}\u0000${snapshot.pageId}\u0000${snapshot.locale}`,
        recordType: 'page',
        schemaVersion: 1,
        siteId,
        pageId: snapshot.pageId,
        locale: snapshot.locale,
        manual: true,
        automatic: false,
        tag: false,
        tagNames: [],
        visitCount: 0,
        lastVisitedAt: null,
        lastEditedAt: null,
        automaticSelectedAt: null,
        excluded: false,
        availability: 'available',
        byteSize: 0
      })
    )
  ]
  let readingHandle = {
    context: { canonicalOrigin: origin, siteId, accountId: 7, authVersion: 3, keyId: 'reading-key' },
    sessionGeneration: 1
  }
  let readingEpoch = 1
  let rankingCount = 0
  const rankingStarted = deferred()
  const releaseRanking = deferred()
  const replacementFinished = deferred()
  let onStorageClose = null
  const storage = {
    readSnapshotCorpus: async () => ({
      snapshots: targetWindow
        ? [
            {
              ...pairs[1].record,
              siteId: origin,
              pageId: 3,
              snapshot: {
                ...pairs[1].snapshot,
                pageId: 3,
                title: 'Quasar public reference',
                path: 'public/reference',
                canonicalPath: '/en/public/reference'
              }
            }
          ]
        : [],
      corpusRevision,
      sessionGeneration: 1
    }),
    currentCorpusRevision: async () => corpusRevision,
    currentSessionGeneration: async () => 1,
    close: () => {
      onStorageClose?.()
      onStorageClose = null
    }
  }
  const dependencies = {
    openOfflineStorage: async () => storage,
    emptySearchResponse: () => ({ results: [], suggestions: [], totalHits: 0 }),
    getErrorMessage: value => (value instanceof Error ? value.message : String(value)),
    currentOfflineReadingHandle: () => readingHandle,
    currentOfflineReadingEpoch: () => readingEpoch,
    // This boundary returns the already-admitted decrypted body/search pairs, not ranked results.
    readPrivateCorpus: async () => {
      const activePairs = pairs.filter(({ snapshot }) => snapshot.expiresAt === null || Date.parse(snapshot.expiresAt) > now)
      return {
        snapshots: activePairs.map(pair => pair.snapshot),
        searchDocuments: activePairs.map(pair => pair.searchDocument),
        policies,
        corpusRevision,
        nextExpiresAt: activePairs.reduce((soonest, { snapshot }) => {
          if (snapshot.expiresAt === null) return soonest
          const expiry = Date.parse(snapshot.expiresAt)
          return soonest === null || expiry < soonest ? expiry : soonest
        }, null)
      }
    },
    ...adapters,
    prepareOfflineSearchCorpus,
    searchPreparedOfflineDocumentsAsync: async (...args) => {
      const ranked = await searchPreparedOfflineDocumentsAsync(...args)
      rankingCount += 1
      if (deferFirstRanking && rankingCount === 1) {
        rankingStarted.resolve(ranked)
        await releaseRanking.promise
      }
      return ranked
    },
    OFFLINE_SEARCH_RESULT_LIMIT: 50
  }
  const methods = compileSearchMethods(source, ['queueSearch', 'runSearch', 'runOfflineSearch', 'handleOfflineReadingStateChange'], dependencies)
  const state = {
    search: '',
    searchMode: 'search',
    searchContextLabel: 'Saved pages',
    offlineSearchActive: true,
    offlineSearchCorpus: null,
    offlineSearchCorpusRevision: null,
    offlineSearchCorpusSessionGeneration: null,
    offlineSearchCorpusExpiresAt: null,
    offlinePrivateSearchCorpus: null,
    offlinePrivateSearchCorpusRevision: null,
    offlinePrivateSearchCorpusSessionGeneration: null,
    offlinePrivateSearchCorpusExpiresAt: null,
    offlinePrivateSearchEnabled: false,
    offlineCorpusCount: null,
    offlineResultsTruncated: false,
    response: { results: [], suggestions: [], totalHits: 0 },
    responseKey: '',
    searchRequestId: 0,
    searchRetryId: 0,
    searchRequestKey: '',
    searchAbortController: null,
    moreAbortController: null,
    searchTimer: null,
    searchIsLoading: false,
    searchError: '',
    moreError: '',
    loadingMore: false,
    cursor: -1,
    queueSearch(query) {
      return methods.queueSearch.call(this, query)
    },
    async runSearch(...args) {
      await methods.runSearch.apply(this, args)
      replacementFinished.resolve()
    },
    runOfflineSearch(...args) {
      return methods.runOfflineSearch.apply(this, args)
    }
  }
  const scheduler = useSearchScheduler(targetWindow)
  if (targetWindow) setLocation(origin)
  else window.location = { origin }
  const originalNow = Date.now
  Date.now = () => now
  return {
    state,
    methods,
    dependencies,
    nextSearchFinished: () =>
      new Promise(resolve => {
        onStorageClose = resolve
      }),
    scheduler,
    expiresAt,
    rankingStarted,
    releaseRanking,
    replacementFinished,
    advanceToDeadline: () => {
      now = expiresAt
    },
    lock: () => {
      readingHandle = null
      readingEpoch += 1
    },
    runQuery(query) {
      state.search = query
      state.searchRequestKey = `private:${query}`
      state.searchRequestId += 1
      state.searchIsLoading = true
      return state.runOfflineSearch(query, state.searchRequestKey, state.searchRequestId)
    },
    restore() {
      Date.now = originalNow
      scheduler.restore()
    }
  }
}

const Vue = await import('vue')
const mountPrivateExpirySearch = async (source, options = {}) => {
  const previousLocation = window.location.href
  const harness = createPrivateExpirySearch(source, { ...options, targetWindow: browserWindow })
  const store = Vue.reactive({
    user: { id: 7, authenticated: true, permissions: [] },
    authRefreshPending: false,
    authRefreshSettled: true,
    authRefreshOutcome: 'authenticated',
    offlineIdentityReady: true,
    page: { id: 0, locale: 'en', path: '', updatedAt: '', title: '' },
    site: {
      search: 'quasar',
      searchMode: 'search',
      searchIsFocused: true,
      searchIsLoading: false,
      searchRestrictLocale: false,
      searchRestrictPath: false
    }
  })
  if (options.online) {
    store.site.search = ''
    store.user.permissions = ['use:agents']
    store.user.authVersion = 3
  }
  const connection = Vue.reactive(
    options.online
      ? { connectionState: 'online', serverReachable: true, serverHealthy: true }
      : { connectionState: 'offline', serverReachable: false, serverHealthy: false }
  )
  const passthrough = (tag = 'div') =>
    Vue.defineComponent({
      setup(_props, { attrs, slots }) {
        return () => Vue.h(tag, attrs, [slots.prepend?.(), slots.default?.(), slots.append?.()])
      }
    })
  const dependencies = {
    // Inject imported boundaries only; the complete script declares its own adapters.
    openOfflineStorage: harness.dependencies.openOfflineStorage,
    getErrorMessage: harness.dependencies.getErrorMessage,
    currentOfflineReadingHandle: harness.dependencies.currentOfflineReadingHandle,
    currentOfflineReadingEpoch: harness.dependencies.currentOfflineReadingEpoch,
    readPrivateCorpus: harness.dependencies.readPrivateCorpus,
    prepareOfflineSearchCorpus: harness.dependencies.prepareOfflineSearchCorpus,
    searchPreparedOfflineDocumentsAsync: harness.dependencies.searchPreparedOfflineDocumentsAsync,
    OFFLINE_SEARCH_RESULT_LIMIT: harness.dependencies.OFFLINE_SEARCH_RESULT_LIMIT,
    defineComponent: Vue.defineComponent,
    AsyncState: Vue.defineComponent({
      props: ['state', 'title', 'message'],
      setup: props => () => Vue.h('div', { role: props.state === 'error' ? 'alert' : 'status' }, [props.title, props.message])
    }),
    CitedCopyAction: Vue.defineComponent({
      props: ['disabled', 'source'],
      setup: props => () => Vue.h('button', { class: 'fixture-cited-copy', disabled: props.disabled }, 'Copy')
    }),
    createAsyncComponent: () => Vue.defineComponent({ render: () => null }),
    wikiStore: store,
    siteConfig: { agentsEnabled: options.online === true },
    pwaState: connection,
    useAgentsStore: () => ({ setCurrentPage() {}, closeWorkspace() {} }),
    onSearchEnter() {},
    onSearchExit() {},
    onSearchMove() {},
    offSearchEnter() {},
    offSearchExit() {},
    offSearchMove() {},
    emitSearchFocus() {},
    subscribeOfflineStorageChanges: () => () => {},
    OFFLINE_READING_STATE_EVENT,
    OfflinePrivateSearchDocumentV1Schema,
    mergeOfflineSearchCorpora,
    createSearchHighlighter,
    createModalFocusScope,
    activeOwnedOverlayRoots,
    offlinePageHref,
    requestOfflineSavedPageOpen,
    ...workingSet,
    ...searchNavigation,
    ...readerActions,
    navigateToWikiPage:
      options.navigate ??
      (() => {
        throw new Error('Unexpected page navigation')
      }),
    isWikiNavigationClick: event => event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
  }
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
  const parsed = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const executable = ts.transpileModule(
    parsed.statements
      .filter(statement => !ts.isImportDeclaration(statement))
      .map(statement => statement.getText(parsed))
      .join('\n')
      .replace('export default', 'return'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  const component = new Function(...Object.keys(dependencies), executable)(...Object.values(dependencies))
  const { descriptor, errors } = parse(source, { filename: 'search-results.vue' })
  if (errors.length) throw errors[0]
  if (!descriptor.template) throw new Error('Search component template was not found.')
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: 'search-results.vue',
    id: 'private-search-expiry-consumer',
    preprocessLang: descriptor.template.lang,
    preprocessOptions: { doctype: 'html' },
    compilerOptions: { mode: 'function' }
  })
  if (template.errors.length) throw template.errors[0]
  const container = document.createElement('div')
  container.innerHTML =
    '<header class="nav-header"><label class="nav-header-search-control"><input aria-label="Search"></label></header><div class="fixture-search-host"></div>'
  document.body.append(container)
  const input = container.querySelector('input')
  // JSDOM has no layout; native traversal/geometry remains in the browser lane.
  const rects = Object.getOwnPropertyDescriptor(browserWindow.HTMLElement.prototype, 'getClientRects')
  Object.defineProperty(browserWindow.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 100, height: 44 }]
  })
  input.value = store.site.search
  input.addEventListener('focus', () => {
    store.site.searchIsFocused = true
  })
  input.addEventListener('input', () => {
    store.site.search = input.value
  })
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      searchNavigation.emitSearchMove(event.key === 'ArrowDown' ? 'down' : 'up')
    } else if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault()
      searchNavigation.emitSearchEnter()
    }
  })
  const app = Vue.createApp({ ...component, render: new Function('Vue', template.code)(Vue) })
  for (const name of ['v-list', 'v-list-item', 'v-list-item-title', 'v-list-item-subtitle', 'v-chip', 'v-icon', 'v-divider', 'v-tooltip']) {
    app.component(name, passthrough())
  }
  app.component('v-btn', passthrough('button'))
  app.config.globalProperties.$t = translateEnglish
  app.config.globalProperties.$vuetify = { display: { smAndDown: false } }
  const instance = app.mount(container.querySelector('.fixture-search-host'))
  await Vue.nextTick()
  return {
    ...harness,
    container,
    instance,
    store,
    connection,
    input,
    async completeSearch() {
      const finished = harness.nextSearchFinished()
      harness.scheduler.runNext(300)
      await finished
      await Vue.nextTick()
    },
    async reopen() {
      input.focus()
      await Vue.nextTick()
    },
    async close() {
      container.querySelector('.search-results-close').click()
      await Vue.nextTick()
    },
    restore() {
      app.unmount()
      container.remove()
      if (rects) Object.defineProperty(browserWindow.HTMLElement.prototype, 'getClientRects', rects)
      else delete browserWindow.HTMLElement.prototype.getClientRects
      harness.restore()
      setLocation(previousLocation)
    }
  }
}

const workingIdentity = { origin: 'https://wiki.example.test', installation: 'search-consumer', accountId: 7, authVersion: 3 }
const workingPage = id => ({
  id,
  locale: 'en',
  path: `guides/page-${id}`,
  title: `Reader page ${id}`,
  visibility: id === 12 ? 'private' : 'public',
  ownerId: id === 12 ? 7 : null,
  hash: `hash-${id}`,
  description: '',
  content: 'Authorized body',
  contentType: 'markdown',
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  sourceRevision: '1',
  capabilities: { viewStewardContacts: false },
  accuracy: {
    sourceRevision: '1',
    updatedAt: '2026-10-22T00:00:00.000Z',
    author: null,
    latestAttestation: null,
    canVerify: false,
    asOf: '2026-10-22T00:00:00.000Z',
    status: 'needs-verification'
  },
  changeReason: null
})

const mountWorkingSearch = async (source, options = {}) => {
  const previousFetch = browserWindow.fetch
  const previousLocation = browserWindow.location.href
  setLocation(workingIdentity.origin)
  workingSet.invalidatePageWorkingSet()
  workingSet.establishPageWorkingSet(workingIdentity)
  const scope = workingSet.capturePageWorkingSetScope()
  workingSet.recordPageVisit(11, scope)
  workingSet.pinPage(11, scope)
  workingSet.pinPage(12, scope)
  browserWindow.fetch = async url => {
    const id = Number(String(url).split('/').at(-1))
    return new Response(JSON.stringify((options.pageForId ?? workingPage)(id)), { headers: { 'Content-Type': 'application/json' } })
  }
  const harness = await mountPrivateExpirySearch(source, { ...options, online: true })
  await harness.instance.refreshWorkingSet()
  await Vue.nextTick()
  return {
    ...harness,
    restore() {
      harness.restore()
      workingSet.invalidatePageWorkingSet()
      browserWindow.fetch = previousFetch
      setLocation(previousLocation)
    }
  }
}

describe('zero-query Search consumer', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')

  test('connects the header combobox to deduplicated working rows and quick actions, then enters the selected private page', async () => {
    const destinations = []
    const harness = await mountWorkingSearch(source, { navigate: href => destinations.push(href) })
    const { input, container } = harness
    const key = async value => {
      input.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
      await Vue.nextTick()
    }
    try {
      input.focus()
      await Vue.nextTick()
      expect(input.getAttribute('role')).toBe('combobox')
      const grid = document.getElementById(input.getAttribute('aria-controls'))
      expect(grid?.getAttribute('role')).toBe('grid')
      expect([...grid.querySelectorAll('.search-results-working-row a')].map(link => link.getAttribute('href'))).toEqual([
        '/en/guides/page-11',
        '/_private/en/guides/page-12'
      ])
      expect(input.hasAttribute('aria-activedescendant')).toBe(false)
      const tab = (target, shiftKey = false) => {
        const event = new browserWindow.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
        target.dispatchEvent(event)
        return event
      }
      expect(tab(input).defaultPrevented).toBe(false)
      const controls = [...container.querySelectorAll('.search-results [tabindex="0"], .search-results button:not([disabled]), .search-results a[href]')]
      expect(controls).toContain(container.querySelector('.search-results-syntax > summary'))
      for (const control of controls.slice(0, -1)) {
        control.focus()
        expect(tab(control).defaultPrevented).toBe(false)
        expect(harness.store.site.searchIsFocused).toBe(true)
      }
      const lastControl = controls.at(-1)
      lastControl.focus()
      expect(tab(lastControl).defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(input)
      expect(tab(input, true).defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(lastControl)
      input.focus()
      await key('Enter')
      expect(destinations).toEqual([])
      await key('ArrowUp')
      let selected = document.getElementById(input.getAttribute('aria-activedescendant'))
      expect(selected.getAttribute('aria-selected')).toBe('true')
      expect(selected.querySelector('a').getAttribute('href')).toBe('/t')
      harness.instance.cursor = -1
      await key('ArrowDown')
      selected = document.getElementById(input.getAttribute('aria-activedescendant'))
      expect(selected.querySelector('a').getAttribute('href')).toBe('/en/guides/page-11')
      await key('ArrowDown')
      expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(1)
      await key('Enter')
      expect(destinations).toEqual(['/_private/en/guides/page-12'])
      expect(harness.store.site.searchIsFocused).toBe(false)
    } finally {
      harness.restore()
    }
  })

  test.each([11, 12])('preserves encoded working-page identity for normal and native modified navigation: %s', async id => {
    const destinations = []
    const pageForId = pageId => ({
      ...workingPage(pageId),
      locale: 'fr',
      path: 'guides/日本語#question?100%/café'
    })
    const expectedPath = `${id === 12 ? '/_private' : ''}/fr/guides/%E6%97%A5%E6%9C%AC%E8%AA%9E%23question%3F100%25/caf%C3%A9`
    const harness = await mountWorkingSearch(source, { pageForId, navigate: href => destinations.push(new URL(href, workingIdentity.origin)) })
    try {
      const link = [...harness.container.querySelectorAll('.search-results-working-link')].find(candidate =>
        candidate.textContent.includes(`Reader page ${id}`)
      )
      expect(link).toBeDefined()
      const assertIdentity = destination => {
        expect(destination.origin).toBe(workingIdentity.origin)
        expect(destination.pathname).toBe(expectedPath)
        expect(destination.search).toBe('')
        expect(destination.hash).toBe('')
        expect(destination.pathname.split('/').map(decodeURIComponent).join('/')).toBe(`${id === 12 ? '/_private' : ''}/fr/${pageForId(id).path}`)
      }
      assertIdentity(new URL(link.getAttribute('href'), workingIdentity.origin))
      for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        const event = new browserWindow.MouseEvent(options.button === 1 ? 'auxclick' : 'click', { bubbles: true, cancelable: true, ...options })
        link.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
        expect(destinations).toEqual([])
        expect(harness.store.site.searchIsFocused).toBe(true)
        assertIdentity(new URL(link.getAttribute('href'), workingIdentity.origin))
      }
      const click = new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
      expect(destinations).toHaveLength(1)
      assertIdentity(destinations[0])
      expect(harness.store.site.searchIsFocused).toBe(false)
    } finally {
      harness.restore()
    }
  })

  test('real pin rehydration restores the remounted toggle, and disappearing unpinned rows return focus to Search', async () => {
    const harness = await mountWorkingSearch(source)
    try {
      const pin = harness.container.querySelector('[data-working-pin="11"]')
      pin.focus()
      pin.click()
      await Vue.nextTick()
      await harness.instance.refreshWorkingSet()
      await Vue.nextTick()
      const replacement = harness.container.querySelector('[data-working-pin="11"]')
      expect(replacement).not.toBe(pin)
      expect(replacement.getAttribute('aria-pressed')).toBe('false')
      expect(document.activeElement).toBe(replacement)
      replacement.click()
      await Vue.nextTick()
      await harness.instance.refreshWorkingSet()
      await Vue.nextTick()
      expect(harness.container.querySelector('[data-working-pin="11"]').getAttribute('aria-pressed')).toBe('true')
      const pinnedOnly = harness.container.querySelector('[data-working-pin="12"]')
      pinnedOnly.focus()
      pinnedOnly.click()
      await Vue.nextTick()
      await harness.instance.refreshWorkingSet()
      await Vue.nextTick()
      expect(harness.container.querySelector('[data-working-pin="12"]')).toBeNull()
      expect(document.activeElement).toBe(harness.input)
      expect(harness.input.hasAttribute('aria-activedescendant')).toBe(false)
    } finally {
      harness.restore()
    }
  })

  test('retires prior-account rows during verification and distinguishes server loss from a failed online refresh', async () => {
    const destinations = []
    const harness = await mountWorkingSearch(source, { navigate: href => destinations.push(href) })
    try {
      const staleLink = harness.container.querySelector('.search-results-working-row a')
      const onlineMessage = harness.container.querySelector('#wiki-search-working-status').textContent
      harness.store.authRefreshPending = true
      await Vue.nextTick()
      expect(harness.container.querySelector('.search-results-working-row')).toBeNull()
      const verificationMessage = harness.container.querySelector('#wiki-search-working-status').textContent
      expect(verificationMessage).not.toBe(onlineMessage)
      const staleClick = new browserWindow.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
      staleLink.dispatchEvent(staleClick)
      expect(staleClick.defaultPrevented).toBe(true)
      expect(destinations).toEqual([])
      workingSet.establishPageWorkingSet({ ...workingIdentity, accountId: 8 })
      harness.store.user.id = 8
      harness.store.authRefreshPending = false
      await Vue.nextTick()
      await harness.instance.refreshWorkingSet()
      await Vue.nextTick()
      expect(harness.container.textContent).not.toContain('Reader page 11')
      harness.connection.serverHealthy = false
      await Vue.nextTick()
      expect(harness.container.querySelector('.search-results-capability-note button')).not.toBeNull()
      const offlineMessage = harness.container.querySelector('#wiki-search-working-status').textContent
      expect(offlineMessage).not.toBe(verificationMessage)
      const tags = harness.container.querySelector('.search-results-working-action a')
      expect(tags.getAttribute('aria-disabled')).toBe('true')
      tags.click()
      expect(destinations).toEqual([])
      harness.connection.serverHealthy = true
      browserWindow.fetch = async () => new Response('Unavailable', { status: 503 })
      workingSet.recordPageVisit(13, workingSet.capturePageWorkingSetScope())
      await Vue.nextTick()
      await harness.instance.refreshWorkingSet()
      await Vue.nextTick()
      expect(harness.container.querySelector('.search-results-capability-note')).toBeNull()
      expect(harness.container.querySelector('#wiki-search-working-status').textContent).not.toBe(offlineMessage)
      expect(harness.container.querySelector('.search-results-working button')).not.toBeNull()
      expect(harness.container.querySelector('.search-results-working-row')).toBeNull()
    } finally {
      harness.restore()
    }
  })

  test('uses the registered guarded Create bridge, and never infers a current reader from retained page metadata', async () => {
    const harness = await mountWorkingSearch(source)
    let allowed = true
    let opens = 0
    const unregister = searchNavigation.registerSearchQuickCreate({
      canCreate: () => allowed,
      open: () => {
        opens++
        return true
      }
    })
    try {
      Object.assign(harness.store.page, workingPage(11), { mode: 'view' })
      await Vue.nextTick()
      const actions = harness.container.querySelectorAll('.search-results-working-action')
      expect(actions[0].querySelector('button').getAttribute('aria-disabled')).toBe('true')
      actions[0].querySelector('button').click()
      expect(harness.store.site.searchMode).toBe('search')
      actions[1].querySelector('button').click()
      expect(opens).toBe(1)
      expect(harness.store.site.searchIsFocused).toBe(true)
      allowed = false
      actions[1].querySelector('button').click()
      expect(opens).toBe(1)
      expect(harness.store.site.searchMode).toBe('search')
    } finally {
      unregister()
      harness.restore()
    }
  })

  test.each(['current reader', 'reader changed', 'reader revision changed', 'non-reader view', 'reader unmounted', 'account changed'])(
    'Quick Ask prepares only a current-reader draft: %s',
    async transition => {
      const harness = await mountWorkingSearch(source)
      const { store, instance } = harness
      const prepared = []
      const sent = []
      Object.assign(store.page, workingPage(11), { mode: 'view' })
      const reader = request =>
        request.reply({
          page: { pageId: 11, locale: 'en', path: 'guides/page-11', visibility: 'public', sourceRevision: '1' },
          ready: true,
          actions: {}
        })
      readerActions.onReaderPageActionsRequest(reader)
      readerActions.emitReaderPageActionsChanged()
      try {
        await Vue.nextTick()
        const ask = harness.container.querySelector('.search-results-working-action button')
        expect(ask.hasAttribute('aria-disabled')).toBe(false)
        const pending = instance.askCurrentPage()
        await Vue.nextTick()
        expect(prepared).toEqual([])
        if (transition === 'reader changed') store.page.path = 'different-page'
        if (transition === 'reader revision changed') store.page.sourceRevision = '2'
        if (transition === 'non-reader view') store.page.mode = 'edit'
        if (transition === 'reader unmounted') {
          readerActions.offReaderPageActionsRequest(reader)
          readerActions.emitReaderPageActionsChanged()
        }
        if (transition === 'account changed') store.user.authVersion++
        await Vue.nextTick()
        instance.setInlineAgent({
          preparePrompt: async (...args) => {
            prepared.push(args)
          },
          sendPrompt: async (...args) => {
            sent.push(args)
            return true
          },
          focusComposer: async () => {},
          focusConversation: async () => {}
        })
        await pending
        expect(sent).toEqual([])
        if (transition === 'current reader') {
          expect(prepared).toHaveLength(1)
          expect(prepared[0][0]).toContain('Reader page 11')
          expect(prepared[0].slice(1)).toEqual([undefined, { kind: 'all' }])
          expect(instance.agentPageId).toBe(11)
        } else expect(prepared).toEqual([])
      } finally {
        readerActions.offReaderPageActionsRequest(reader)
        harness.restore()
      }
    }
  )
})

describe('inline Ask mode contract', () => {
  const searchPath = path.join(process.cwd(), 'client/components/common/search-results.vue')
  const search = fs.readFileSync(searchPath, 'utf8')

  test('retains results without loading during replacement debounce, blocks stale navigation, and rejects the stale response', async () => {
    const scheduler = useSearchScheduler()
    try {
      const pendingByQuery = new Map()
      const methods = compileSearchMethods(
        search,
        ['queueSearch', 'runSearch', 'handleResultClick', 'navigateToPage', 'handleSearchEnter', 'handleSearchMove'],
        {
          searchPages: (_fetcher, query) => {
            const request = deferred()
            pendingByQuery.set(query, request)
            return request.promise
          },
          getErrorMessage: value => (value instanceof Error ? value.message : String(value)),
          wikiStore: { page: { locale: 'en', path: 'guide' } }
        }
      )
      const freshness = compileSearchMethods(search, ['hasFreshResponse'], {}, 'computed')
      const retainedResponse = {
        results: [{ id: 1, title: 'Retained result' }],
        suggestions: [],
        totalHits: 1
      }
      const state = {
        cursor: 0,
        normalizedSearch: 'replacement',
        pagination: 1,
        response: retainedResponse,
        responseKey: 'retained-key',
        searchAbortController: null,
        searchError: '',
        searchIsLoading: false,
        get hasFreshResponse() {
          return freshness.hasFreshResponse.call(this)
        },
        searchScope: 'wiki',
        searchMode: 'search',
        searchRequestId: 0,
        searchRequestKey: 'replacement-key',
        searchRestrictLocale: false,
        searchRestrictPath: false,
        serverCapabilitiesAvailable: true,
        searchTimer: null,
        canAsk: false,
        get results() {
          return this.response.results
        },
        get suggestions() {
          return this.response.suggestions
        },
        closeSearch() {
          throw new Error('A stale result must not close search.')
        },
        requestOfflineSavedResultOpen() {
          throw new Error('A stale result must not open a private saved page.')
        },
        runSearch(query, requestKey, requestId) {
          return methods.runSearch.call(this, query, requestKey, requestId)
        }
      }

      methods.queueSearch.call(state, 'replacement')
      expect(state.response).toBe(retainedResponse)
      expect(state.searchIsLoading).toBe(false)
      expect(scheduler.pending()).toBe(1)
      for (const item of [
        retainedResponse.results[0],
        { id: 2, title: 'Saved result', offline: true, visibility: 'public' },
        { id: 3, title: 'Private saved result', offline: true, visibility: 'private' }
      ]) {
        let prevented = false
        methods.handleResultClick.call(
          state,
          {
            preventDefault: () => {
              prevented = true
            }
          },
          item
        )
        expect(prevented).toBe(true)
        methods.navigateToPage.call(state, item)
      }
      const cursorBefore = state.cursor
      methods.handleSearchMove.call(state, 'down')
      await methods.handleSearchEnter.call(state)
      expect(state.cursor).toBe(cursorBefore)
      expect(state.response).toBe(retainedResponse)

      scheduler.runNext()
      expect(state.searchIsLoading).toBe(true)
      const replacementController = state.searchAbortController

      state.normalizedSearch = 'new replacement'
      state.searchRequestKey = 'new-replacement-key'
      methods.queueSearch.call(state, 'new replacement')

      expect(replacementController.signal.aborted).toBe(true)
      expect(state.response).toBe(retainedResponse)
      expect(state.searchIsLoading).toBe(false)
      expect(scheduler.pending()).toBe(1)

      pendingByQuery.get('replacement').resolve({
        results: [{ id: 2, title: 'Stale result' }],
        suggestions: [],
        totalHits: 1
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(state.response).toBe(retainedResponse)
      expect(state.searchIsLoading).toBe(false)

      scheduler.runNext()
      expect(state.searchIsLoading).toBe(true)
      const freshResponse = {
        results: [{ id: 3, title: 'Fresh result' }],
        suggestions: [],
        totalHits: 1
      }
      pendingByQuery.get('new replacement').resolve(freshResponse)
      await Promise.resolve()
      await Promise.resolve()

      expect(state.response).toBe(freshResponse)
      expect(state.responseKey).toBe('new-replacement-key')
      expect(state.searchIsLoading).toBe(false)
    } finally {
      scheduler.restore()
    }
  })

  test.each(['resolve', 'reject'])('cancels continuation and ignores a late %s without finalizing a newer continuation', async outcome => {
    const scheduler = useSearchScheduler()
    try {
      const requests = []
      const methods = compileSearchMethods(search, ['queueSearch', 'loadMoreResults'], {
        searchPages: (_fetcher, query, options) => {
          const request = deferred()
          requests.push({ ...request, query, options })
          return request.promise
        },
        getErrorMessage: value => value.message,
        wikiStore: { page: { locale: 'en', path: 'recipes' } }
      })
      const state = {
        normalizedSearch: 'pizza',
        searchRequestKey: 'pizza-key',
        responseKey: 'pizza-key',
        response: { results: [{ id: 1 }], suggestions: [], totalHits: 3, nextCursor: 'old-cursor' },
        cursor: 0,
        searchMode: 'search',
        searchRequestId: 1,
        searchTimer: null,
        searchAbortController: null,
        moreAbortController: null,
        loadingMore: false,
        searchIsLoading: false,
        searchError: '',
        moreError: '',
        searchRestrictLocale: false,
        searchRestrictPath: false,
        offlineSearchActive: false,
        serverCapabilitiesAvailable: true,
        get hasFreshResponse() {
          return this.responseKey === this.searchRequestKey
        },
        resultKey: item => String(item.id),
        runSearch() {
          this.response = { results: [{ id: 10 }], suggestions: [], totalHits: 4, nextCursor: 'new-cursor' }
          this.responseKey = this.searchRequestKey
          this.searchIsLoading = false
        }
      }
      const oldMore = methods.loadMoreResults.call(state)
      const oldController = state.moreAbortController
      expect(state.loadingMore).toBe(true)
      state.normalizedSearch = 'pasta'
      state.searchRequestKey = 'pasta-key'
      methods.queueSearch.call(state, 'pasta')
      expect(oldController.signal.aborted).toBe(true)
      expect(state.loadingMore).toBe(false)
      scheduler.runNext()
      const currentMore = methods.loadMoreResults.call(state)
      const currentController = state.moreAbortController
      if (outcome === 'resolve') requests[0].resolve({ results: [{ id: 999 }], suggestions: [], totalHits: 3 })
      else requests[0].reject(new Error('Old continuation failed'))
      await oldMore
      expect(state.response.results.map(item => item.id)).toEqual([10])
      expect(state.responseKey).toBe('pasta-key')
      expect(state.moreError).toBe('')
      expect(state.loadingMore).toBe(true)
      expect(state.moreAbortController).toBe(currentController)
      requests[1].resolve({ results: [{ id: 10 }, { id: 11 }, { id: 11 }, { id: 12 }], suggestions: [], totalHits: 4, nextCursor: 'next' })
      await currentMore
      expect(state.response.results.map(item => item.id)).toEqual([10, 11, 12])
      expect(state.response.nextCursor).toBe('next')
      expect(state.loadingMore).toBe(false)
      expect(state.moreAbortController).toBeNull()
    } finally {
      scheduler.restore()
    }
  })

  test('retains readable rows on a failed refresh and retries without clearing them', async () => {
    const scheduler = useSearchScheduler()
    try {
      const request = deferred()
      const methods = compileSearchMethods(search, ['runSearch', 'retrySearch'], {
        searchPages: () => request.promise,
        getErrorMessage: value => value.message,
        wikiStore: { page: { locale: 'en', path: 'recipes' } }
      })
      const response = { results: [{ id: 1 }], suggestions: [], totalHits: 1 }
      let retryCalls = 0
      const state = {
        normalizedSearch: 'pasta',
        searchRequestKey: 'pasta-key',
        responseKey: 'pizza-key',
        response,
        cursor: 0,
        searchMode: 'search',
        searchRequestId: 1,
        searchRetryId: 0,
        searchTimer: null,
        searchAbortController: null,
        moreAbortController: null,
        searchRestrictLocale: false,
        searchRestrictPath: false,
        offlineSearchActive: false,
        serverCapabilitiesAvailable: true,
        serverUnavailable: false,
        searchIsLoading: true,
        searchError: '',
        runSearch() {
          retryCalls += 1
        }
      }
      const refresh = methods.runSearch.call(state, 'pasta', 'pasta-key', 1)
      request.reject(new Error('Search unavailable'))
      await refresh
      expect(state.response).toBe(response)
      expect(state.responseKey).toBe('')
      expect(state.searchError).toBe('Search unavailable')
      expect(state.searchIsLoading).toBe(false)
      await methods.retrySearch.call(state)
      expect(state.response).toBe(response)
      expect(state.cursor).toBe(0)
      expect(state.searchError).toBe('')
      expect(state.searchIsLoading).toBe(true)
      expect(retryCalls).toBe(1)
    } finally {
      scheduler.restore()
    }
  })

  test('retains an authorized active Agent offline without admitting new work, and tears down on an owner change', () => {
    const dependencies = {
      wikiStore: { user: { permissions: ['use:agents'] } },
      siteConfig: { agentsEnabled: true }
    }
    const computed = compileSearchMethods(search, null, dependencies, 'computed')
    const watch = compileSearchMethods(search, ['offlineSearchActive', 'agentOwnerId'], dependencies, 'watch')
    const methods = compileSearchMethods(search, ['selectSearchScope'], dependencies)
    const state = {
      authAuthorityReady: true,
      serverCapabilitiesAvailable: true,
      searchMode: 'ask',
      searchScope: 'wiki',
      searchIsFocused: true,
      searchRestrictLocale: false,
      searchRestrictPath: false,
      agentResumeSessionId: 'owned-conversation',
      previewSelector: { kind: 'page', id: 128 }
    }
    for (const [name, getter] of Object.entries(computed)) {
      if (!(name in state)) Object.defineProperty(state, name, { get: () => getter.call(state) })
    }
    expect(state.isAgentOpen).toBe(true)
    expect(state.canAsk).toBe(true)

    state.serverCapabilitiesAvailable = false
    watch.offlineSearchActive.call(state, true)
    expect(state.canAsk).toBe(false)
    expect(state.isAgentOpen).toBe(true)
    expect(state.searchMode).toBe('ask')
    expect(state.previewSelector).toBeNull()

    state.serverCapabilitiesAvailable = true
    expect(state.isAgentOpen).toBe(true)
    expect(state.canAsk).toBe(true)
    state.authAuthorityReady = false
    expect(state.isAgentOpen).toBe(false)
    watch.agentOwnerId.call(state, 42, 41)
    expect(state.agentResumeSessionId).toBeNull()
    expect(state.searchMode).toBe('search')
    expect(state.searchIsFocused).toBe(false)
    state.authAuthorityReady = true
    expect(state.isAgentOpen).toBe(false)

    state.searchMode = 'ask'
    methods.selectSearchScope.call(state, 'downloaded')
    expect(state.searchMode).toBe('search')
    expect(state.isAgentOpen).toBe(false)
    dependencies.wikiStore.user.permissions = []
    state.searchMode = 'ask'
    expect(state.isAgentOpen).toBe(false)
    expect(state.canAsk).toBe(false)
  })

  for (const unavailable of ['feature-disabled', 'permission-denied', 'unverified-session', 'server-unavailable']) {
    test(`does not create or submit an Ask draft when ${unavailable}`, async () => {
      const dependencies = {
        wikiStore: { user: { permissions: unavailable === 'permission-denied' ? [] : ['use:agents'] } },
        siteConfig: { agentsEnabled: unavailable !== 'feature-disabled' }
      }
      const computed = compileSearchMethods(search, ['agentAuthorityReady', 'canAsk'], dependencies, 'computed')
      const methods = compileSearchMethods(search, ['openAsk', 'askCurrentQuery', 'askSource', 'submitAskPrompt'], dependencies)
      const preparations = []
      const submissions = []
      const response = { results: [{ id: 9, title: 'Keep the reader result' }], suggestions: ['another phrase'] }
      const state = {
        search: 'keep my question',
        normalizedSearch: 'keep my question',
        searchMode: 'search',
        searchIsFocused: true,
        response,
        searchRestrictLocale: true,
        searchRestrictPath: true,
        directPromptHandoffId: 3,
        directPromptHandoffPending: false,
        authAuthorityReady: unavailable !== 'unverified-session',
        serverCapabilitiesAvailable: unavailable !== 'server-unavailable',
        waitForInlineAgent: async () => ({
          preparePrompt: (...args) => preparations.push(args),
          sendPrompt: (...args) => submissions.push(args)
        }),
        sendAskPrompt: (...args) => submissions.push(args)
      }
      for (const [name, getter] of Object.entries(computed)) Object.defineProperty(state, name, { get: () => getter.call(state) })
      expect(state.canAsk).toBe(false)
      methods.openAsk.call(state)
      await methods.askCurrentQuery.call(state)
      await methods.askSource.call(state, { title: 'Current result' })
      expect(state.searchMode).toBe('search')
      state.searchMode = 'ask'
      await methods.submitAskPrompt.call(state)
      expect(preparations).toEqual([])
      expect(submissions).toEqual([])
      expect(state.directPromptHandoffId).toBe(3)
      expect(state.search).toBe('keep my question')
      expect(state.response).toBe(response)
      expect(state.searchRestrictLocale).toBe(true)
      expect(state.searchRestrictPath).toBe(true)
    })
  }

  test('Ask waits through loading refs and their transient removal before preparing the clicked scope', async () => {
    const prepared = []
    const methods = compileSearchMethods(
      search,
      ['askCurrentQuery', 'agentSearchScope', 'waitForInlineAgent', 'setInlineAgent', 'resolveInlineAgentWaiters'],
      {}
    )
    const state = {
      ...methods,
      canAsk: true,
      normalizedSearch: 'pizza',
      directPromptHandoffId: 0,
      directPromptHandoffPending: false,
      inlineAgent: null,
      inlineAgentWaiters: [],
      currentPageLocale: 'en',
      currentPagePath: 'recipes',
      searchRestrictLocale: true,
      searchRestrictPath: true,
      searchMode: 'search',
      get isAgentOpen() {
        return this.searchMode === 'ask'
      },
      latchAgentOpeningPage() {},
      activeModalOpener: () => null,
      focusInlineAgent: async () => {},
      $nextTick: () => Promise.resolve()
    }
    const handoff = state.askCurrentQuery()
    await Promise.resolve()
    await Promise.resolve()
    expect(state.searchMode).toBe('ask')
    expect(prepared).toEqual([])
    state.setInlineAgent({ $el: {} })
    state.setInlineAgent(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(state.inlineAgent).toBe(null)
    expect(state.inlineAgentWaiters).toHaveLength(1)
    expect(prepared).toEqual([])
    state.currentPagePath = 'another-page'
    state.setInlineAgent({
      focusComposer: async () => {},
      focusConversation: async () => {},
      preparePrompt: async (...args) => prepared.push(args),
      sendPrompt: () => {
        throw new Error('A search handoff must not submit.')
      }
    })
    await handoff
    expect(state.normalizedSearch).toBe('pizza')
    expect(prepared).toEqual([['pizza', undefined, { kind: 'section', locale: 'en', path: 'recipes' }]])
    expect(state.inlineAgentWaiters).toEqual([])
  })

  test('closing a loading workspace cancels a source draft instead of replaying it on reopen', async () => {
    const prepared = []
    const methods = compileSearchMethods(search, ['askSource', 'agentSearchScope', 'waitForInlineAgent', 'setInlineAgent', 'resolveInlineAgentWaiters'], {})
    const state = {
      ...methods,
      canAsk: true,
      normalizedSearch: 'original query',
      directPromptHandoffId: 0,
      inlineAgent: null,
      inlineAgentWaiters: [],
      searchMode: 'search',
      get isAgentOpen() {
        return this.searchMode === 'ask'
      },
      captureAgentExcursion() {},
      latchAgentOpeningPage() {},
      focusInlineAgent: async () => {},
      $nextTick: () => Promise.resolve()
    }
    const abandoned = state.askSource({ title: 'Abandoned source' })
    await Promise.resolve()
    await Promise.resolve()
    state.searchMode = 'search'
    state.directPromptHandoffId += 1
    state.setInlineAgent(null)
    await abandoned
    expect(prepared).toEqual([])
    expect(state.inlineAgentWaiters).toEqual([])

    const source = { title: 'Reopened source' }
    state.normalizedSearch = 'new query'
    const reopened = state.askSource(source)
    await Promise.resolve()
    await Promise.resolve()
    state.setInlineAgent({
      focusComposer: async () => {},
      focusConversation: async () => {},
      sendPrompt: () => {
        throw new Error('A source handoff must not submit.')
      },
      preparePrompt: async (...args) => prepared.push(args)
    })
    await reopened
    expect(prepared).toEqual([['new query', source, { kind: 'all' }]])
  })

  test('direct send waits for the workspace, blocks duplicate Enter, and clears only a successfully handed-off query', async () => {
    const sent = []
    let focused = 0
    const methods = compileSearchMethods(search, ['sendAskPrompt', 'waitForInlineAgent', 'setInlineAgent', 'resolveInlineAgentWaiters'], {})
    const state = {
      ...methods,
      search: 'send after load',
      get normalizedSearch() {
        return this.search
      },
      isAgentOpen: true,
      directPromptHandoffId: 0,
      directPromptHandoffPending: false,
      inlineAgent: null,
      inlineAgentWaiters: [],
      focusInlineAgent: async () => {},
      $nextTick: () => Promise.resolve()
    }
    const handoff = state.sendAskPrompt(state.search)
    await Promise.resolve()
    await Promise.resolve()
    await state.sendAskPrompt(state.search)
    expect(sent).toEqual([])
    expect(state.search).toBe('send after load')
    state.setInlineAgent({
      focusComposer: async () => {},
      preparePrompt: async () => {},
      sendPrompt: async prompt => {
        sent.push(prompt)
        return true
      },
      focusConversation: async () => {
        focused += 1
      }
    })
    await handoff
    expect(sent).toEqual(['send after load'])
    expect(state.search).toBe('')
    expect(focused).toBe(1)
    expect(state.directPromptHandoffPending).toBe(false)
  })

  test('a closed loading workspace does not send or clear the query when its code finishes loading', async () => {
    const methods = compileSearchMethods(search, ['sendAskPrompt', 'waitForInlineAgent', 'setInlineAgent', 'resolveInlineAgentWaiters'], {})
    const state = {
      ...methods,
      search: 'keep this query',
      get normalizedSearch() {
        return this.search
      },
      isAgentOpen: true,
      directPromptHandoffId: 0,
      directPromptHandoffPending: false,
      inlineAgent: null,
      inlineAgentWaiters: [],
      focusInlineAgent: async () => {},
      $nextTick: () => Promise.resolve()
    }
    const handoff = state.sendAskPrompt(state.search)
    await Promise.resolve()
    await Promise.resolve()
    state.isAgentOpen = false
    state.directPromptHandoffId += 1
    state.setInlineAgent(null)
    await handoff
    state.setInlineAgent({
      focusComposer: async () => {},
      focusConversation: async () => {},
      preparePrompt: async () => {},
      sendPrompt: () => {
        throw new Error('A dismissed handoff must not send.')
      }
    })
    expect(state.search).toBe('keep this query')
    expect(state.directPromptHandoffPending).toBe(false)
    expect(state.inlineAgentWaiters).toEqual([])
  })
  test('cancels a pending debounce before a retry starts its own query generation', async () => {
    const scheduler = useSearchScheduler()
    try {
      let searchCalls = 0
      const methods = compileSearchMethods(search, ['queueSearch', 'retrySearch'], {
        searchPages: () => Promise.reject(new Error('Search execution was not expected.')),
        getErrorMessage: value => String(value),
        wikiStore: { page: { locale: 'en', path: 'guide' } },
        emptySearchResponse: () => ({ results: [], suggestions: [], totalHits: 0 }),
        retryServerConnection: () => Promise.resolve()
      })
      const state = {
        cursor: -1,
        normalizedSearch: 'retry query',
        pagination: 1,
        response: { results: [], suggestions: [], totalHits: 0 },
        responseKey: 'old-key',
        searchAbortController: null,
        searchError: '',
        searchIsLoading: false,
        searchMode: 'search',
        searchRequestId: 0,
        searchRequestKey: 'retry-key',
        searchRetryId: 0,
        searchRestrictLocale: false,
        searchRestrictPath: false,
        searchTimer: null,
        serverCapabilitiesAvailable: true,
        serverRetryPending: false,
        serverUnavailable: false,
        runSearch() {
          searchCalls += 1
        }
      }

      methods.queueSearch.call(state, 'retry query')
      expect(scheduler.pending()).toBe(1)

      await methods.retrySearch.call(state)

      expect(scheduler.pending()).toBe(0)
      expect(searchCalls).toBe(1)
    } finally {
      scheduler.restore()
    }
  })

  test('restores retained-response keyboard navigation without treating raw Enter as selection', async () => {
    const scheduler = useSearchScheduler()
    try {
      const methods = compileSearchMethods(search, ['queueSearch', 'handleSearchMove', 'handleSearchEnter'], {
        searchPages: () => Promise.reject(new Error('Search execution was not expected.')),
        getErrorMessage: value => String(value),
        wikiStore: { page: { locale: 'en', path: 'guide' } }
      })
      const retainedResult = { id: 1, title: 'Retained result' }
      const navigated = []
      const state = {
        $el: { querySelector: () => null },
        $nextTick: callback => {
          callback?.()
          return Promise.resolve()
        },
        canAsk: false,
        cursor: 0,
        hasFreshResponse: false,
        normalizedSearch: 'replacement',
        pagination: 1,
        responseKey: 'retained-key',
        results: [retainedResult],
        searchAbortController: null,
        searchError: '',
        searchIsLoading: false,
        searchMode: 'search',
        searchRequestId: 0,
        searchRequestKey: 'replacement-key',
        searchTimer: null,
        suggestions: [],
        navigateToPage: result => navigated.push(result),
        runSearch: () => {
          throw new Error('Search execution was not expected.')
        }
      }

      methods.queueSearch.call(state, 'replacement')
      expect(state.cursor).toBe(-1)
      expect(scheduler.pending()).toBe(1)

      state.normalizedSearch = 'retained'
      state.searchRequestKey = 'retained-key'
      state.hasFreshResponse = true
      methods.queueSearch.call(state, 'retained')

      expect(state.cursor).toBe(-1)
      expect(scheduler.pending()).toBe(0)

      await methods.handleSearchEnter.call(state)
      expect(navigated).toEqual([])

      methods.handleSearchMove.call(state, 'down')
      expect(state.cursor).toBe(0)
      await methods.handleSearchEnter.call(state)
      expect(navigated).toEqual([retainedResult])
    } finally {
      scheduler.restore()
    }
  })

  test('selects the last result on initial ArrowUp while initial ArrowDown selects the first', () => {
    const methods = compileSearchMethods(search, ['handleSearchMove'], {
      searchPages: () => Promise.reject(new Error('Search execution was not expected.')),
      getErrorMessage: value => String(value),
      wikiStore: { page: { locale: 'en', path: 'guide' } }
    })
    const state = {
      $el: { querySelector: () => null },
      $nextTick: callback => {
        callback?.()
        return Promise.resolve()
      },
      cursor: -1,
      hasFreshResponse: true,
      normalizedSearch: 'guide',
      results: [{ id: 1 }, { id: 2 }, { id: 3 }],
      searchIsLoading: false,
      searchMode: 'search',
      suggestions: []
    }

    methods.handleSearchMove.call(state, 'up')
    expect(state.cursor).toBe(2)

    state.cursor = -1
    methods.handleSearchMove.call(state, 'down')
    expect(state.cursor).toBe(0)
  })

  test('retires an absent resume only after a different session commits selection', () => {
    const requested = '00000000-0000-4000-8000-000000000001'
    const selected = '00000000-0000-4000-8000-000000000002'
    const agents = {
      thread: { session: { id: selected } },
      initializedWorkspaceVersion: null,
      workspaceVersion: 4
    }
    const methods = compileSearchMethods(search, ['retireResumeAfterSelection'], {
      searchPages: () => Promise.reject(new Error('Search execution was not expected.')),
      getErrorMessage: value => String(value),
      wikiStore: { page: { locale: 'en', path: 'guide' } },
      useAgentsStore: () => agents,
      isAgentSessionId: value => typeof value === 'string'
    })
    const state = { agentResumeSessionId: requested }

    methods.retireResumeAfterSelection.call(state)
    expect(state.agentResumeSessionId).toBe(requested)

    agents.initializedWorkspaceVersion = agents.workspaceVersion
    methods.retireResumeAfterSelection.call(state)
    expect(state.agentResumeSessionId).toBeNull()
  })

  test('fences a stale downloaded ranking when a newer query starts', async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { location: { origin: 'https://wiki.example.test' } }
    })
    try {
      const pendingByQuery = new Map()
      const rankingStarted = new Map([
        ['stale', deferred()],
        ['latest', deferred()]
      ])
      const adapters = compileSnapshotAdapters(search)
      const snapshots = [
        [1, 'stale', 'Stale'],
        [2, 'latest', 'Latest']
      ].map(([pageId, path, title]) =>
        OfflineSnapshotRecordSchema.parse({
          siteId: window.location.origin,
          pageId,
          locale: 'en',
          byteSize: 128,
          lastOpenedAt: '2026-01-01T00:00:00.000Z',
          snapshot: {
            schemaVersion: 1,
            pageId,
            locale: 'en',
            path,
            canonicalPath: `/en/${path}`,
            title,
            description: '',
            sourceRevision: 'revision-1',
            capturedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: null,
            content: { representation: OFFLINE_CONTENT_TYPE, sanitizerVersion: OFFLINE_HTML_SANITIZER_VERSION, html: `<p>${title}</p>` },
            searchText: title,
            contentType: OFFLINE_CONTENT_TYPE,
            integrity: `snapshot-${pageId}`
          }
        })
      )
      const storage = {
        readSnapshotCorpus: async () => ({ snapshots, corpusRevision: 1, sessionGeneration: 1 }),
        close: () => {}
      }
      const methods = compileSearchMethods(search, ['runOfflineSearch'], {
        searchPages: () => Promise.reject(new Error('Unexpected online search.')),
        getErrorMessage: value => (value instanceof Error ? value.message : String(value)),
        wikiStore: { page: { locale: 'en', path: 'guide' } },
        openOfflineStorage: async () => storage,
        ...adapters,
        prepareOfflineSearchCorpus,
        // Deliberately complete ranking after abort to exercise the component's publication fence.
        searchPreparedOfflineDocumentsAsync: (documents, query) => {
          const request = deferred()
          const document = snapshots.map(adapters.toOfflineSearchDocument).find(candidate => candidate.path === query)
          if (!document) throw new Error(`No admitted snapshot matches ${query}.`)
          pendingByQuery.set(query, { ...request, document })
          rankingStarted.get(query).resolve()
          return request.promise
        },
        OFFLINE_SEARCH_RESULT_LIMIT: 50
      })
      const retainedResponse = { results: [{ id: 1, title: 'Retained' }], suggestions: [], totalHits: 1 }
      const state = {
        offlineCorpusCount: null,
        offlineResultsTruncated: false,
        offlineSearchActive: true,
        offlineSearchCorpus: null,
        offlineSearchCorpusExpiresAt: null,
        offlineSearchCorpusRevision: null,
        offlineSearchCorpusSessionGeneration: null,
        moreError: '',
        pagination: 4,
        response: retainedResponse,
        responseKey: 'old-key',
        searchAbortController: null,
        searchError: '',
        searchIsLoading: true,
        searchMode: 'search',
        searchRequestId: 1,
        searchRequestKey: 'old-key',
        runOfflineSearch(query, requestKey, requestId) {
          return methods.runOfflineSearch.call(this, query, requestKey, requestId)
        }
      }

      const stale = methods.runOfflineSearch.call(state, 'stale', 'old-key', 1)
      await rankingStarted.get('stale').promise
      expect(pendingByQuery.has('stale')).toBe(true)
      const staleController = state.searchAbortController

      state.searchRequestId = 2
      state.searchRequestKey = 'new-key'
      staleController.abort()
      state.searchAbortController = null
      const latest = methods.runOfflineSearch.call(state, 'latest', 'new-key', 2)
      await rankingStarted.get('latest').promise
      expect(pendingByQuery.has('latest')).toBe(true)

      const latestResponse = { results: [{ document: pendingByQuery.get('latest').document, score: 1 }], hasMore: false }
      pendingByQuery.get('latest').resolve(latestResponse)
      await latest
      expect(state.response.results[0].id).toBe(2)
      expect(state.responseKey).toBe('new-key')
      expect(state.searchIsLoading).toBe(false)

      pendingByQuery.get('stale').resolve({ results: [{ document: pendingByQuery.get('stale').document, score: 1 }], hasMore: false })
      await stale
      expect(state.response.results[0].id).toBe(2)
      expect(state.responseKey).toBe('new-key')
    } finally {
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  })
  test('fences stale downloaded corpus preparation before publishing results', async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { location: { origin: 'https://wiki.example.test' } }
    })
    try {
      const pendingPreparations = []
      const pendingByQuery = new Map()
      const document = {
        pageId: 1,
        schemaVersion: 1,
        siteId: 'https://wiki.example.test',
        canonicalPath: '/en/downloaded',
        searchText: 'Downloaded',
        capturedAt: '2026-01-01T00:00:00.000Z',
        byteSize: 128,
        title: 'Downloaded',
        description: '',
        path: 'downloaded',
        locale: 'en',
        snapshot: { expiresAt: null }
      }
      const storage = {
        readSnapshotCorpus: async () => ({ snapshots: [document], corpusRevision: 1, sessionGeneration: 1 }),
        close: () => {}
      }
      const methods = compileSearchMethods(search, ['runOfflineSearch'], {
        searchPages: () => Promise.reject(new Error('Unexpected online search.')),
        getErrorMessage: value => (value instanceof Error ? value.message : String(value)),
        wikiStore: { page: { locale: 'en', path: 'guide' } },
        openOfflineStorage: async () => storage,
        isOfflineSnapshotRecord: () => true,
        isOfflineSnapshotExpired: () => false,
        toOfflineSearchDocument: ({ snapshot: _snapshot, ...value }) => value,
        prepareOfflineSearchCorpus: () => {
          const request = deferred()
          pendingPreparations.push(request)
          return request.promise
        },
        searchPreparedOfflineDocumentsAsync: (_corpus, query) => {
          const request = deferred()
          pendingByQuery.set(query, request)
          return request.promise
        },
        OFFLINE_SEARCH_RESULT_LIMIT: 50
      })
      const retainedResponse = { results: [{ id: 9, title: 'Retained' }], suggestions: [], totalHits: 1 }
      const state = {
        offlineCorpusCount: null,
        offlineResultsTruncated: false,
        offlineSearchActive: true,
        offlineSearchCorpus: null,
        offlineSearchCorpusExpiresAt: null,
        offlineSearchCorpusRevision: null,
        offlineSearchCorpusSessionGeneration: null,
        moreError: '',
        pagination: 1,
        response: retainedResponse,
        responseKey: 'old-key',
        searchAbortController: null,
        searchError: '',
        searchIsLoading: true,
        searchMode: 'search',
        searchRequestId: 1,
        searchRequestKey: 'old-key'
      }

      const stale = methods.runOfflineSearch.call(state, 'stale', 'old-key', 1)
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
      expect(pendingPreparations).toHaveLength(1)

      state.searchRequestId = 2
      state.searchRequestKey = 'new-key'
      const latest = methods.runOfflineSearch.call(state, 'latest', 'new-key', 2)
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
      expect(pendingPreparations).toHaveLength(2)

      const { snapshot: _snapshot, ...searchDocument } = document
      const latestCorpus = await prepareOfflineSearchCorpus([searchDocument])
      pendingPreparations[1].resolve(latestCorpus)
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
      expect(pendingByQuery.has('latest')).toBe(true)
      pendingByQuery.get('latest').resolve({ results: [{ document, score: 1 }], hasMore: false })
      await latest
      expect(state.offlineSearchCorpus).toBe(latestCorpus)
      expect(state.response.results[0].id).toBe(1)
      expect(state.responseKey).toBe('new-key')

      pendingPreparations[0].resolve(await prepareOfflineSearchCorpus([searchDocument]))
      await stale
      expect(state.offlineSearchCorpus).toBe(latestCorpus)
      expect(state.responseKey).toBe('new-key')
    } finally {
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  })
  test('removes a downloaded result after a committed corpus change without editing its query', async () => {
    const scheduler = useSearchScheduler()
    window.location = { origin: 'https://wiki.example.test' }
    try {
      let revision = 1
      let snapshots = [
        {
          schemaVersion: 1,
          siteId: window.location.origin,
          pageId: 1,
          locale: 'en',
          path: 'downloaded',
          canonicalPath: '/en/downloaded',
          title: 'Saved specimen',
          description: '',
          searchText: 'downloaded',
          byteSize: 128,
          capturedAt: '2026-01-01T00:00:00.000Z',
          snapshot: { expiresAt: null }
        }
      ]
      const replacementFinished = deferred()
      const methods = compileSearchMethods(search, ['handleOfflineStorageChange', 'queueSearch', 'runSearch', 'runOfflineSearch'], {
        openOfflineStorage: async () => ({
          readSnapshotCorpus: async () => ({ snapshots, corpusRevision: revision, sessionGeneration: 1 }),
          currentCorpusRevision: async () => revision,
          currentSessionGeneration: async () => 1,
          close: () => {}
        }),
        emptySearchResponse: () => ({ results: [], suggestions: [], totalHits: 0 }),
        getErrorMessage: value => String(value),
        currentOfflineReadingHandle: () => null,
        currentOfflineReadingEpoch: () => 0,
        isOfflineSnapshotRecord: () => true,
        isOfflineSnapshotExpired: () => false,
        toOfflineSearchDocument: ({ snapshot: _snapshot, ...value }) => value,
        prepareOfflineSearchCorpus,
        searchPreparedOfflineDocumentsAsync,
        OFFLINE_SEARCH_RESULT_LIMIT: 50
      })
      const state = {
        search: 'downloaded',
        searchMode: 'search',
        offlineSearchActive: true,
        offlineSearchCorpus: null,
        offlineSearchCorpusRevision: null,
        offlineSearchCorpusSessionGeneration: null,
        offlineSearchCorpusExpiresAt: null,
        response: { results: [], suggestions: [], totalHits: 0 },
        responseKey: '',
        searchRequestId: 1,
        searchRequestKey: 'same-query',
        searchAbortController: null,
        moreAbortController: null,
        searchTimer: null,
        searchIsLoading: false,
        searchError: '',
        cursor: -1,
        queueSearch(query) {
          return methods.queueSearch.call(this, query)
        },
        async runSearch(...args) {
          await methods.runSearch.apply(this, args)
          replacementFinished.resolve()
        },
        runOfflineSearch(...args) {
          return methods.runOfflineSearch.apply(this, args)
        }
      }
      await state.runOfflineSearch(state.search, state.searchRequestKey, state.searchRequestId)
      expect(state.response.results.map(result => result.id)).toEqual([1])
      snapshots = []
      revision += 1
      methods.handleOfflineStorageChange.call(state, { kind: 'corpus', corpusRevision: revision, sessionGeneration: 1 })
      expect(state.response.results).toEqual([])
      scheduler.runNext()
      await replacementFinished.promise
      expect(state.search).toBe('downloaded')
      expect(state.responseQuery).toBe('downloaded')
      expect(state.responseKey).toBe('same-query')
      expect(state.response.results).toEqual([])
      expect(state.offlineCorpusCount).toBe(0)
      expect(state.searchError).toBe('')
    } finally {
      scheduler.restore()
    }
  })
  test.each(['corpus', 'query', 'session', 'reading epoch', 'mode'])('replaces a deferred stale corpus only under current authority: %s', async change => {
    const scheduler = useSearchScheduler()
    window.location = { origin: 'https://wiki.example.test' }
    try {
      let revision = 1
      let sessionGeneration = 1
      let readingEpoch = 0
      const ranked = deferred()
      const rankingStarted = deferred()
      const replacementFinished = deferred()
      let rankings = 0
      let reads = 0
      const document = title => ({
        schemaVersion: 1,
        siteId: window.location.origin,
        pageId: revision,
        locale: 'en',
        path: 'downloaded',
        canonicalPath: '/en/downloaded',
        title,
        description: '',
        searchText: 'downloaded',
        byteSize: 128,
        capturedAt: '2026-01-01T00:00:00.000Z',
        snapshot: { expiresAt: null }
      })
      const storage = {
        readSnapshotCorpus: async () => {
          reads += 1
          return { snapshots: [document(`Revision ${revision}`)], corpusRevision: revision, sessionGeneration }
        },
        currentCorpusRevision: async () => revision,
        currentSessionGeneration: async () => sessionGeneration,
        close: () => {}
      }
      const methods = compileSearchMethods(search, ['queueSearch', 'runSearch', 'runOfflineSearch'], {
        openOfflineStorage: async () => storage,
        getErrorMessage: value => String(value),
        currentOfflineReadingHandle: () => null,
        currentOfflineReadingEpoch: () => readingEpoch,
        isOfflineSnapshotRecord: () => true,
        isOfflineSnapshotExpired: () => false,
        toOfflineSearchDocument: ({ snapshot: _snapshot, ...value }) => value,
        prepareOfflineSearchCorpus,
        searchPreparedOfflineDocumentsAsync: async (corpus, query, options) => {
          const response = await searchPreparedOfflineDocumentsAsync(corpus, query, options)
          rankings += 1
          if (rankings === 1) {
            rankingStarted.resolve()
            await ranked.promise
          }
          return response
        },
        OFFLINE_SEARCH_RESULT_LIMIT: 50
      })
      const retained = { results: [{ id: 9, title: 'Retained' }], suggestions: [], totalHits: 1 }
      const state = {
        offlineSearchActive: true,
        offlineSearchCorpus: null,
        offlineSearchCorpusRevision: null,
        offlineSearchCorpusSessionGeneration: null,
        offlineSearchCorpusExpiresAt: null,
        response: retained,
        responseKey: 'same-key',
        searchRequestId: 1,
        searchRequestKey: 'same-key',
        searchMode: 'search',
        searchAbortController: null,
        moreAbortController: null,
        searchTimer: null,
        searchIsLoading: true,
        searchError: '',
        cursor: -1,
        queueSearch(query) {
          return methods.queueSearch.call(this, query)
        },
        async runSearch(...args) {
          await methods.runSearch.apply(this, args)
          replacementFinished.resolve()
        },
        runOfflineSearch(...args) {
          return methods.runOfflineSearch.apply(this, args)
        }
      }
      const first = state.runOfflineSearch('downloaded', 'same-key', 1)
      await rankingStarted.promise
      revision = 2
      if (change === 'query') {
        state.searchRequestId += 1
        state.searchRequestKey = 'new-query'
      }
      if (change === 'session') sessionGeneration = 2
      if (change === 'reading epoch') readingEpoch += 1
      if (change === 'mode') state.searchMode = 'ask'
      ranked.resolve()
      await first
      expect(state.response).toBe(retained)
      if (change !== 'corpus') {
        expect(scheduler.pending()).toBe(0)
        expect(reads).toBe(1)
        return
      }
      expect(state.responseKey).toBe('')
      expect(state.offlineSearchCorpus).toBeNull()
      expect(scheduler.pending()).toBe(1)
      scheduler.runNext()
      await replacementFinished.promise
      expect(state.response.results.map(result => result.title)).toEqual(['Revision 2'])
      expect(state.responseKey).toBe('same-key')
      expect(state.responseQuery).toBe('downloaded')
      expect(state.searchIsLoading).toBe(false)
      expect(reads).toBe(2)
      expect(rankings).toBe(2)
      expect(scheduler.pending()).toBe(0)
    } finally {
      scheduler.restore()
    }
  })
  test('expires a cached private pair at the deadline without a corpus revision change', async () => {
    const harness = createPrivateExpirySearch(search)
    const { state } = harness
    try {
      await harness.runQuery('quasar')
      expect(state.response.results.map(result => result.id)).toEqual([1, 2])
      expect(state.response.results.every(result => result.visibility === 'private')).toBe(true)
      expect(state.offlineCorpusCount).toBe(2)
      expect(state.offlinePrivateSearchCorpus).not.toBeNull()

      harness.advanceToDeadline()
      await harness.runQuery('transient')
      expect(state.response.results).toEqual([])
      expect(state.responseKey).toBe('private:transient')
      expect(state.offlineCorpusCount).toBe(1)
      expect(state.searchError).toBe('')

      await harness.runQuery('stellar')
      expect(state.response.results.map(result => result.id)).toEqual([2])
      expect(state.response.results[0].visibility).toBe('private')
      expect(state.offlineCorpusCount).toBe(1)
      expect(state.offlinePrivateSearchCorpusExpiresAt).toBeNull()
      expect(state.searchError).toBe('')
    } finally {
      harness.restore()
    }
  })
  test('cannot publish private ranking across its deadline and refreshes the same query without an authentication error', async () => {
    const harness = createPrivateExpirySearch(search, { deferFirstRanking: true })
    const { state, scheduler } = harness
    try {
      const first = harness.runQuery('stellar')
      const ranked = await harness.rankingStarted.promise
      expect(ranked.results.map(result => result.document.pageId)).toEqual([1, 2])
      harness.advanceToDeadline()
      harness.releaseRanking.resolve()
      await first

      expect(state.response.results).toEqual([])
      expect(state.responseKey).toBe('')
      expect(state.searchError).toBe('')
      expect(state.offlinePrivateSearchCorpus).toBeNull()
      expect(state.offlinePrivateSearchCorpusExpiresAt).toBeNull()
      expect(scheduler.pending()).toBe(1)

      scheduler.runNext()
      await harness.replacementFinished.promise
      expect(state.search).toBe('stellar')
      expect(state.responseQuery).toBe('stellar')
      expect(state.responseKey).toBe('private:stellar')
      expect(state.response.results.map(result => result.id)).toEqual([2])
      expect(state.response.results[0].visibility).toBe('private')
      expect(state.offlineCorpusCount).toBe(1)
      expect(state.offlinePrivateSearchEnabled).toBe(true)
      expect(state.searchError).toBe('')
      expect(state.searchIsLoading).toBe(false)
      expect(scheduler.pending()).toBe(0)
    } finally {
      harness.releaseRanking.resolve()
      harness.restore()
    }
  })
  test.each(['reading-state event', 'search without a reading handle'])('clears the private cache deadline after %s', async reset => {
    const harness = createPrivateExpirySearch(search)
    const { state, methods } = harness
    try {
      await harness.runQuery('quasar')
      expect(state.response.results.map(result => result.id)).toEqual([1, 2])
      // Seed cache metadata so the reset contract is exercised independently of deadline population.
      state.offlinePrivateSearchCorpusExpiresAt = harness.expiresAt
      harness.lock()
      if (reset === 'reading-state event') methods.handleOfflineReadingStateChange.call(state)
      else await harness.runQuery('stellar')

      expect(state.response.results).toEqual([])
      expect(state.offlinePrivateSearchCorpus).toBeNull()
      expect(state.offlinePrivateSearchCorpusRevision).toBeNull()
      expect(state.offlinePrivateSearchCorpusSessionGeneration).toBeNull()
      expect(state.offlinePrivateSearchCorpusExpiresAt).toBeNull()
      expect(state.offlinePrivateSearchEnabled).toBe(false)
      expect(state.searchError).toBe('')
      expect(harness.scheduler.pending()).toBe(0)
    } finally {
      harness.restore()
    }
  })
  test.each(['visible deadline', 'same-query reopen'])('retires rendered private metadata through %s without a corpus revision change', async transition => {
    const harness = await mountPrivateExpirySearch(search)
    const { container } = harness
    try {
      await harness.completeSearch()
      expect(container.querySelectorAll('.search-results-row')).toHaveLength(3)
      expect(container.textContent).toContain('Quasar stellar transient')
      expect(container.querySelectorAll('.fixture-cited-copy:disabled')).toHaveLength(3)
      expect(container.querySelector('.search-results-preview')).toBeNull()

      if (transition === 'same-query reopen') {
        await harness.close()
        await harness.reopen()
        expect(container.querySelectorAll('.search-results-row')).toHaveLength(3)
        expect(container.querySelector('.search-results-loader')).toBeNull()
        await harness.close()
      }
      harness.advanceToDeadline()
      if (transition === 'same-query reopen') {
        // Deliberately leave the deadline callback pending, as in a suspended tab.
        await harness.reopen()
      } else {
        harness.scheduler.runNext(1000)
        await Vue.nextTick()
      }
      expect(container.textContent).not.toContain('Quasar stellar transient')
      expect(container.querySelector('[title="Quasar stellar transient"]')).toBeNull()
      await harness.completeSearch()
      expect(container.querySelectorAll('.search-results-row')).toHaveLength(2)
      expect(container.textContent).toContain('Observatory notes')
      expect(container.textContent).toContain('Quasar public reference')
      expect(container.textContent).not.toContain('Quasar stellar transient')
      expect(container.querySelectorAll('.fixture-cited-copy:disabled')).toHaveLength(2)
      expect(container.querySelector('.search-results-preview')).toBeNull()
      expect(container.querySelector('.search-results-summary')).not.toBeNull()
      expect(container.querySelector('.search-results-previous, .search-results-loader, [role="alert"]')).toBeNull()
      expect(container.querySelector('.search-results')?.getAttribute('aria-busy')).toBe('false')
      expect(container.querySelector('input')?.value).toBe('quasar')
      await harness.close()
      await harness.reopen()
      expect(container.querySelectorAll('.search-results-row')).toHaveLength(2)
      expect(container.textContent).not.toContain('Quasar stellar transient')
    } finally {
      harness.restore()
    }
  })

  test('never renders a private title from ranking delivered after expiry and settles the same query with public and unexpired hits', async () => {
    const harness = await mountPrivateExpirySearch(search, { deferFirstRanking: true })
    const { container } = harness
    try {
      const firstFinished = harness.nextSearchFinished()
      harness.scheduler.runNext(300)
      const ranked = await harness.rankingStarted.promise
      expect(ranked.results.map(result => result.document.pageId).sort()).toEqual([1, 2, 3])
      harness.advanceToDeadline()
      harness.releaseRanking.resolve()
      await firstFinished
      await Vue.nextTick()
      expect(container.textContent).not.toContain('Quasar stellar transient')
      expect(container.querySelector('[title="Quasar stellar transient"]')).toBeNull()

      await harness.completeSearch()
      expect(container.querySelectorAll('.search-results-row')).toHaveLength(2)
      expect(container.textContent).toContain('Observatory notes')
      expect(container.textContent).toContain('Quasar public reference')
      expect(container.textContent).not.toContain('Quasar stellar transient')
      expect(container.querySelectorAll('.fixture-cited-copy:disabled')).toHaveLength(2)
      expect(container.querySelector('.search-results-preview, .search-results-loader, .search-results-previous, [role="alert"]')).toBeNull()
      expect(container.querySelector('.search-results-summary')).not.toBeNull()
      expect(container.querySelector('.search-results')?.getAttribute('aria-busy')).toBe('false')
      expect(container.querySelector('input')?.value).toBe('quasar')
    } finally {
      harness.releaseRanking.resolve()
      harness.restore()
    }
  })
})
