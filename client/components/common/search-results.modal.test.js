import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { JSDOM } from 'jsdom'
import { activeOwnedOverlayRoots, createModalFocusScope } from './modal-focus-scope.ts'

const compileSearchMethods = (source, names, dependencies = {}) => {
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

  const compiled = ts.transpileModule(`const methods = ({${declarations.map(node => node.getText(sourceFile)).join(',')}})`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None
    }
  }).outputText
  return new Function(...Object.keys(dependencies), `${compiled}\nreturn methods`)(...Object.values(dependencies))
}

describe('clearable search recovery', () => {
  test('clears pending results on null and schedules a replacement query', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
    const scheduled = []
    const cancelled = []
    const methods = compileSearchMethods(source, ['queueSearch'], {
      window: {
        clearTimeout: timer => cancelled.push(timer),
        setTimeout: callback => { scheduled.push(callback); return scheduled.length }
      },
      emptySearchResponse: () => ({ results: [], suggestions: [] })
    })
    const requests = []
    let aborted = false
    const state = {
      cursor: 2,
      searchRequestId: 1,
      searchAbortController: { abort: () => { aborted = true } },
      searchTimer: 99,
      searchIsLoading: true,
      searchMode: 'search',
      searchError: 'Old error',
      responseKey: 'old',
      response: { results: [{ id: 1 }], suggestions: ['old'] },
      searchRequestKey: 'replacement',
      runSearch: (...args) => requests.push(args)
    }
    methods.queueSearch.call(state, null)
    expect(aborted).toBe(true)
    expect(cancelled).toEqual([99])
    expect(state.response).toEqual({ results: [], suggestions: [] })
    expect(state.searchIsLoading).toBe(false)
    expect(state.searchError).toBe('')
    expect(scheduled).toHaveLength(0)
    methods.queueSearch.call(state, '  replacement query  ')
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(requests).toEqual([['replacement query', 'replacement', 3]])
    expect(state.searchIsLoading).toBe(true)
  })
})

describe('Ask modal accessibility contract', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  test('restores focus to the remounted zero-result Ask action instead of the global trigger', () => {
    const methods = compileSearchMethods(search, ['restoreTargetFor'])
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const fixtureDocument = dom.window.document
    const focusKey = 'test-ask-focus'
    const opener = fixtureDocument.createElement('button')
    const replacement = fixtureDocument.createElement('button')
    const globalFallback = fixtureDocument.createElement('button')

    opener.dataset.modalFocusKey = focusKey
    replacement.dataset.modalFocusKey = focusKey
    fixtureDocument.body.append(opener, replacement, globalFallback)
    opener.remove()

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: fixtureDocument
    })

    try {
      const resolveTarget = methods.restoreTargetFor.call(
        {
          findSearchTrigger: () => globalFallback
        },
        opener
      )

      expect(opener.isConnected).toBe(false)
      expect(replacement.isConnected).toBe(true)
      expect(resolveTarget()).toBe(replacement)
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
      else delete globalThis.document
      dom.window.close()
    }
  })

  test('dismisses only outside the search surface and never through an active Agent layer', () => {
    const methods = compileSearchMethods(search, ['handleBackdropClick'])
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
    const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')
    const fixtureDocument = dom.window.document
    const backdrop = fixtureDocument.createElement('div')
    const searchSurface = fixtureDocument.createElement('div')
    const searchChild = fixtureDocument.createElement('button')
    const preview = fixtureDocument.createElement('div')
    const previewChild = fixtureDocument.createElement('button')
    const agent = fixtureDocument.createElement('section')
    const returnToSearch = fixtureDocument.createElement('button')
    let closeCalls = 0

    searchSurface.className = 'search-results-search'
    preview.className = 'wiki-source-preview'
    agent.className = 'inline-agent'
    agent.append(returnToSearch)
    searchSurface.append(searchChild)
    preview.append(previewChild)
    backdrop.append(searchSurface, preview, agent)

    Object.defineProperty(globalThis, 'Element', {
      configurable: true,
      writable: true,
      value: dom.window.Element
    })

    try {
      const state = {
        isAgentOpen: false,
        closeSearch: () => {
          closeCalls += 1
        }
      }

      methods.handleBackdropClick.call(state, { target: backdrop })
      expect(closeCalls).toBe(1)

      methods.handleBackdropClick.call(state, { target: searchChild })
      methods.handleBackdropClick.call(state, { target: previewChild })
      // Agent's return button has already changed the mode when its click bubbles.
      methods.handleBackdropClick.call(state, { target: returnToSearch })
      expect(closeCalls).toBe(1)

      state.isAgentOpen = true
      methods.handleBackdropClick.call(state, { target: backdrop })
      expect(closeCalls).toBe(1)
    } finally {
      if (originalElement) Object.defineProperty(globalThis, 'Element', originalElement)
      else delete globalThis.Element
      dom.window.close()
    }
  })
  test('Escape from Agent dismisses both modal layers and restores the current page', async () => {
    const agentStore = {
      closeWorkspaceCalls: 0,
      closeWorkspace() {
        this.closeWorkspaceCalls += 1
      }
    }
    const methods = compileSearchMethods(
      search,
      ['activateAgentModal', 'activateSearchModal', 'closeSearch', 'finishSearchFocus', 'deactivateModalLayers', 'deactivateAgentModal'],
      {
        activeOwnedOverlayRoots,
        createModalFocusScope,
        useAgentsStore: () => agentStore
      }
    )
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'https://wiki.test/current/page?keep=1&agentApproval=approval-id#section'
    })
    const fixtureWindow = dom.window
    const fixtureDocument = fixtureWindow.document
    const originalGlobals = Object.fromEntries(['document', 'window', 'HTMLElement'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
    const pageOpener = fixtureDocument.createElement('button')
    const root = fixtureDocument.createElement('section')
    const agentComposer = fixtureDocument.createElement('textarea')
    const nestedOverlay = fixtureDocument.createElement('div')
    const nestedOverlayControl = fixtureDocument.createElement('button')
    let state

    root.tabIndex = -1
    nestedOverlay.className = 'v-overlay--active'
    nestedOverlayControl.className = 'agent-owned-overlay'
    nestedOverlay.append(nestedOverlayControl)
    root.append(agentComposer, nestedOverlay)
    fixtureDocument.body.append(pageOpener, root)
    Object.defineProperty(fixtureWindow, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true })
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: fixtureDocument
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: fixtureWindow
    })
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      writable: true,
      value: fixtureWindow.HTMLElement
    })

    try {
      state = {
        $el: root,
        $nextTick: async () => undefined,
        $refs: {},
        canAsk: true,
        searchMode: 'ask',
        searchIsFocused: true,
        search: 'where is the current page?',
        approvalId: 'approval-id',
        agentResumeSessionId: null,
        agentOpeningPage: { id: 17, locale: 'en', path: 'current/page', observedUpdatedAt: '2026-09-28T00:00:00.000Z' },
        agentOpeningPageCaptured: true,
        pendingAskRestoreTarget: null,
        searchRestoreTarget: pageOpener,
        directPromptHandoffId: 0,
        modalFocusScope: null,
        searchModalFocusScope: null,
        get isAgentOpen() {
          return this.canAsk && this.searchMode === 'ask'
        },
        activeModalOpener: () => agentComposer,
        isSearchControl: () => false,
        restoreTargetFor: target => () => target,
        searchModalAdditionalRoots: () => [],
        syncSearchInputA11y: () => [],
        retireResumeAfterSelection: () => undefined,
        findSearchTrigger: () => pageOpener
      }
      for (const name of ['activateSearchModal', 'closeSearch', 'finishSearchFocus', 'deactivateModalLayers', 'deactivateAgentModal']) {
        state[name] = (...args) => methods[name].call(state, ...args)
      }

      pageOpener.focus()
      methods.activateSearchModal.call(state, pageOpener)
      await methods.activateAgentModal.call(state)
      agentComposer.focus()

      const nestedEscape = new fixtureWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      nestedOverlayControl.dispatchEvent(nestedEscape)
      expect(nestedEscape.defaultPrevented).toBe(false)
      expect(state.isAgentOpen).toBe(true)
      expect(state.searchIsFocused).toBe(true)
      expect(agentStore.closeWorkspaceCalls).toBe(0)

      nestedOverlay.classList.remove('v-overlay--active')
      const agentEscape = new fixtureWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      agentComposer.dispatchEvent(agentEscape)
      expect(agentEscape.defaultPrevented).toBe(true)
      expect(state.isAgentOpen).toBe(false)
      expect(state.searchIsFocused).toBe(false)
      expect(state.searchMode).toBe('search')
      expect(state.search).toBe('')
      expect(state.approvalId).toBe('')
      expect(state.modalFocusScope).toBeNull()
      expect(state.searchModalFocusScope).toBeNull()
      expect(fixtureDocument.activeElement).toBe(pageOpener)
      expect(agentStore.closeWorkspaceCalls).toBe(1)
      expect(fixtureWindow.location.pathname).toBe('/current/page')
      expect(fixtureWindow.location.search).toBe('?keep=1')
      state.searchIsFocused = true
      state.search = 'search again'
      methods.activateSearchModal.call(state, pageOpener)
      agentComposer.focus()
      const searchEscape = new fixtureWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      agentComposer.dispatchEvent(searchEscape)
      expect(searchEscape.defaultPrevented).toBe(true)
      expect(state.searchIsFocused).toBe(false)
      expect(state.search).toBe('')
      expect(state.searchModalFocusScope).toBeNull()
      expect(fixtureDocument.activeElement).toBe(pageOpener)
      expect(agentStore.closeWorkspaceCalls).toBe(1)
      expect(fixtureWindow.location.hash).toBe('#section')
    } finally {
      state?.deactivateModalLayers(false)
      for (const [name, descriptor] of Object.entries(originalGlobals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
      fixtureWindow.close()
    }
  })
})

const compileSearchComputed = (source, names) => {
  const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Search component script was not found.')
  const sourceFile = ts.createSourceFile('search-results.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let computed
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'computed' && ts.isObjectLiteralExpression(node.initializer)) {
      computed = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const selected = new Set(names)
  const declarations = computed.properties.filter(node => ts.isMethodDeclaration(node) && selected.has(node.name.getText(sourceFile)))
  if (declarations.length !== selected.size) throw new Error('A requested search computed property was not found.')
  const compiled = ts.transpileModule(`const computed = ({${declarations.map(node => node.getText(sourceFile)).join(',')}})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  return new Function(`${compiled}\nreturn computed`)()
}

describe('Search panel layout and hand-off', () => {
  const search = fs.readFileSync(path.join(process.cwd(), 'client/components/common/search-results.vue'), 'utf8')
  const english = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8')).common
  const translate = (key, options = {}) => {
    const [, keyPath] = key.split(':')
    const [group, name] = keyPath.split('.')
    const entries = english[group]
    const value = entries[`${name}_${options.count === 1 ? 'one' : 'other'}`] ?? entries[name]
    if (typeof value !== 'string') throw new Error(`Missing English string ${key}`)
    return value.replace(/\{\{(\w+)\}\}/g, (_, field) => String(options[field]))
  }

  test('folds truncation into one result summary', () => {
    const computed = compileSearchComputed(search, ['resultSummary', 'resultSummaryHint'])
    const summarize = (response, extra = {}) => {
      const state = { $t: translate, hasFreshResponse: true, offlineSearchActive: false, offlineCorpusCount: null, offlineResultsTruncated: false, response, ...extra }
      return [computed.resultSummary.call(state), computed.resultSummaryHint.call(state)]
    }
    const rows = count => Array.from({ length: count }, (_, id) => ({ id }))
    expect(summarize({ results: rows(1), totalHits: 1 })).toEqual(['1 match', ''])
    expect(summarize({ results: rows(12), totalHits: 12 })).toEqual(['12 matches', ''])
    expect(summarize({ results: rows(10), totalHits: 37, nextCursor: 'next' })).toEqual(['Top 10 of 37 matches', ''])
    expect(summarize({ results: rows(50), totalHits: 230, windowTruncated: true })).toEqual(['Top 50 of 230+ matches', 'Narrow the query or scope to find more'])
    expect(summarize({ results: rows(5), totalHits: 0 }, { offlineSearchActive: true, offlineCorpusCount: 9 })).toEqual(['9 saved pages searched', ''])
    expect(summarize({ results: rows(50), totalHits: 0 }, { offlineSearchActive: true, offlineCorpusCount: 80, offlineResultsTruncated: true }))
      .toEqual(['Top 50 matches from 80 saved pages', 'Narrow the query to find more'])
    expect(summarize({ results: [], totalHits: 0 })).toEqual(['', ''])
  })

  test('keeps live-only scope filters focusable offline but does not apply them', () => {
    const methods = compileSearchMethods(search, ['toggleLocaleScope', 'togglePathScope'])
    const state = { offlineSearchActive: true, searchRestrictLocale: false, searchRestrictPath: false }
    methods.toggleLocaleScope.call(state)
    methods.togglePathScope.call(state)
    expect(state).toMatchObject({ searchRestrictLocale: false, searchRestrictPath: false })
    state.offlineSearchActive = false
    methods.toggleLocaleScope.call(state)
    methods.togglePathScope.call(state)
    expect(state).toMatchObject({ searchRestrictLocale: true, searchRestrictPath: true })
  })

  test('Agent search button returns to the page search and focuses the header field', async () => {
    let focusRequests = 0
    const methods = compileSearchMethods(search, ['returnToSearch'], { emitSearchFocus: () => { focusRequests += 1 } })
    const deactivations = []
    const state = {
      searchMode: 'ask',
      searchIsFocused: true,
      canAsk: true,
      directPromptHandoffId: 3,
      pendingAskRestoreTarget: {},
      agentResumeSessionId: 'session',
      get isAgentOpen() { return this.canAsk && this.searchMode === 'ask' },
      captureAgentExcursion() { this.agentResumeSessionId = null },
      deactivateAgentModal(restoreFocus) { deactivations.push(restoreFocus) },
      $nextTick: () => Promise.resolve()
    }
    await methods.returnToSearch.call(state)
    expect(state.searchMode).toBe('search')
    expect(state.searchIsFocused).toBe(true)
    expect(state.pendingAskRestoreTarget).toBeNull()
    expect(state.agentResumeSessionId).toBeNull()
    expect(deactivations).toEqual([false, false])
    expect(focusRequests).toBe(1)

    const superseded = { ...state, searchMode: 'ask', $nextTick() { this.directPromptHandoffId += 1; return Promise.resolve() } }
    Object.defineProperty(superseded, 'isAgentOpen', { get() { return this.canAsk && this.searchMode === 'ask' } })
    await methods.returnToSearch.call(superseded)
    expect(focusRequests).toBe(1)
  })
})
