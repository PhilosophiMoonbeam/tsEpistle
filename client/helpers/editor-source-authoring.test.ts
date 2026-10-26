import { acceptCompletion, autocompletion, CompletionContext, completionStatus, currentCompletions, snippet, startCompletion } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../test/browser-dom.mts'
import { BUILTIN_CONTENT_EXTENSIONS } from '../../shared/content-extensions'
import { onEditorImageProperties, type EditorImagePropertiesRequest } from './editor-image-properties'
import { createSourceImageAuthoring } from './editor-source-images'
import { completeSourceAuthoring, createSourceAuthoring } from './editor-source-authoring'
import { sourceTableNavigation } from './editor-source-tables'

const views: EditorView[] = []
const unsubscribers: Array<() => void> = []
const rangePrototype = browserWindow.document.createRange().constructor.prototype
const originalRangeRects = Object.getOwnPropertyDescriptor(rangePrototype, 'getClientRects')
const originalRangeBounds = Object.getOwnPropertyDescriptor(rangePrototype, 'getBoundingClientRect')
beforeEach(() => {
  // Supply JSDOM's missing geometry only; completion filtering and application remain real.
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
  for (const view of views.splice(0)) view.destroy()
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  if (originalRangeRects) Object.defineProperty(rangePrototype, 'getClientRects', originalRangeRects)
  else Reflect.deleteProperty(rangePrototype, 'getClientRects')
  if (originalRangeBounds) Object.defineProperty(rangePrototype, 'getBoundingClientRect', originalRangeBounds)
  else Reflect.deleteProperty(rangePrototype, 'getBoundingClientRect')
  resetBody()
})

function completionContext(marked: string): CompletionContext {
  const position = marked.indexOf('CURSOR')
  const source = marked.replace('CURSOR', '')
  return new CompletionContext(EditorState.create({ doc: source, extensions: [markdown()] }), position, true)
}
const extensionsResponse: Parameters<typeof completeSourceAuthoring>[2] = async () =>
  Response.json({
    hostVersion: 1,
    extensions: BUILTIN_CONTENT_EXTENSIONS.map(extension => ({ ...extension, isEnabled: extension.key === 'qr', compatible: true, diagnostic: null }))
  })

describe('native source completion boundaries', () => {
  it('offers only enabled compatible extensions and preserves the surrounding JSON on apply', async () => {
    const context = completionContext('```wiki-extension\n{"key":"CURSOR","version":1,"props":{}}\n```')
    const result = await completeSourceAuthoring(context, 'markdown', extensionsResponse)
    expect(result?.options.map(option => option.label)).toEqual(['qr'])
    const state = context.state.update({ changes: { from: result!.from, to: result!.to ?? context.pos, insert: result!.options[0].apply as string } }).state
    expect(JSON.parse(state.doc.line(2).text)).toEqual({ key: 'qr', version: 1, props: {} })
  })

  it('completes schema parameters even when the envelope key follows props', async () => {
    const context = completionContext('```wiki-extension\n{"props":{"siCURSOR":64},"key":"qr","version":1}\n```')
    const result = await completeSourceAuthoring(context, 'markdown', extensionsResponse)
    expect(result?.options.map(option => option.label)).toEqual(['size'])
    const state = context.state.update({ changes: { from: result!.from, to: result!.to ?? context.pos, insert: result!.options[0].apply as string } }).state
    expect(JSON.parse(state.doc.line(2).text)).toEqual({ key: 'qr', version: 1, props: { size: 64 } })
  })

  it('offers native fence languages and metadata but never completes inside a quoted caption', async () => {
    const language = await completeSourceAuthoring(completionContext('```typCURSOR'), 'markdown', extensionsResponse)
    expect(language?.options.some(option => option.label === 'typescript')).toBe(true)
    const metadata = await completeSourceAuthoring(completionContext('```typescript title="kept" linesCURSOR'), 'markdown', extensionsResponse)
    expect(metadata?.options.map(option => option.label)).toContain('lineshighlight')
    expect(await completeSourceAuthoring(completionContext('```typescript title="incomplete caption CURSOR'), 'markdown', extensionsResponse)).toBeNull()
    expect(await completeSourceAuthoring(completionContext('```text\n<kbCURSOR\n```'), 'markdown', extensionsResponse)).toBeNull()
  })

  it('offers and applies the real AsciiDoc keyboard snippet for both supported prefixes', async () => {
    for (const prefix of ['kbd', 'kbd:']) {
      const source = `:experimental:\n\n${prefix}`
      const authoring = createSourceAuthoring(
        'asciidoc',
        () => true,
        () => 'owner'
      )
      const view = new EditorView({
        parent: document.body.appendChild(document.createElement('div')),
        doc: source,
        extensions: [authoring.extension, autocompletion({ interactionDelay: 0 })]
      })
      views.push(view)
      view.dispatch({ selection: { anchor: source.length } })
      view.focus()
      expect(startCompletion(view)).toBe(true)
      await vi.waitFor(() => {
        expect(completionStatus(view.state)).toBe('active')
        expect(currentCompletions(view.state).map(option => option.label)).toEqual(['kbd'])
      })
      expect(acceptCompletion(view)).toBe(true)
      expect(view.state.doc.toString()).toBe(':experimental:\n\nkbd:[Key]')
      const range = view.state.selection.main
      expect(view.state.sliceDoc(range.from, range.to)).toBe('Key')
    }
  })

  it('excludes the same AsciiDoc prefixes from real completion menus inside literal listings', async () => {
    for (const prefix of ['kbd', 'kbd:']) {
      const source = `[source]\n----\n${prefix}\n----`
      const authoring = createSourceAuthoring(
        'asciidoc',
        () => true,
        () => 'owner'
      )
      const view = new EditorView({
        parent: document.body.appendChild(document.createElement('div')),
        doc: source,
        extensions: [authoring.extension, autocompletion()]
      })
      views.push(view)
      view.dispatch({ selection: { anchor: source.lastIndexOf('\n') } })
      view.focus()
      expect(startCompletion(view)).toBe(true)
      expect(completionStatus(view.state)).toBe('pending')
      await vi.waitFor(() => expect(completionStatus(view.state)).toBeNull())
      expect(currentCompletions(view.state)).toEqual([])
      expect(view.state.doc.toString()).toBe(source)
    }
  })
})

describe('source image mapped compare-and-swap', () => {
  it('maps unrelated collaboration edits but refuses an overlapping edit and lost authority', () => {
    let request: EditorImagePropertiesRequest | null = null
    unsubscribers.push(
      onEditorImageProperties(value => {
        request = value
      })
    )
    let editable = true
    const authoring = createSourceImageAuthoring(
      'markdown',
      () => editable,
      () => 'same-owner'
    )
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      doc: '![a](/image.png)',
      extensions: [markdown(), authoring.extension]
    })
    views.push(view)
    view.dispatch({ selection: { anchor: 3 } })
    expect(authoring.open()).toBe(true)
    const first = request as unknown as EditorImagePropertiesRequest
    view.dispatch({ changes: { from: 0, insert: 'remote\n' } })
    expect(first.apply({ alt: 'changed' })).toBe(true)
    expect(view.state.doc.toString()).toBe('remote\n![changed](/image.png)')
    view.dispatch({ selection: { anchor: view.state.doc.length - 2 } })
    expect(authoring.open()).toBe(true)
    const second = request as unknown as EditorImagePropertiesRequest
    view.dispatch({ changes: { from: view.state.doc.length - 2, insert: 'remote' } })
    const competingSource = view.state.doc.toString()
    expect(second.apply({ width: '120' })).toBe(false)
    expect(second.signal.aborted).toBe(false)
    expect(view.state.doc.toString()).toBe(competingSource)
    editable = false
    expect(second.apply({ alt: 'forbidden' })).toBe(false)
    expect(authoring.insert({ path: '/new.png' })).toBe(false)
  })

  it('rejects stale owners, read-only views, multi-selection properties and source-like text in fenced code', () => {
    let owner = 'account-a'
    const authoring = createSourceImageAuthoring(
      'markdown',
      () => true,
      () => owner
    )
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      doc: '![a](/a)\n![b](/b)',
      extensions: [markdown(), authoring.extension, EditorState.allowMultipleSelections.of(true)]
    })
    views.push(view)
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(12)]) })
    expect(authoring.open()).toBe(false)
    view.dispatch({ selection: { anchor: 2 } })
    owner = 'account-b'
    expect(authoring.open()).toBe(false)
    expect(authoring.insert({ path: '/new.png' })).toBe(false)
    const codeAuthoring = createSourceImageAuthoring(
      'markdown',
      () => true,
      () => 'owner'
    )
    const code = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      doc: '```text\n![a](/a)\n```',
      extensions: [markdown(), codeAuthoring.extension]
    })
    views.push(code)
    code.dispatch({ selection: { anchor: 11 } })
    expect(codeAuthoring.open()).toBe(false)
    const readOnlyAuthoring = createSourceImageAuthoring(
      'html',
      () => true,
      () => 'owner'
    )
    const readOnly = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      doc: '<img src="/a">',
      extensions: [readOnlyAuthoring.extension, EditorState.readOnly.of(true)]
    })
    views.push(readOnly)
    expect(readOnlyAuthoring.open()).toBe(false)
    expect(readOnlyAuthoring.insert({ path: '/new.png' })).toBe(false)
  })
})

describe('real source insertion and table cell commands', () => {
  it('leaves snippet Tab priority and native focus traversal intact, including IME insertion guards', () => {
    const authoring = createSourceAuthoring(
      'markdown',
      () => true,
      () => 'owner'
    )
    const source = '| First | Second |\n| --- | --- |\n| value | last |'
    const view = new EditorView({ parent: document.body.appendChild(document.createElement('div')), doc: source, extensions: [authoring.extension] })
    views.push(view)
    const from = source.indexOf('value')
    snippet(`\${one} \${two}`)(view, { label: 'snippet' }, from, from + 'value'.length)
    view.focus()
    expect(runScopeHandlers(view, new browserWindow.KeyboardEvent('keydown', { key: 'Tab' }), 'editor')).toBe(true)
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('two')
    view.contentDOM.dispatchEvent(new browserWindow.CompositionEvent('compositionstart', { bubbles: true }))
    expect(authoring.insertTable()).toBe(false)
    expect(authoring.insertCodeBlock()).toBe(false)
    view.contentDOM.dispatchEvent(new browserWindow.CompositionEvent('compositionend', { bubbles: true }))
    const prose = createSourceAuthoring(
      'markdown',
      () => true,
      () => 'owner'
    )
    const outside = new EditorView({ parent: document.body.appendChild(document.createElement('div')), doc: 'ordinary prose', extensions: [prose.extension] })
    views.push(outside)
    outside.focus()
    expect(runScopeHandlers(outside, new browserWindow.KeyboardEvent('keydown', { key: 'Tab' }), 'editor')).toBe(false)
  })

  it('wraps multiple selections without allowing selected backtick fences to close the new block', () => {
    const authoring = createSourceAuthoring(
      'markdown',
      () => true,
      () => 'owner'
    )
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      doc: '```\nsecond',
      extensions: [authoring.extension, EditorState.allowMultipleSelections.of(true)]
    })
    views.push(view)
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 10)]) })
    expect(authoring.insertCodeBlock()).toBe(true)
    expect(view.state.doc.toString()).toBe('````\n```\n````\n```\nsecond\n```')
    expect(view.state.selection.ranges).toHaveLength(2)
  })

  it('navigates actual Markdown cells without confusing escaped pipes, separators or pipe prose', () => {
    const source = '| First | Second |\n| --- | --- |\n| a\\|b | last |'
    let state = EditorState.create({ doc: source, selection: { anchor: source.indexOf('a\\|b') } })
    state = state.update(sourceTableNavigation(state, 'markdown', false)!).state
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('last')
    const appended = sourceTableNavigation(state, 'markdown', false)!
    state = state.update(appended).state
    expect(state.doc.lines).toBe(4)
    expect(state.doc.toString()).toContain('| a\\|b | last |')
    expect(state.selection.main.empty).toBe(true)
    const empty = '| First | Second |\n| --- | --- |\n|   | last |'
    const whitespace = EditorState.create({ doc: empty, selection: { anchor: empty.lastIndexOf('\n') + 2 } })
    const moved = whitespace.update(sourceTableNavigation(whitespace, 'markdown', false)!).state
    expect(moved.sliceDoc(moved.selection.main.from, moved.selection.main.to)).toBe('last')
    const first = EditorState.create({ doc: source, selection: { anchor: source.indexOf('First') } })
    expect(sourceTableNavigation(first, 'markdown', true)).toBeNull()
    const separator = EditorState.create({ doc: source, selection: { anchor: source.indexOf('---') } })
    expect(sourceTableNavigation(separator, 'markdown', false)).toBeNull()
    expect(sourceTableNavigation(EditorState.create({ doc: 'ordinary | pipe prose', selection: { anchor: 3 } }), 'markdown', false)).toBeNull()
    const literal = `\`\`\`text\n${source}\n\`\`\``
    expect(sourceTableNavigation(EditorState.create({ doc: literal, selection: { anchor: literal.indexOf('First') } }), 'markdown', false)).toBeNull()
  })

  it('declines invalid or oversized AsciiDoc column specifications without authoring a row', () => {
    // Moderate invalid prefixes expose partial parsing without allocating a large regression payload.
    for (const columns of ['12*invalid', '0*', '2*1junk', '101*1']) {
      const source = `[cols="${columns}"]\n|===\n|Cell\n|===`
      const state = EditorState.create({ doc: source, selection: { anchor: source.indexOf('Cell') } })
      expect(sourceTableNavigation(state, 'asciidoc', false)).toBeNull()
      expect(state.doc.toString()).toBe(source)
    }
  })

  it('counts complete native AsciiDoc column forms while preserving document source', () => {
    for (const columns of ['2', '2*1', '<1,>1', '^1;1h', '1,']) {
      const source = `[cols="${columns}"]\n|===\n|Cell\n|===`
      const state = EditorState.create({ doc: source, selection: { anchor: source.indexOf('Cell') } })
      const transaction = sourceTableNavigation(state, 'asciidoc', false)
      expect(transaction).not.toBeNull()
      expect(state.update(transaction!).state.doc.toString()).toBe(`[cols="${columns}"]\n|===\n|Cell\n| | \n|===`)
    }
  })

  it('navigates AsciiDoc multiline cells and appends HTML rows inside tbody without changing opaque source', () => {
    const ascii = '[cols="1,1"]\n|===\n|first\ncontinued\n|last\n|==='
    let state = EditorState.create({ doc: ascii, selection: { anchor: ascii.indexOf('continued') } })
    state = state.update(sourceTableNavigation(state, 'asciidoc', false)!).state
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('last')
    state = state.update(sourceTableNavigation(state, 'asciidoc', false)!).state
    expect(state.doc.toString()).toBe('[cols="1,1"]\n|===\n|first\ncontinued\n|last\n| | \n|===')
    const html = '<table data-private="keep"><tbody><tr><td>first</td><td>last</td></tr></tbody></table>'
    let htmlState = EditorState.create({ doc: html, selection: { anchor: html.indexOf('last') } })
    htmlState = htmlState.update(sourceTableNavigation(htmlState, 'html', false)!).state
    expect(htmlState.doc.toString()).toBe('<table data-private="keep"><tbody><tr><td>first</td><td>last</td></tr><tr><td></td><td></td></tr>\n</tbody></table>')
    expect(htmlState.selection.main.head).toBe(htmlState.doc.toString().indexOf('<td></td>') + 4)
  })
})
