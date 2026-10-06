import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  currentCompletions,
  insertBracket,
  insertCompletionText,
  pickedCompletion,
  setSelectedCompletion,
  startCompletion
} from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { parse } from '@vue/compiler-sfc'
import * as ts from 'typescript'
import { afterEach, beforeEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { searchPages, type PageSearchResult } from '../../helpers/pages-api.ts'
import { TextEditor } from './common/text-editor.ts'

const filename = join(process.cwd(), 'client/components/editor/editor-markdown.vue')
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
if (!descriptor.script) throw new Error('Markdown editor has no script')
const script = ts.createSourceFile(filename, descriptor.script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

// The completion is local to mounted(), so execute its production initializer and
// its actual extension registration. This is an executable seam, not a source
// assertion or a second implementation of route construction/replacement.
const initializers = new Map<string, string>()
const visit = (node: ts.Node): void => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    ['completePageLink', 'extensions', 'markdownEditorInputTheme'].includes(node.name.text)
  ) {
    initializers.set(node.name.text, node.initializer.getText(script))
  }
  ts.forEachChild(node, visit)
}
visit(script)
const initializer = (name: string): string => {
  const expression = initializers.get(name)
  if (!expression) throw new Error(`Markdown completion harness cannot locate ${name}`)
  return expression
}
// Preserve mounted()'s lexical component `this` while transpiling the arrow.
// Transpiling it at module scope can otherwise erase that binding.
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  [
    'function createProductionExtensions() {',
    `const markdownEditorInputTheme = ${initializer('markdownEditorInputTheme')};`,
    `const completePageLink = ${initializer('completePageLink')};`,
    `const extensions = ${initializer('extensions')};`,
    'return extensions;',
    '}'
  ].join('\n')
)
const productionExtensions = new Function(
  'searchPages',
  'siteLangs',
  'window',
  'EditorView',
  'autocompletion',
  'keymap',
  'insertCompletionText',
  'pickedCompletion',
  `${executable}\nreturn createProductionExtensions.call(this)`
) as (
  this: { locale: string },
  search: typeof searchPages,
  languages: string[],
  window: Window,
  view: typeof EditorView,
  completion: typeof autocompletion,
  keys: typeof keymap,
  insert: typeof insertCompletionText,
  picked: typeof pickedCompletion
) => Extension[]

const editors: TextEditor[] = []
const rangePrototype = browserWindow.document.createRange().constructor.prototype
const originalRangeRects = Object.getOwnPropertyDescriptor(rangePrototype, 'getClientRects')
const originalRangeBounds = Object.getOwnPropertyDescriptor(rangePrototype, 'getBoundingClientRect')
beforeEach(() => {
  // JSDOM has no layout. Supply only geometry needed by CodeMirror's real
  // selection/tooltip measurement, leaving editing and completion untouched.
  const bounds = new browserWindow.DOMRect(0, 0, 100, 20)
  Object.defineProperty(rangePrototype, 'getClientRects', {
    configurable: true,
    value: () => [bounds] as unknown as DOMRectList
  })
  Object.defineProperty(rangePrototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => bounds
  })
})
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  if (originalRangeRects) Object.defineProperty(rangePrototype, 'getClientRects', originalRangeRects)
  else Reflect.deleteProperty(rangePrototype, 'getClientRects')
  if (originalRangeBounds) Object.defineProperty(rangePrototype, 'getBoundingClientRect', originalRangeBounds)
  else Reflect.deleteProperty(rangePrototype, 'getBoundingClientRect')
  vi.restoreAllMocks()
  resetBody()
})

const page = (id: number, visibility: 'public' | 'private', path = 'alpha'): PageSearchResult['results'][number] => ({
  id,
  visibility,
  path,
  locale: 'en',
  title: visibility === 'private' ? 'Alpha private' : 'Alpha public',
  description: '',
  tags: [],
  score: 1,
  matchedFields: ['title']
})

const createEditor = (results: PageSearchResult['results'], namespaced = true, value = '[Alpha](') => {
  // Only the HTTP boundary is supplied: production searchPages still validates
  // the response and production completion code builds and applies every link.
  vi.spyOn(browserWindow, 'fetch').mockImplementation(async () =>
    Response.json({
      results,
      suggestions: [],
      totalHits: results.length
    })
  )
  const parent = document.body.appendChild(document.createElement('div'))
  const editor = new TextEditor({
    parent,
    value,
    dark: false,
    ariaLabel: 'Markdown source',
    language: markdown({ base: markdownLanguage }),
    extensions: [
      ...productionExtensions.call(
        { locale: 'en' },
        searchPages,
        namespaced ? ['en'] : [],
        browserWindow,
        EditorView,
        autocompletion,
        keymap,
        insertCompletionText,
        pickedCompletion
      ),
      // Remove only the UI's accidental-keypress delay, not its completion source.
      autocompletion({ interactionDelay: 0 })
    ]
  })
  editors.push(editor)
  const view = EditorView.findFromDOM(parent.querySelector<HTMLElement>('.cm-editor')!)!
  view.dispatch({ selection: { anchor: value.length } })
  editor.focus()
  return { editor, view }
}

const openCompletions = async (view: EditorView, count: number) => {
  expect(startCompletion(view)).toBe(true)
  await vi.waitFor(() => {
    expect(completionStatus(view.state)).toBe('active')
    expect(currentCompletions(view.state)).toHaveLength(count)
  })
}
const acceptNamedCompletion = (view: EditorView, title: string) => {
  const index = currentCompletions(view.state).findIndex(option => option.label.endsWith(` - ${title}`))
  expect(index).toBeGreaterThanOrEqual(0)
  view.dispatch({ effects: setSelectedCompletion(index) })
  expect(acceptCompletion(view)).toBe(true)
}

describe('Markdown search link completion', () => {
  for (const visibility of ['public', 'private'] as const) {
    test(`keeps the authorized ${visibility} route distinct for matching locale and path`, async () => {
      const { editor, view } = createEditor([page(1, 'public'), page(2, 'private')])
      await openCompletions(view, 2)
      acceptNamedCompletion(view, visibility === 'private' ? 'Alpha private' : 'Alpha public')
      expect(editor.getValue()).toBe(visibility === 'private' ? '[Alpha](/_private/en/alpha)' : '[Alpha](/en/alpha)')
    })
  }

  test('retains the private namespace when locale namespaces are disabled', async () => {
    const { editor, view } = createEditor([page(2, 'private')], false)
    await openCompletions(view, 1)
    acceptNamedCompletion(view, 'Alpha private')
    expect(editor.getValue()).toBe('[Alpha](/_private/alpha)')
  })

  test('accepts a completion after ordinary bracket autoclosing without doubling the closer', async () => {
    const { editor, view } = createEditor([page(1, 'public')], true, '[Alpha]')
    const typedOpener = insertBracket(view.state, '(')
    expect(typedOpener).not.toBeNull()
    view.dispatch(typedOpener!)
    expect(editor.getValue()).toBe('[Alpha]()')
    expect(view.state.selection.main.head).toBe('[Alpha]('.length)
    await openCompletions(view, 1)
    acceptNamedCompletion(view, 'Alpha public')
    expect(editor.getValue()).toBe('[Alpha](/en/alpha)')
  })

  test('supplies exactly one closer for a pasted unfinished link', async () => {
    const { editor, view } = createEditor([page(1, 'public')], true, '')
    view.dispatch(view.state.replaceSelection('[Alpha]('), { userEvent: 'input.paste' })
    await openCompletions(view, 1)
    acceptNamedCompletion(view, 'Alpha public')
    expect(editor.getValue()).toBe('[Alpha](/en/alpha)')
  })

  for (const primaryClosed of [true, false]) {
    test(`completes every cursor with mixed closers when the primary closer is ${primaryClosed ? 'present' : 'absent'}`, async () => {
      const first = primaryClosed ? '[Alpha]()X' : '[Alpha](X'
      const second = primaryClosed ? '[Alpha](X' : '[Alpha]()X'
      const { editor, view } = createEditor([page(1, 'public')], true, `${first}\n${second}`)
      view.dispatch({
        selection: EditorSelection.create([EditorSelection.cursor('[Alpha]('.length), EditorSelection.cursor(first.length + 1 + '[Alpha]('.length)], 0)
      })
      await openCompletions(view, 1)
      acceptNamedCompletion(view, 'Alpha public')
      const line = '[Alpha](/en/alpha)X'
      expect(editor.getValue()).toBe(`${line}\n${line}`)
      expect(view.state.selection.ranges.map(range => range.head)).toEqual([line.length - 1, line.length * 2])
    })
  }

  test('encodes canonical path segments without turning route separators into data', async () => {
    const { editor, view } = createEditor([page(1, 'public', 'guides/café 100%')])
    await openCompletions(view, 1)
    acceptNamedCompletion(view, 'Alpha public')
    expect(editor.getValue()).toBe('[Alpha](/en/guides/caf%C3%A9%20100%25)')
  })
})
