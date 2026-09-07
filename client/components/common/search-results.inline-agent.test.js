import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'

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

  const factorySource = `(searchPages, getErrorMessage, wikiStore) => ({${declarations.map(node => node.getText(sourceFile)).join(',')}})`
  const compiled = ts.transpileModule(`const factory = ${factorySource}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None
    }
  }).outputText
  const factory = new Function(`${compiled}\nreturn factory`)()
  return factory(dependencies.searchPages, dependencies.getErrorMessage, dependencies.wikiStore)
}

const deferred = () => {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
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

  test('retains results without loading during replacement debounce and rejects the stale response', async () => {
    const scheduler = useSearchScheduler()
    try {
      const pendingByQuery = new Map()
      const methods = compileSearchMethods(search, ['queueSearch', 'runSearch'], {
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
        searchMode: 'search',
        searchRequestId: 0,
        searchRequestKey: 'replacement-key',
        searchRestrictLocale: false,
        searchRestrictPath: false,
        searchTimer: null,
        runSearch(query, requestKey, requestId) {
          return methods.runSearch.call(this, query, requestKey, requestId)
        }
      }

      methods.queueSearch.call(state, 'replacement')
      expect(state.response).toBe(retainedResponse)
      expect(state.searchIsLoading).toBe(false)
      expect(scheduler.pending()).toBe(1)

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

})
