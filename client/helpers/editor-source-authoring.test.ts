import { acceptCompletion, autocompletion, completionKeymap, CompletionContext, completionStatus, currentCompletions, snippet, startCompletion } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../test/browser-dom.mts'
import { BUILTIN_CONTENT_EXTENSIONS, parseContentExtensionFence, serializeContentExtensionFence } from '../../shared/content-extensions'
import { onEditorImageProperties, type EditorImagePropertiesRequest } from './editor-image-properties'
import { createSourceImageAuthoring } from './editor-source-images'
import { completeSourceAuthoring, completeSourcePageLink, createSourceAuthoring, createSourcePageLinkCompletion } from './editor-source-authoring'
import { sourceTableNavigation } from './editor-source-tables'
import { fetchPageLinkSuggestions } from './pages-api'

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

  it.each([
    ['{"key":"index","version":1,"props":{"path":"guide","locale":"en","showUpdatedAt":truCURSOR}}', 'true', { key: 'index', props: { showUpdatedAt: true } }],
    ['{"key":"youtube","version":2,"props":{"source":{"kind":"plaCURSOR","playlistId":"PL_native_123"},"title":"Kept title"}}', 'playlist', { key: 'youtube', version: 2, props: { source: { kind: 'playlist', playlistId: 'PL_native_123' }, title: 'Kept title' } }]
  ])('accepts native date/playlist metadata by keyboard without quoting booleans or losing source (%s)', async (body, label, expected) => {
    const marked = `\`\`\`wiki-extension\n${body}\n\`\`\``
    const position = marked.indexOf('CURSOR')
    const request = async () => Response.json({
      hostVersion: 1,
      extensions: BUILTIN_CONTENT_EXTENSIONS.map(extension => ({ ...extension, isEnabled: true, compatible: true, diagnostic: null }))
    })
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      doc: marked.replace('CURSOR', ''),
      extensions: [
        markdown(),
        autocompletion({ interactionDelay: 0, override: [context => completeSourceAuthoring(context, 'markdown', request)] }),
        keymap.of(completionKeymap)
      ]
    })
    views.push(view)
    view.dispatch({ selection: { anchor: position } })
    view.focus()
    expect(startCompletion(view)).toBe(true)
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toEqual([label]))
    expect(runScopeHandlers(view, new browserWindow.KeyboardEvent('keydown', { key: 'Enter' }), 'editor')).toBe(true)
    const envelope = parseContentExtensionFence(view.state.doc.line(2).text)
    expect(envelope).toMatchObject(expected)
    const canonical = serializeContentExtensionFence(envelope)
    expect(parseContentExtensionFence(canonical.split('\n')[1]!)).toEqual(envelope)
  })

  it('offers explicit YouTube source version and nested identifier metadata', async () => {
    const request = async () => Response.json({
      hostVersion: 1,
      extensions: BUILTIN_CONTENT_EXTENSIONS.map(extension => ({ ...extension, isEnabled: true, compatible: true, diagnostic: null }))
    })
    for (const [body, labels] of [
      ['{"key":"youtube","version":CURSOR,"props":{}}', ['1', '2']],
      ['{"key":"youtube","version":2,"props":{"souCURSOR":{}}}', ['source']],
      ['{"key":"youtube","version":2,"props":{"source":{"playCURSOR":"PL_native_123"}}}', ['playlistId']]
    ] as const) {
      const result = await completeSourceAuthoring(completionContext(`\`\`\`wiki-extension\n${body}\n\`\`\``), 'markdown', request)
      expect(result?.options.map(option => option.label)).toEqual([...labels])
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

describe('root path page link completion ownership', () => {
  it('offers a real CodeMirror menu and closes it on authority retirement', async () => {
    let authorized = true
    const owner = createSourcePageLinkCompletion(() => 'fr', true, () => authorized, async () =>
      Response.json({ items: [{ id: 8, title: 'Guide', locale: 'fr', path: 'guide', visibility: 'public', href: '/fr/guide' }] }))
    const view = new EditorView({
      state: EditorState.create({
        doc: '[guide](/',
        selection: { anchor: 9 },
        extensions: [markdown(), owner.extension, autocompletion({ override: [owner.complete], interactionDelay: 0 })]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    expect(startCompletion(view)).toBe(true)
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toEqual(['/fr/guide - Guide']))
    authorized = false
    owner.invalidate()
    expect(currentCompletions(view.state)).toEqual([])
    expect(acceptCompletion(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('[guide](/')
  })
  it('retires an open root menu when composition is cancelled without changing the source', async () => {
    const source = '[guide](/'
    const owner = createSourcePageLinkCompletion(() => 'fr', true, () => true, async () =>
      Response.json({ items: [{ id: 8, title: 'Guide', locale: 'fr', path: 'guide', visibility: 'public', href: '/fr/guide' }] }))
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: { anchor: source.length },
        extensions: [markdown(), owner.extension, autocompletion({ override: [owner.complete], interactionDelay: 0 })]
      }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    expect(startCompletion(view)).toBe(true)
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toEqual(['/fr/guide - Guide']))
    const stale = currentCompletions(view.state)[0]
    const initialDoc = view.state.doc
    const initialSelection = view.state.selection
    expect(view.dom.querySelector('.cm-tooltip-autocomplete')).not.toBeNull()

    view.contentDOM.dispatchEvent(new browserWindow.CompositionEvent('compositionstart', { bubbles: true }))
    expect(currentCompletions(view.state)).toEqual([])
    expect(view.dom.querySelector('.cm-tooltip-autocomplete')).toBeNull()
    view.contentDOM.dispatchEvent(new browserWindow.CompositionEvent('compositionend', { bubbles: true, data: '' }))
    expect(view.compositionStarted).toBe(false)
    expect(view.state.doc).toBe(initialDoc)
    expect(view.state.selection.eq(initialSelection)).toBe(true)
    expect(currentCompletions(view.state)).toEqual([])
    expect(acceptCompletion(view)).toBe(false)
    ;(stale.apply as Function)(view, stale, source.length - 1, source.length)
    expect(view.state.doc.toString()).toBe(source)

    expect(startCompletion(view)).toBe(true)
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toEqual(['/fr/guide - Guide']))
    expect(acceptCompletion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('[guide](/fr/guide)')
  })
  const item = { id: 7, title: 'Résumé', locale: 'fr', path: 'équipe/été', visibility: 'private', href: '/_private/fr/%C3%A9quipe/%C3%A9t%C3%A9' }
  const response = async () => Response.json({ items: [item] })
  function editor(source: string, positions = [source.length]) {
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: EditorSelection.create(positions.map(position => EditorSelection.cursor(position))),
        extensions: [markdown(), history(), EditorState.allowMultipleSelections.of(true)]
      }),
      parent: document.body
    })
    views.push(view)
    return view
  }
  async function complete(view: EditorView, fetchImpl: Parameters<typeof completeSourcePageLink>[4] = response, active = () => true) {
    return completeSourcePageLink(new CompletionContext(view.state, view.state.selection.main.head, true, view), 'en', false, active, fetchImpl)
  }
  it('preserves raw root, locale, private namespace and encoded UTF8 prefixes on the wire', async () => {
    for (const prefix of ['/', '/fr/', '/_private/fr/équipe', '/_private/fr/%C3%A9quipe']) {
      const view = editor(`[label](${prefix}`)
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://wiki.test')
        expect(url.pathname).toBe('/_api/pages/link-suggestions')
        expect(url.searchParams.get('pathPrefix')).toBe(prefix)
        expect(url.searchParams.get('locale')).toBe('en')
        expect(url.searchParams.get('limit')).toBe('20')
        return response()
      })
      const result = await complete(view, fetchImpl)
      expect(result?.options[0].label).toContain(item.href)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })
  it('replaces the full suffix and mixed closers at multiple cursors in one undo step', async () => {
    const source = '[label](/old-suffix)\n[label](/old-suffix'
    const positions = [source.indexOf('/old') + 4, source.lastIndexOf('/old') + 4]
    const view = editor(source, positions)
    const result = await complete(view)
    expect(result).not.toBeNull()
    const option = result!.options[0]
    ;(option.apply as Function)(view, option, result!.from, result!.to)
    expect(view.state.doc.toString()).toBe(`[label](${item.href})\n[label](${item.href})`)
    expect(view.state.selection.ranges).toHaveLength(2)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(source)
  })
  it('retains title-first searchable discovery and canonical localized public routes', async () => {
    const view = editor('[Résumé](')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(url).toContain('/_api/pages/search?')
      return Response.json({ results: [{ id: '7', title: 'Résumé', description: '', locale: 'fr', path: 'équipe/été', visibility: 'public', tags: [], score: 1, matchedFields: ['title'], excerpt: null, copySource: null }], suggestions: [], totalHits: 1 })
    })
    const result = await completeSourcePageLink(new CompletionContext(view.state, view.state.doc.length, true, view), 'fr', true, () => true, fetchImpl)
    expect(result?.options[0].label).toContain('/fr/%C3%A9quipe/%C3%A9t%C3%A9')
  })
  for (const source of ['![label](/', '\\[label](/', '`[label](/', '`[label](/`', '```\n[label](/', '    [label](/', '<!-- [label](/', '[label](https://', '[label](../', '[label](relative', '[label](//host']) {
    it(`does not query images, escapes, code, fences, HTML or non-root destinations: ${JSON.stringify(source)}`, async () => {
      const view = editor(source)
      const fetchImpl = vi.fn(response)
      expect(await complete(view, fetchImpl)).toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  }
  for (const source of [
    '`unfinished\n[label](/',
    '``unfinished `\n[label](/',
    'text <!-- [label](/',
    'text <!-- unfinished\n[label](/',
    'text <?instruction [label](/',
    '> <!-- [label](/',
    '- <!-- [label](/',
    '~~~\n[label](/',
    '\t[label](/'
  ]) {
    it(`does not query an unfinished or nested literal context: ${JSON.stringify(source)}`, async () => {
      const fetchImpl = vi.fn(response)
      expect(await complete(editor(source), fetchImpl)).toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  }
  for (const marked of [
    'text <!-- [label](/| -->',
    'text <?instruction [label](/| ?>',
    'text <span title="[label](/|">',
    '`code\n[label](/|`',
    '![label](/|)',
    '\\[label](/|)'
  ]) {
    it(`does not query inside a complete native literal or escaped opener: ${JSON.stringify(marked)}`, async () => {
      const position = marked.indexOf('|')
      const fetchImpl = vi.fn(response)
      expect(await complete(editor(marked.replace('|', ''), [position]), fetchImpl)).toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  }
  for (const source of [
    String.raw`\\[label](/`,
    String.raw`\![label](/`,
    '\\` [label](/',
    '`closed` [label](/',
    '[earlier `literal](/old) [label](/',
    '[literal `title](/',
    'text <!-- closed --> [label](/',
    '<!-- closed -->\n\n[label](/',
    '`unfinished in another paragraph\n\n[label](/',
    '```\nclosed\n```\n[label](/',
    '> [label](/',
    '- [label](/'
  ]) {
    it(`admits genuine links without reinterpreting parsed or previous-block delimiters: ${JSON.stringify(source)}`, async () => {
      const fetchImpl = vi.fn(response)
      const result = await complete(editor(source), fetchImpl)
      expect(result?.options[0].label).toContain(item.href)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
  }
  it('discards delayed edits, selections and authority changes and never applies a stale option', async () => {
    for (const mutation of ['edit', 'selection', 'authority', 'readonly', 'ime']) {
      const view = editor('[label](/')
      const { promise, resolve } = Promise.withResolvers<Response>()
      let active = true
      const pending = complete(view, () => promise, () => active)
      if (mutation === 'edit') view.dispatch({ changes: { from: 0, insert: 'x' } })
      if (mutation === 'selection') view.dispatch({ selection: { anchor: 0 } })
      if (mutation === 'authority') active = false
      if (mutation === 'readonly') view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) })
      if (mutation === 'ime') Object.defineProperty(view, 'compositionStarted', { configurable: true, value: true })
      resolve(await response())
      expect(await pending).toBeNull()
    }
    const view = editor('[label](/')
    const result = await complete(view)
    view.dispatch({ changes: { from: 0, insert: 'manual ' } })
    const before = view.state.doc.toString()
    ;(result!.options[0].apply as Function)(view, result!.options[0], result!.from, result!.to)
    expect(view.state.doc.toString()).toBe(before)
  })
  it('aborts in-flight owned queries on transactions, composition and destruction', async () => {
    for (const action of ['edit', 'selection', 'ime', 'destroy']) {
      let requestSignal: AbortSignal | undefined
      const { promise, resolve } = Promise.withResolvers<Response>()
      const owner = createSourcePageLinkCompletion(() => 'en', false, () => true, async (_input, init) => {
        requestSignal = init?.signal as AbortSignal
        return promise
      })
      const view = new EditorView({ state: EditorState.create({ doc: '[label](/', selection: { anchor: 9 }, extensions: [markdown(), owner.extension] }), parent: document.body })
      const pending = owner.complete(new CompletionContext(view.state, 9, true, view))
      if (action === 'edit') view.dispatch({ changes: { from: 0, insert: 'x' } })
      if (action === 'selection') view.dispatch({ selection: { anchor: 0 } })
      if (action === 'ime') view.contentDOM.dispatchEvent(new browserWindow.CompositionEvent('compositionstart', { bubbles: true }))
      if (action === 'destroy') view.destroy()
      expect(requestSignal?.aborted).toBe(true)
      resolve(await response())
      expect(await pending).toBeNull()
      if (action !== 'destroy') view.destroy()
    }
  })
  it('rejects malformed or cross-origin suggestions and preserves manual editing after errors', async () => {
    for (const invalid of [{ ...item, id: '7' }, { ...item, href: '//evil.test/page' }, { ...item, href: '/fr/other' }, { ...item, visibility: 'hidden' }, { ...item, extra: true }]) {
      await expect(fetchPageLinkSuggestions(async () => Response.json({ items: [invalid] }), { locale: 'fr', pathPrefix: '/' })).rejects.toThrow()
    }
    const view = editor('[label](/')
    expect(await complete(view, async () => { throw new Error('offline') })).toBeNull()
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'manual)' } })
    expect(view.state.doc.toString()).toBe('[label](/manual)')
  })
})
