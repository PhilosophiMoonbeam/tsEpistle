import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { OFFLINE_CONTENT_TYPE, OFFLINE_HTML_SANITIZER_VERSION, OfflineSnapshotRecordSchema } from '../../../shared/offline.ts'
import { currentOfflineReadingEpoch, currentOfflineReadingHandle } from '../../helpers/offline-session.ts'
import { mergeOfflineSearchCorpora, prepareOfflineSearchCorpus, searchPreparedOfflineDocumentsAsync } from '../../helpers/offline-search.ts'

const compileSearchMethods = (source, names, dependencies) => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Search component script was not found.')

  const sourceFile = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let methods
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'methods' && ts.isObjectLiteralExpression(node.initializer)) {
      methods = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!methods) throw new Error('Search component methods were not found.')

  const selected = new Set(names)
  const declarations = methods.properties.filter(node => ts.isMethodDeclaration(node) && selected.has(node.name.getText(sourceFile)))
  if (declarations.length !== selected.size) throw new Error('A requested search method was not found.')

  const factorySource = `(searchPages, getErrorMessage, wikiStore, useAgentsStore, isAgentSessionId, emptySearchResponse, retryServerConnection, openOfflineStorage, isOfflineSnapshotRecord, isOfflineSnapshotExpired, toOfflineSearchDocument, prepareOfflineSearchCorpus, searchPreparedOfflineDocumentsAsync, OFFLINE_SEARCH_RESULT_LIMIT, currentOfflineReadingHandle, currentOfflineReadingEpoch, mergeOfflineSearchCorpora) => ({${declarations.map(node => node.getText(sourceFile)).join(',')}})`
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
    dependencies.mergeOfflineSearchCorpora ?? mergeOfflineSearchCorpora
  )
}

const compileSnapshotAdapters = source => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Search component script was not found.')
  const sourceFile = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set(['OFFLINE_LOCALE_PATTERN', 'isOfflineLocale', 'isOfflineSnapshotRecord', 'isOfflineSnapshotExpired', 'toOfflineSearchDocument'])
  const declarations = sourceFile.statements.filter(
    statement =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
  )
  if (declarations.length !== names.size) throw new Error('Offline snapshot adapters were not found.')
  const compiled = ts.transpileModule(
    `${declarations.map(node => node.getText(sourceFile)).join('\n')}\nreturn { isOfflineSnapshotRecord, isOfflineSnapshotExpired, toOfflineSearchDocument }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText
  return new Function(compiled)()
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

const useSearchScheduler = () => {
  const originalWindow = globalThis.window
  let nextId = 0
  const timers = new Map()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      clearTimeout: id => timers.delete(id),
      fetch: () => Promise.reject(new Error('Unexpected fetch')),
      setTimeout: callback => {
        const id = ++nextId
        timers.set(id, callback)
        return id
      }
    }
  })
  return {
    pending: () => timers.size,
    runNext: () => {
      const entry = timers.entries().next().value
      if (!entry) throw new Error('No scheduled search was available.')
      timers.delete(entry[0])
      entry[1]()
    },
    restore: () => {
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  }
}

describe('inline Ask mode contract', () => {
  const searchPath = path.join(process.cwd(), 'client/components/common/search-results.vue')
  const search = fs.readFileSync(searchPath, 'utf8')

  test('retains results without loading during replacement debounce, blocks stale navigation, and rejects the stale response', async () => {
    const scheduler = useSearchScheduler()
    try {
      const pendingByQuery = new Map()
      const methods = compileSearchMethods(search, ['queueSearch', 'runSearch', 'handleResultClick', 'navigateToPage'], {
        searchPages: (_fetcher, query) => {
          const request = deferred()
          pendingByQuery.set(query, request)
          return request.promise
        },
        getErrorMessage: value => (value instanceof Error ? value.message : String(value)),
        wikiStore: { page: { locale: 'en', path: 'guide' } }
      })
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
        hasFreshResponse: false,
        searchMode: 'search',
        searchRequestId: 0,
        searchRequestKey: 'replacement-key',
        searchRestrictLocale: false,
        searchRestrictPath: false,
        serverCapabilitiesAvailable: true,
        searchTimer: null,
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

  test('Ask about a query prepares scoped editable context without submitting', async () => {
    const prepared = []
    const methods = compileSearchMethods(search, ['askCurrentQuery', 'agentSearchScope'], {})
    const state = {
      canAsk: true,
      normalizedSearch: 'pizza',
      directPromptHandoffPending: false,
      currentPageLocale: 'en',
      currentPagePath: 'recipes',
      searchRestrictLocale: true,
      searchRestrictPath: true,
      searchMode: 'search',
      latchAgentOpeningPage() {},
      activeModalOpener: () => null,
      $nextTick: () => Promise.resolve(),
      $refs: {
        inlineAgent: {
          preparePrompt: async (...args) => {
            prepared.push(args)
          },
          sendPrompt: () => {
            throw new Error('A search handoff must not submit.')
          }
        }
      },
      agentSearchScope() {
        return methods.agentSearchScope.call(this)
      }
    }
    await methods.askCurrentQuery.call(state)
    expect(state.searchMode).toBe('ask')
    expect(state.normalizedSearch).toBe('pizza')
    expect(prepared).toEqual([['pizza', undefined, { kind: 'section', locale: 'en', path: 'recipes' }]])
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
      const rankingStarted = new Map([['stale', deferred()], ['latest', deferred()]])
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
        schemaVersion: 1, siteId: window.location.origin, pageId: revision,
        locale: 'en', path: 'downloaded', canonicalPath: '/en/downloaded',
        title, description: '', searchText: 'downloaded', byteSize: 128,
        capturedAt: '2026-01-01T00:00:00.000Z', snapshot: { expiresAt: null }
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
        offlineSearchActive: true, offlineSearchCorpus: null,
        offlineSearchCorpusRevision: null, offlineSearchCorpusSessionGeneration: null,
        offlineSearchCorpusExpiresAt: null, response: retained, responseKey: 'same-key',
        searchRequestId: 1, searchRequestKey: 'same-key', searchMode: 'search',
        searchAbortController: null, moreAbortController: null, searchTimer: null,
        searchIsLoading: true, searchError: '', cursor: -1,
        queueSearch(query) { return methods.queueSearch.call(this, query) },
        async runSearch(...args) {
          await methods.runSearch.apply(this, args)
          replacementFinished.resolve()
        },
        runOfflineSearch(...args) { return methods.runOfflineSearch.apply(this, args) }
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
})
