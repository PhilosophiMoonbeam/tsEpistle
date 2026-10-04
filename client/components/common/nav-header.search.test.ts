import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

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
  searchEscape: true,
  searchToggle: true,
  focusSearchField: true,
  handleSearchFocusCommand: true,
  handleSearchShortcut: true,
  searchEnter: true,
  searchMove: true
}
const declarations = methodsNode.properties.filter(node => ts.isMethodDeclaration(node) && selected[node.name.getText(sourceFile)])
if (declarations.length !== Object.keys(selected).length) throw new Error('A header search handler was not found')
const breakpointWatcher = watchNode?.properties.find(
  node => ts.isMethodDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === '$vuetify.display.smAndDown'
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
  $vuetify: { display: { smAndDown: boolean; mdAndUp: boolean } }
  $refs: Record<string, unknown>
  $nextTick: () => Promise<void>
  searchFocus: () => void
  searchClose: () => void
  searchEscape: (event?: KeyboardEvent) => Promise<void>
  searchToggle: () => void
  focusSearchField: () => Promise<void>
  handleSearchFocusCommand: () => void
  handleSearchShortcut: (event: KeyboardEvent) => void
  searchEnter: (event: KeyboardEvent) => void
  searchMove: (direction: 'up' | 'down', event: KeyboardEvent) => void
  onSearchBreakpoint: (small: boolean) => void
}

const fixture = (mobile = false) => {
  const dom = new JSDOM('<!doctype html><html><body><button id="toggle">Search</button><input id="desktop"><input id="mobile"></body></html>', {
    pretendToBeVisual: true
  })
  const document = dom.window.document
  const entered: string[] = []
  const moved: string[] = []
  const methods = new Function(
    'document',
    'HTMLElement',
    'emitSearchEnter',
    'emitSearchMove',
    `${compiled}\nreturn {...methods, onSearchBreakpoint: watchers['$vuetify.display.smAndDown']}`
  )(
    document,
    dom.window.HTMLElement,
    () => entered.push(state.searchMode),
    (direction: string) => moved.push(direction)
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
    $vuetify: { display: { smAndDown: mobile, mdAndUp: !mobile } },
    $refs: {
      searchField: { $el: document.body, focus: () => document.getElementById('desktop')!.focus() },
      searchFieldMobile: { focus: () => document.getElementById('mobile')!.focus() },
      searchToggle: { $el: document.getElementById('toggle') }
    },
    $nextTick: async () => {}
  }
  const key = (key: string, options: KeyboardEventInit = {}) =>
    new dom.window.KeyboardEvent('keydown', { key, cancelable: true, ...options }) as unknown as KeyboardEvent
  return { state, entered, moved, document, key }
}

describe('header search keyboard entry', () => {
  it('focuses the active desktop or mobile field with either platform shortcut and preserves the query', async () => {
    for (const mobile of [false, true]) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const { state, document, key } = fixture(mobile)
        state.searchIsFocused = false
        state.searchMode = 'ask'
        const event = key('k', { [modifier]: true })
        state.handleSearchShortcut(event)
        await state.$nextTick()
        expect(event.defaultPrevented).toBe(true)
        expect(state.searchMode).toBe('search')
        expect(state.searchIsFocused).toBe(true)
        expect(state.searchIsShown).toBe(true)
        expect(state.search).toBe('pizza')
        expect(document.activeElement?.id).toBe(mobile ? 'mobile' : 'desktop')
      }
    }
  })

  it('opens mobile search from its toggle and returns Escape focus to that stable toggle', async () => {
    const { state, document, key } = fixture(true)
    state.searchIsFocused = false
    state.searchToggle()
    await state.$nextTick()
    expect(document.activeElement?.id).toBe('mobile')
    expect(state.searchIsShown).toBe(true)
    await state.searchEscape(key('Escape'))
    expect(state.searchIsFocused).toBe(false)
    expect(state.search).toBe('')
    expect(document.activeElement?.id).toBe('toggle')
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
})

describe('header search native keyboard protection', () => {
  it('leaves composing arrows, Enter, Escape and shortcuts untouched, including legacy IME keyCode', async () => {
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      const { state, entered, moved, key } = fixture()
      for (const name of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'k']) {
        const event = key(name, { ...options, ...(name === 'k' ? { ctrlKey: true } : {}) })
        if (name.startsWith('Arrow')) state.searchMove(name === 'ArrowDown' ? 'down' : 'up', event)
        else if (name === 'Enter') state.searchEnter(event)
        else if (name === 'Escape') await state.searchEscape(event)
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
    await state.searchEscape(key('Escape'))
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
