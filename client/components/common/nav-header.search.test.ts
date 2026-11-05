import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { registerSearchAgentExit, requestSearchAgentExit, type SearchAgentExitIntent } from '../../helpers/search-navigation-events.ts'

// Execute the component's handlers without coupling these keyboard contracts to
// unrelated account, transport, or page-action fixtures.
const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/nav-header.vue'), 'utf8')
const script = source.match(/<script lang=['"]ts['"]>([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error('Header component script was not found')
const sourceFile = ts.createSourceFile('nav-header.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let methodsNode: ts.ObjectLiteralExpression | undefined
let watchNode: ts.ObjectLiteralExpression | undefined
const visit = (node: ts.Node): void => {
  if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'methods' && ts.isObjectLiteralExpression(node.initializer))
    methodsNode = node.initializer
  if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'watch' && ts.isObjectLiteralExpression(node.initializer)) watchNode = node.initializer
  ts.forEachChild(node, visit)
}
visit(sourceFile)
if (!methodsNode) throw new Error('Header component methods were not found')
const selected: Record<string, true> = {
  searchFocus: true,
  searchClose: true,
  searchToggle: true,
  focusSearchField: true,
  handleSearchFocusCommand: true,
  handleSearchShortcut: true,
  searchEnter: true,
  searchMove: true,
  closePageActionMenus: true,
  openAgent: true,
  revealReadingChrome: true,
  setReadingChromeHidden: true,
  openSearchQuickCreate: true,
  finishSearchQuickCreate: true
}
const declarations = methodsNode.properties.filter(node => ts.isMethodDeclaration(node) && selected[node.name.getText(sourceFile)])
if (declarations.length !== Object.keys(selected).length) throw new Error('A header search handler was not found')
const breakpointWatcher = watchNode?.properties.find(
  node => ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === '$vuetify.display.smAndDown'
)
if (!breakpointWatcher) throw new Error('Header search breakpoint watcher was not found')
const compiled = ts.transpileModule(
  `const methods = ({${declarations.map(node => node.getText(sourceFile)).join(',')}}); const watchers = ({${breakpointWatcher.getText(sourceFile)}})`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }
).outputText

type HeaderState = {
  search: string
  searchMode: 'search' | 'ask'
  searchIsFocused: boolean
  searchIsShown: boolean
  searchIsComposing: boolean
  searchFocusGeneration: number
  hideSearch: boolean
  dense: boolean
  canEnterAgent: boolean
  onlineActionReady: boolean
  readingChromeHidden: boolean
  beforeSearchExit?: () => boolean
  canQuickCreate: boolean
  headerActionGeneration: number
  notificationOwnerId: number
  readerPageActions: { page: { path: string; locale: string } } | null
  locales: { code: string }[]
  newPageModal: boolean
  newPageSeed: { path: string; locale: string }
  $i18n: { resolvedLanguage: string; language: string }
  pageActionsAreOpen: boolean
  mobilePageActionsAreOpen: boolean
  pageActionsPage: unknown
  mobilePageActionsPage: unknown
  pageActionsFocusFrame: number | null
  $vuetify: { display: { smAndDown: boolean; mdAndUp: boolean } }
  $refs: Record<string, unknown>
  $nextTick: () => Promise<void>
  searchFocus: () => void
  searchClose: () => Promise<boolean> | void
  searchToggle: () => Promise<boolean> | void
  openAgent: () => Promise<void>
  openSearchQuickCreate: () => boolean
  finishSearchQuickCreate: () => void
  focusSearchField: () => Promise<void>
  handleSearchFocusCommand: () => void
  handleSearchShortcut: (event: KeyboardEvent) => Promise<boolean> | void
  searchEnter: (event: KeyboardEvent) => void
  searchMove: (direction: 'up' | 'down', event: KeyboardEvent) => void
  onSearchBreakpoint: (small: boolean) => void
}

const fixture = (mobile = false) => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="toggle">Search</button><button id="agent">Agent</button><input id="desktop"><input id="mobile"></body></html>',
    {
      pretendToBeVisual: true
    }
  )
  const document = dom.window.document
  const entered: string[] = []
  const moved: string[] = []
  const exited: boolean[] = []
  const methods = new Function(
    'document',
    'HTMLElement',
    'emitSearchEnter',
    'emitSearchMove',
    'emitSearchExit',
    'requestSearchAgentExit',
    'siteConfig',
    `${compiled}\nreturn {...methods, onSearchBreakpoint: watchers['$vuetify.display.smAndDown'].handler}`
  )(
    document,
    dom.window.HTMLElement,
    () => entered.push(state.searchMode),
    (direction: string) => moved.push(direction),
    (restoreFocus: boolean) => exited.push(restoreFocus),
    requestSearchAgentExit,
    { lang: 'en' }
  )
  const state: HeaderState = {
    ...methods,
    search: 'pizza',
    searchMode: 'search',
    searchIsFocused: true,
    searchIsShown: !mobile,
    searchIsComposing: false,
    searchFocusGeneration: 0,
    hideSearch: false,
    dense: false,
    canEnterAgent: true,
    onlineActionReady: true,
    readingChromeHidden: false,
    canQuickCreate: true,
    headerActionGeneration: 1,
    notificationOwnerId: 42,
    readerPageActions: { page: { path: 'guide/current', locale: 'en' } },
    locales: [{ code: 'en' }],
    newPageModal: false,
    newPageSeed: { path: 'new-page', locale: 'en' },
    $i18n: { resolvedLanguage: 'en', language: 'en' },
    pageActionsAreOpen: false,
    mobilePageActionsAreOpen: false,
    pageActionsPage: null,
    mobilePageActionsPage: null,
    pageActionsFocusFrame: null,
    $vuetify: { display: { smAndDown: mobile, mdAndUp: !mobile } },
    $refs: {
      searchField: { $el: document.body, focus: () => document.getElementById('desktop')!.focus() },
      searchFieldMobile: { focus: () => document.getElementById('mobile')!.focus() },
      searchToggle: { $el: document.getElementById('toggle') },
      agentOpener: { $el: document.getElementById('agent') }
    },
    $nextTick: async () => {}
  }
  const key = (key: string, options: KeyboardEventInit = {}) =>
    new dom.window.KeyboardEvent('keydown', { key, cancelable: true, ...options }) as unknown as KeyboardEvent
  return { state, entered, moved, exited, document, key }
}

describe('header search keyboard entry', () => {
  it('establishes the persistent direct Agent opener before moving into the mobile input', async () => {
    const { state, document } = fixture(true)
    const focused: string[] = []
    document.addEventListener('focusin', event => focused.push((event.target as HTMLElement).id))
    await state.openAgent()
    await state.$nextTick()
    expect(state.searchMode).toBe('ask')
    expect(state.searchIsFocused).toBe(true)
    expect(focused).toEqual(['agent', 'mobile'])
    expect(document.activeElement?.id).toBe('mobile')
  })

  it('preserves guarded drafts and abandons Agent entry when connection authority changes during Search teardown', async () => {
    const { state, document } = fixture(true)
    state.beforeSearchExit = () => false
    await state.openAgent()
    expect(state.searchMode).toBe('search')
    expect(state.searchIsFocused).toBe(true)
    expect(state.search).toBe('pizza')
    expect(document.activeElement).toBe(document.body)
    state.beforeSearchExit = () => true
    const tick = Promise.withResolvers<void>()
    state.$nextTick = () => tick.promise
    const opening = state.openAgent()
    state.onlineActionReady = false
    tick.resolve()
    await opening
    expect(state.searchMode).toBe('search')
    expect(document.activeElement).toBe(document.body)
  })

  it('focuses an already open Agent without tearing down its draft owner', async () => {
    const { state, document, exited } = fixture(true)
    state.searchMode = 'ask'
    await state.openAgent()
    expect(state.searchMode).toBe('ask')
    expect(state.searchIsFocused).toBe(true)
    expect(state.search).toBe('pizza')
    expect(exited).toEqual([])
    expect(document.activeElement?.id).toBe('mobile')
  })

  it('toggles Agent open and closed without opening Search, including reopening after close', async () => {
    for (const mobile of [false, true]) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const { state, key } = fixture(mobile)
        state.searchIsFocused = false
        state.searchMode = 'ask'
        for (const open of [true, false, true]) {
          const event = key('a', { [modifier]: true, shiftKey: true })
          state.handleSearchShortcut(event)
          await state.$nextTick()
          expect(event.defaultPrevented).toBe(true)
          expect(state.searchIsFocused).toBe(open)
          if (open) expect(state.searchMode).toBe('ask')
        }
      }
    }
  })

  it('focuses the active desktop or mobile field with either platform shortcut and preserves the query', async () => {
    for (const mobile of [false, true]) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const { state, document, key } = fixture(mobile)
        state.searchIsFocused = false
        const currentMode = (): HeaderState['searchMode'] => state.searchMode
        state.searchMode = 'ask'
        const event = key('k', { [modifier]: true })
        state.handleSearchShortcut(event)
        await state.$nextTick()
        expect(event.defaultPrevented).toBe(true)
        expect(currentMode()).toBe('search')
        expect(state.searchIsFocused).toBe(true)
        expect(state.searchIsShown).toBe(true)
        expect(state.search).toBe('pizza')
        expect(document.activeElement?.id).toBe(mobile ? 'mobile' : 'desktop')
      }
    }
  })

  it('opens mobile search from its toggle', async () => {
    const { state, document } = fixture(true)
    state.searchIsFocused = false
    state.searchToggle()
    await state.$nextTick()
    expect(document.activeElement?.id).toBe('mobile')
    expect(state.searchIsShown).toBe(true)
  })

  it('transfers focus to the replacement breakpoint input without losing the query', async () => {
    for (const mobile of [true, false]) {
      const { state, document } = fixture(!mobile)
      const oldField = document.getElementById(mobile ? 'desktop' : 'mobile')!
      oldField.classList.add('nav-header-search-control')
      oldField.focus()
      state.$vuetify.display = { smAndDown: mobile, mdAndUp: !mobile }
      state.$nextTick = async () => {
        oldField.remove()
      }
      state.onSearchBreakpoint(mobile)
      await state.$nextTick()
      expect(document.activeElement?.id).toBe(mobile ? 'mobile' : 'desktop')
      expect(state.search).toBe('pizza')
      expect(state.searchIsFocused).toBe(true)
    }
  })

  it('does not steal focus from an open preview at a breakpoint', async () => {
    const { state, document } = fixture()
    const preview = document.createElement('button')
    preview.textContent = 'Close preview'
    document.body.append(preview)
    preview.focus()
    state.$vuetify.display = { smAndDown: true, mdAndUp: false }
    state.onSearchBreakpoint(true)
    await state.$nextTick()
    expect(document.activeElement).toBe(preview)
    expect(state.search).toBe('pizza')
  })

  it('does not refocus a field after Search closes during its pending render', async () => {
    const { state, document } = fixture(true)
    const { promise, resolve } = Promise.withResolvers<void>()
    state.$nextTick = () => promise
    const pending = state.focusSearchField()
    state.searchClose()
    resolve()
    await pending
    expect(document.activeElement).toBe(document.body)
    expect(state.searchIsFocused).toBe(false)
  })

  it('keeps the ordinary Search glossary guard synchronous when no Agent owns the exit', () => {
    const { state } = fixture()
    state.beforeSearchExit = () => false
    expect(state.searchClose()).toBeUndefined()
    expect(state.searchIsFocused).toBe(true)
    expect(state.search).toBe('pizza')
    state.beforeSearchExit = () => true
    expect(state.searchClose()).toBeUndefined()
    expect(state.searchIsFocused).toBe(false)
    expect(state.search).toBe('pizza')
  })
})

describe('header Agent exit ownership', () => {
  const invokeExit = (action: string, state: HeaderState, key: (name: string, options?: KeyboardEventInit) => KeyboardEvent) => {
    if (action === 'close') return state.searchClose()
    if (action === 'mobile toggle') return state.searchToggle()
    if (action === 'Search shortcut') return state.handleSearchShortcut(key('k', { ctrlKey: true }))
    return state.handleSearchShortcut(key('a', { metaKey: true, shiftKey: true }))
  }

  for (const action of ['close', 'mobile toggle', 'Search shortcut', 'Agent shortcut']) {
    it(`retains a dirty Agent when its owner refuses ${action}`, async () => {
      const { state, key, document, exited } = fixture(true)
      state.searchMode = 'ask'
      state.searchIsShown = true
      state.searchFocusGeneration = 8
      document.getElementById('agent')!.focus()
      const decision = Promise.withResolvers<boolean>()
      const intents: SearchAgentExitIntent[] = []
      const unregister = registerSearchAgentExit(intent => {
        intents.push(intent)
        return decision.promise
      })
      try {
        const pending = invokeExit(action, state, key)
        expect(pending).toBe(decision.promise)
        expect(state.searchMode).toBe('ask')
        expect(state.searchIsFocused).toBe(true)
        decision.resolve(false)
        await pending
        expect(intents).toEqual([action === 'Search shortcut' ? 'search' : 'close'])
        expect(state.searchMode).toBe('ask')
        expect(state.searchIsFocused).toBe(true)
        expect(state.searchIsShown).toBe(true)
        expect(state.search).toBe('pizza')
        expect(state.searchFocusGeneration).toBe(8)
        expect(document.activeElement?.id).toBe('agent')
        expect(exited).toEqual([])
      } finally {
        unregister()
      }
    })

    it(`leaves an accepted ${action} entirely to the Agent owner`, async () => {
      const { state, key, document, exited } = fixture(true)
      state.searchMode = 'ask'
      state.searchIsShown = true
      state.searchFocusGeneration = 8
      document.getElementById('agent')!.focus()
      let glossaryGuardCalls = 0
      state.beforeSearchExit = () => {
        glossaryGuardCalls += 1
        return false
      }
      const decision = Promise.withResolvers<boolean>()
      const transition = decision.promise.then(() => {
        state.searchMode = 'search'
        state.searchIsFocused = action === 'Search shortcut'
        state.search = 'owner-owned query'
        document.getElementById('toggle')!.focus()
        return true
      })
      const unregister = registerSearchAgentExit(() => transition)
      try {
        const pending = invokeExit(action, state, key)
        expect(pending).toBe(transition)
        expect(state.searchMode).toBe('ask')
        decision.resolve(true)
        await pending
        expect<'ask' | 'search'>(state.searchMode).toBe('search')
        expect(state.searchIsFocused).toBe(action === 'Search shortcut')
        expect(state.search).toBe('owner-owned query')
        expect(state.searchFocusGeneration).toBe(8)
        expect(glossaryGuardCalls).toBe(0)
        expect(document.activeElement?.id).toBe('toggle')
        expect(exited).toEqual([])
      } finally {
        unregister()
      }
    })
  }
})

describe('header quick-create Agent handoff', () => {
  it('opens ordinary Search quick-create synchronously while retaining its glossary guard', () => {
    const { state, exited } = fixture()
    state.beforeSearchExit = () => false
    expect(state.openSearchQuickCreate()).toBe(false)
    expect(state.newPageModal).toBe(false)
    expect(state.searchIsFocused).toBe(true)
    state.beforeSearchExit = () => true
    expect(state.openSearchQuickCreate()).toBe(true)
    expect(state.newPageModal).toBe(true)
    expect(state.newPageSeed).toEqual({ path: 'guide/new-page', locale: 'en' })
    expect(state.searchIsFocused).toBe(false)
    expect(exited).toEqual([false])
  })

  for (const accepted of [false, true]) {
    it(`${accepted ? 'opens quick-create after an accepted exit' : 'retains a dirty Agent after Stay without opening quick-create'}`, async () => {
      const { state, exited } = fixture()
      state.searchMode = 'ask'
      const decision = Promise.withResolvers<boolean>()
      const transition = decision.promise.then(allowed => {
        if (allowed) {
          state.searchMode = 'search'
          state.searchIsFocused = false
          state.search = 'owner-owned query'
        }
        return allowed
      })
      const unregister = registerSearchAgentExit(() => transition)
      try {
        expect(state.openSearchQuickCreate()).toBe(true)
        expect(state.newPageModal).toBe(false)
        expect(state.searchMode).toBe('ask')
        expect(state.searchIsFocused).toBe(true)
        decision.resolve(accepted)
        await transition
        expect(state.newPageModal).toBe(accepted)
        expect<'ask' | 'search'>(state.searchMode).toBe(accepted ? 'search' : 'ask')
        expect(state.searchIsFocused).toBe(!accepted)
        expect(state.search).toBe(accepted ? 'owner-owned query' : 'pizza')
        expect(state.searchFocusGeneration).toBe(0)
        expect(exited).toEqual([])
        if (accepted) expect(state.newPageSeed).toEqual({ path: 'guide/new-page', locale: 'en' })
      } finally {
        unregister()
      }
    })
  }

  const invalidations: [string, (state: HeaderState) => void][] = [
    [
      'page context',
      state => {
        state.headerActionGeneration += 1
      }
    ],
    [
      'actor',
      state => {
        state.notificationOwnerId += 1
      }
    ],
    [
      'capability',
      state => {
        state.canQuickCreate = false
      }
    ]
  ]
  for (const [reason, invalidate] of invalidations) {
    it(`abandons a pending quick-create when its ${reason} changes`, async () => {
      const { state, exited } = fixture()
      state.searchMode = 'ask'
      const decision = Promise.withResolvers<boolean>()
      const unregister = registerSearchAgentExit(() => decision.promise)
      try {
        expect(state.openSearchQuickCreate()).toBe(true)
        invalidate(state)
        decision.resolve(true)
        await decision.promise
        expect(state.newPageModal).toBe(false)
        expect(exited).toEqual([])
      } finally {
        unregister()
      }
    })
  }
})

describe('header search native keyboard protection', () => {
  it('leaves composing arrows, Enter and shortcuts untouched, including legacy IME keyCode', () => {
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      const { state, entered, moved, key } = fixture()
      for (const name of ['ArrowDown', 'ArrowUp', 'Enter', 'k']) {
        const event = key(name, { ...options, ...(name === 'k' ? { ctrlKey: true } : {}) })
        if (name.startsWith('Arrow')) state.searchMove(name === 'ArrowDown' ? 'down' : 'up', event)
        else if (name === 'Enter') state.searchEnter(event)
        else state.handleSearchShortcut(event)
        expect(event.defaultPrevented).toBe(false)
      }
      expect(entered).toEqual([])
      expect(moved).toEqual([])
      expect(state.searchIsFocused).toBe(true)
      expect(state.search).toBe('pizza')
    }
    const { state, key, entered, moved } = fixture()
    state.searchIsComposing = true
    state.searchEnter(key('Enter'))
    state.searchMove('down', key('ArrowDown'))
    expect(entered).toEqual([])
    expect(moved).toEqual([])
    expect(state.searchIsFocused).toBe(true)
  })

  it('selects on plain Enter while leaving Alt/Shift Enter native', () => {
    const { state, entered, key } = fixture()
    for (const modifier of ['altKey', 'shiftKey']) {
      const event = key('Enter', { [modifier]: true })
      state.searchEnter(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(entered).toEqual([])
    expect(state.searchMode).toBe('search')
    const enter = key('Enter')
    state.searchEnter(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(entered).toEqual(['search'])
  })

  it('submits Ctrl/Meta Enter to Agent only when Agent is available, never falling through to result selection', () => {
    for (const canEnterAgent of [true, false]) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const { state, entered, key } = fixture()
        state.canEnterAgent = canEnterAgent
        const event = key('Enter', { [modifier]: true })
        state.searchEnter(event)
        expect(event.defaultPrevented).toBe(canEnterAgent)
        expect(state.searchMode).toBe(canEnterAgent ? 'ask' : 'search')
        expect(entered).toEqual(canEnterAgent ? ['ask'] : [])
      }
    }
  })

  it('only consumes plain arrows for an active searchable query, not empty input or Agent drafts', () => {
    const { state, moved, key } = fixture()
    for (const search of ['', 'x', '  ']) {
      state.search = search
      const event = key('ArrowDown')
      state.searchMove('down', event)
      expect(event.defaultPrevented).toBe(false)
    }
    state.search = 'pizza'
    state.searchMode = 'ask'
    state.searchMove('down', key('ArrowDown'))
    state.searchMode = 'search'
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      const event = key('ArrowUp', { [modifier]: true })
      state.searchMove('up', event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(moved).toEqual([])
    const down = key('ArrowDown')
    state.searchMove('down', down)
    const up = key('ArrowUp')
    state.searchMove('up', up)
    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    expect(moved).toEqual(['down', 'up'])
  })
})
