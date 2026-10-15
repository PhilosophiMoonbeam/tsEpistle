import {
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  insertCompletionText,
  pickedCompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
import prismComponents from 'prismjs/components.json'
import { KROKI_DIAGRAM_TYPES, type ContentExtensionEnvelope, type ContentExtensionKey } from '../../shared/content-extensions'
import { advanceMarkdownCodeFenceState, type MarkdownCodeFenceState } from '../../shared/markdown-code-fence'
import { fetchContentExtensions } from './content-extensions-api'
import type { SourceImageMode } from './editor-image-source'
import { isAsciiDocLiteralPosition } from './editor-source-context'
import { sourceTableNavigation } from './editor-source-tables'
import { searchPages } from './pages-api'

// Completion hints are checked against the native discriminated schema; validation remains authoritative.
const parameters: { [Key in ContentExtensionKey]: readonly (keyof Extract<ContentExtensionEnvelope, { key: Key }>['props'])[] } = {
  qr: ['value', 'label', 'size', 'errorCorrection'],
  gallery: ['images', 'columns', 'fit', 'aspectRatio'],
  'links-grid': ['cards'],
  index: ['path', 'locale', 'depth', 'columns', 'showIcons', 'order', 'limit', 'emptyLabel'],
  tabs: ['tabs', 'active'],
  spoiler: ['label', 'hint', 'content'],
  infobox: ['title', 'image', 'imageAlt', 'caption', 'facts'],
  pdf: ['src', 'title', 'page', 'height'],
  media: ['kind', 'src', 'title', 'poster', 'caption'],
  youtube: ['videoId', 'title', 'start', 'controls'],
  diagram: ['source', 'caption', 'theme', 'align'],
  kroki: ['type', 'source', 'format', 'caption', 'align'],
  plantuml: ['source', 'format', 'caption', 'align'],
  map: ['latitude', 'longitude', 'zoom', 'height', 'label']
}
const nestedParameters: Record<string, readonly string[]> = {
  images: ['src', 'alt', 'caption'],
  cards: ['title', 'url', 'description', 'image', 'icon', 'tags'],
  tabs: ['label', 'content', 'headingLevel'],
  facts: ['label', 'value']
}
const enumValues: Record<string, readonly string[]> = {
  errorCorrection: ['L', 'M', 'Q', 'H'],
  fit: ['cover', 'contain'],
  aspectRatio: ['square', 'natural'],
  order: ['path', 'title', 'updated'],
  kind: ['audio', 'video'],
  theme: ['auto', 'default', 'dark', 'neutral', 'forest'],
  align: ['left', 'center'],
  format: ['svg', 'png'],
  type: KROKI_DIAGRAM_TYPES,
  icon: ['page', 'globe', 'tags', 'external-link']
}
const languageOptions: Completion[] = Object.entries(prismComponents.languages)
  .filter(([key]) => key !== 'meta')
  .map(([key, value]) => ({
    label: key,
    type: 'type',
    detail: typeof value === 'object' && 'title' in value ? String(value.title) : key
  }))

function fenceAt(state: EditorState, position: number): { from: number; info: string; opening: number } | null {
  let fence: MarkdownCodeFenceState | null = null
  let opening = 0
  let from = 0
  let info = ''
  const current = state.doc.lineAt(position)
  for (let number = 1; number <= current.number; number++) {
    const line = state.doc.line(number)
    const next = advanceMarkdownCodeFenceState(line.text, fence)
    if (!fence && next) {
      opening = line.from
      from = line.to + 1
      info = line.text.trimStart().slice(next.markerLength).trim()
    }
    fence = next
  }
  return fence ? { from, info, opening } : null
}

type JsonCursor = { from: number; prefix: string; key: boolean; field: string; path: string[]; rootKey: string; used: string[]; quoted: boolean }
/** Scan incomplete JSON without rewriting it or guessing from text inside string values. */
function jsonCursor(source: string): JsonCursor | null {
  const stack: Array<{ path: string[]; field: string; expect: 'key' | 'colon' | 'value' | 'comma'; array: boolean; used: string[] }> = []
  let rootKey = ''
  for (let index = 0; index <= source.length; index++) {
    const frame = stack[stack.length - 1]
    const character = source[index]
    if (index === source.length) {
      if (!frame) return null
      return { from: index, prefix: '', key: frame.expect === 'key', field: frame.field, path: frame.path, rootKey, used: frame.used, quoted: false }
    }
    if (/\s/.test(character)) continue
    if (character === '"') {
      const start = index++
      for (; index < source.length; index++) {
        if (source[index] === '\\') index++
        else if (source[index] === '"') break
      }
      if (index >= source.length)
        return frame
          ? {
              from: start + 1,
              prefix: source.slice(start + 1),
              key: frame.expect === 'key',
              field: frame.field,
              path: frame.path,
              rootKey,
              used: frame.used,
              quoted: true
            }
          : null
      let value: string
      try {
        value = JSON.parse(source.slice(start, index + 1)) as string
      } catch {
        return null
      }
      if (frame?.expect === 'key') {
        frame.field = value
        frame.used.push(value)
        frame.expect = 'colon'
      } else if (frame) {
        if (!frame.path.length && frame.field === 'key') rootKey = value
        frame.expect = 'comma'
      }
    } else if (character === '{' || character === '[') {
      const path = frame ? (frame.array ? frame.path : [...frame.path, frame.field]) : []
      if (frame) frame.expect = 'comma'
      stack.push({ path, field: '', expect: character === '{' ? 'key' : 'value', array: character === '[', used: [] })
    } else if (character === '}' || character === ']') stack.pop()
    else if (frame && character === ':') frame.expect = 'value'
    else if (frame && character === ',') {
      frame.expect = frame.array ? 'value' : 'key'
      frame.field = ''
    } else if (frame) {
      const start = index
      while (index < source.length && !/[\s,}\]]/.test(source[index])) index++
      if (index === source.length)
        return { from: start, prefix: source.slice(start), key: false, field: frame.field, path: frame.path, rootKey, used: frame.used, quoted: false }
      frame.expect = 'comma'
      index--
    }
  }
  return null
}

/** Native authorized page routes and mixed-closer multi-cursor insertion stay one completion source. */
export async function completeSourcePageLink(
  context: CompletionContext,
  locale: string,
  localizedPaths: boolean,
  active: () => boolean = () => true
): Promise<CompletionResult | null> {
  const prefix = context.matchBefore(/\[[^\]]+\]\($/)
  if (!prefix || context.state.readOnly || !active()) return null
  try {
    const response = await searchPages(window.fetch.bind(window), prefix.text.slice(1, -2), { locale })
    if (context.aborted || !active()) return null
    return {
      from: context.pos,
      options: response.results.map(result => {
        const href = `${result.visibility === 'private' ? '/_private' : ''}/${result.visibility === 'private' || localizedPaths ? `${encodeURIComponent(result.locale)}/` : ''}${result.path.split('/').map(encodeURIComponent).join('/')}`
        return {
          label: `${href} - ${result.title}`,
          apply: (view: EditorView, completion: Completion, from: number, to: number) => {
            if (!active() || view.state.readOnly || view.compositionStarted || !view.state.facet(EditorView.editable)) return
            const insertion = insertCompletionText(view.state, `${href})`, from, to)
            const insertions = view.state.changes(insertion.changes)
            const closers: Array<{ from: number; to: number }> = []
            insertions.iterChanges((_fromA, toA, _fromB, toB) => {
              if (view.state.sliceDoc(toA, toA + 1) === ')') closers.push({ from: toB, to: toB + 1 })
            }, true)
            view.dispatch({ ...insertion, changes: insertions, annotations: pickedCompletion.of(completion) }, { changes: closers, sequential: true })
          }
        }
      })
    }
  } catch {
    return null
  }
}

export async function completeSourceAuthoring(
  context: CompletionContext,
  mode: SourceImageMode,
  fetchImpl: typeof fetch = fetch,
  active: () => boolean = () => true
): Promise<CompletionResult | null> {
  if (context.state.readOnly || !active()) return null
  const line = context.state.doc.lineAt(context.pos)
  const prefix = line.text.slice(0, context.pos - line.from)
  if (mode === 'markdown') {
    const fence = fenceAt(context.state, context.pos)
    const opening = /^ {0,3}(?:`{3,}|~{3,})([^\s]*)$/.exec(prefix)
    if (opening && fence?.opening === line.from)
      return {
        from: context.pos - opening[1].length,
        options: [...languageOptions, { label: 'wiki-extension', type: 'type', detail: 'Enabled native content extensions' }],
        validFor: /^[\w-]*$/
      }
    const metadata = /^ {0,3}(?:`{3,}|~{3,})\S+(?:\s+[a-z][\w-]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+))*\s+([\w-]*)$/.exec(prefix)
    if (fence?.opening === line.from && metadata) {
      return {
        from: context.pos - metadata[1].length,
        options: [
          snippetCompletion(`title="\${Title}"`, { label: 'title', detail: 'Code block caption' }),
          snippetCompletion(`linesstart="\${1}"`, { label: 'linesstart', detail: 'First line number' }),
          snippetCompletion(`lineshighlight="\${1-3}"`, { label: 'lineshighlight', detail: 'Highlighted line ranges' })
        ]
      }
    }
    if (fence && fence.opening !== line.from) {
      if (fence.info !== 'wiki-extension') return null
      const json = jsonCursor(context.state.sliceDoc(fence.from, context.pos))
      if (!json) return null
      if (!json.rootKey) {
        let end = context.state.doc.length
        for (let number = line.number + 1; number <= context.state.doc.lines; number++) {
          const candidate = context.state.doc.line(number)
          if (/^ {0,3}(?:`{3,}|~{3,})\s*$/.test(candidate.text)) {
            end = candidate.from
            break
          }
        }
        try {
          const envelope: unknown = JSON.parse(context.state.sliceDoc(fence.from, end))
          if (envelope && typeof envelope === 'object' && typeof Reflect.get(envelope, 'key') === 'string')
            json.rootKey = Reflect.get(envelope, 'key') as string
        } catch {
          /* Incomplete source is handled by the prefix scanner. */
        }
      }
      let available
      try {
        available = (await fetchContentExtensions(fetchImpl)).extensions.filter(extension => extension.isEnabled && extension.compatible)
      } catch {
        return null
      }
      if (context.aborted || !active()) return null
      const key = available.find(extension => extension.key === json.rootKey)?.key
      const nested = Object.hasOwn(nestedParameters, json.path[json.path.length - 1] ?? '') ? nestedParameters[json.path[json.path.length - 1]] : []
      let values: readonly string[] = []
      if (json.key)
        values = !json.path.length
          ? ['key', 'version', 'props']
          : json.path.length === 1 && json.path[0] === 'props' && key
            ? parameters[key]
            : json.path[0] === 'props' && key
              ? nested
              : []
      else if (!json.path.length && json.field === 'key') values = available.map(extension => extension.key)
      else if (!json.path.length && json.field === 'version') values = ['1']
      else if (
        key &&
        json.path[0] === 'props' &&
        (json.path.length === 1 ? (parameters[key] as readonly string[]).includes(json.field) : nested.includes(json.field))
      )
        values = enumValues[json.field] ?? (json.field === 'showIcons' || json.field === 'controls' ? ['true', 'false'] : [])
      let to = context.pos
      if (json.quoted && context.state.sliceDoc(to, to + 1) === '"') to++
      if (json.key) {
        const tail = /^\s*:\s*/.exec(context.state.sliceDoc(to, line.to))
        if (tail) to += tail[0].length
      }
      const options = values
        .filter(value => (!json.key || !json.used.includes(value)) && value.toLowerCase().startsWith(json.prefix.toLowerCase()))
        .map(value => {
          const literal = !json.key && (json.field === 'showIcons' || json.field === 'controls' || json.field === 'version')
          return { label: value, type: json.key ? 'property' : 'enum', apply: `${literal ? value : JSON.stringify(value)}${json.key ? ': ' : ''}` }
        })
      return options.length ? { from: fence.from + json.from - (json.quoted ? 1 : 0), to, options, filter: false } : null
    }
    let node = syntaxTree(context.state).resolveInner(context.pos, -1)
    for (;;) {
      if (/^(?:InlineCode|CodeBlock|FencedCode|CommentBlock)$/.test(node.name)) return null
      if (!node.parent) break
      node = node.parent
    }
  }
  if (mode === 'asciidoc') {
    if (isAsciiDocLiteralPosition(context.state.doc.toString(), context.pos)) return null
    const match = /\bkbd:?$/.exec(prefix)
    return match
      ? {
          from: line.from + match.index,
          options: [snippetCompletion(`kbd:[\${Key}]`, { label: 'kbd', detail: 'Keyboard key macro (requires :experimental:)' })]
        }
      : null
  }
  if (mode === 'html') {
    let node = syntaxTree(context.state).resolveInner(context.pos, -1)
    for (;;) {
      if (/^(?:Script|StyleSheet|Comment|AttributeValue)$/.test(node.name)) return null
      if (!node.parent) break
      node = node.parent
    }
  }
  const tag = /<(?:k(?:b(?:d)?)?)?$/.exec(prefix)
  if (!tag) return null
  return { from: line.from + tag.index, options: [snippetCompletion(`<kbd>\${Key}</kbd>`, { label: '<kbd>', type: 'keyword', detail: 'Keyboard key' })] }
}

export function createSourceAuthoring(
  mode: SourceImageMode,
  canEdit: () => boolean,
  owner: () => string
): {
  extension: Extension
  complete: (context: CompletionContext) => Promise<CompletionResult | null>
  insertCodeBlock: () => boolean
  insertTable: () => boolean
  destroy: () => void
} {
  let view: EditorView | null = null
  const initialOwner = owner()
  let abort = new AbortController()
  const active = () =>
    !abort.signal.aborted && owner() === initialOwner && canEdit() && !view?.compositionStarted && (!view || view.state.facet(EditorView.editable))
  const insert = (kind: 'code' | 'table'): boolean => {
    if (!view || !active() || view.compositionStarted || view.state.readOnly || !view.state.facet(EditorView.editable)) return false
    const state = view.state
    const transaction = state.changeByRange(range => {
      const selected = state.sliceDoc(range.from, range.to)
      let content: string
      let cursor: number
      if (kind === 'code') {
        if (mode === 'markdown') {
          let length = 3
          for (const run of selected.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1)
          const fence = '`'.repeat(length)
          content = `${fence}\n${selected}\n${fence}`
          cursor = fence.length + 1
        } else if (mode === 'asciidoc') {
          let length = 4
          for (const run of selected.matchAll(/^-{4,}$/gm)) length = Math.max(length, run[0].length + 1)
          const fence = '-'.repeat(length)
          content = `[source]\n${fence}\n${selected}\n${fence}`
          cursor = '[source]\n'.length + fence.length + 1
        } else {
          content = `<pre><code>${selected.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`
          cursor = '<pre><code>'.length
        }
      } else {
        content =
          mode === 'markdown'
            ? '| Header | Header |\n| --- | --- |\n| Cell | Cell |'
            : mode === 'asciidoc'
              ? '[cols="1,1",options="header"]\n|===\n|Header |Header\n|Cell |Cell\n|==='
              : '<table>\n<thead><tr><th>Header</th><th>Header</th></tr></thead>\n<tbody><tr><td>Cell</td><td>Cell</td></tr></tbody>\n</table>'
        cursor = content.indexOf('Header')
      }
      const before = range.from > 0 && state.sliceDoc(range.from - 1, range.from) !== '\n' ? '\n' : ''
      const after = range.to < state.doc.length && state.sliceDoc(range.to, range.to + 1) !== '\n' ? '\n' : ''
      return {
        changes: { from: range.from, to: range.to, insert: before + content + after },
        range: EditorSelection.cursor(range.from + before.length + cursor)
      }
    })
    view.dispatch(transaction, { scrollIntoView: true, userEvent: `input.${kind}` })
    view.focus()
    return true
  }
  const navigate = (backwards: boolean): boolean => {
    if (
      !view ||
      !active() ||
      !view.hasFocus ||
      view.compositionStarted ||
      view.state.readOnly ||
      !view.state.facet(EditorView.editable) ||
      completionStatus(view.state) ||
      hasNextSnippetField(view.state) ||
      hasPrevSnippetField(view.state)
    )
      return false
    const transaction = sourceTableNavigation(view.state, mode, backwards)
    if (!transaction) return false
    view.dispatch(transaction)
    return true
  }
  const complete = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const result = await completeSourceAuthoring(context, mode, (input, init) => fetch(input, { ...init, signal: abort.signal }), active)
    if (!result || context.aborted || !active()) return null
    return {
      ...result,
      options: result.options.map(option => ({
        ...option,
        apply(editor: EditorView, completion: Completion, from: number, to: number) {
          if (!active() || editor.compositionStarted || editor.state.readOnly || !editor.state.facet(EditorView.editable)) return
          if (typeof option.apply === 'function') option.apply(editor, completion, from, to)
          else editor.dispatch({ ...insertCompletionText(editor.state, option.apply ?? option.label, from, to), annotations: pickedCompletion.of(completion) })
        }
      }))
    }
  }
  return {
    extension: [
      ViewPlugin.define(editor => {
        view = editor
        if (abort.signal.aborted) abort = new AbortController()
        return {
          destroy() {
            view = null
            abort.abort()
          }
        }
      }),
      EditorState.languageData.of(() => [{ autocomplete: complete }]),
      Prec.high(
        keymap.of([
          { key: 'Tab', run: () => navigate(false) },
          { key: 'Shift-Tab', run: () => navigate(true) }
        ])
      )
    ],
    complete,
    insertCodeBlock: () => insert('code'),
    insertTable: () => insert('table'),
    destroy() {
      view = null
      abort.abort()
    }
  }
}
