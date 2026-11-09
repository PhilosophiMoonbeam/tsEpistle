import {
  closeCompletion,
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
import { fetchPageLinkSuggestions, searchPages } from './pages-api'
import type { BrowserFetch } from './json-transport'

// Completion hints are checked against the native discriminated schema; validation remains authoritative.
type PropKey<Envelope> = Envelope extends { props: infer Props } ? keyof Props : never
const parameters: { [Key in ContentExtensionKey]: readonly PropKey<Extract<ContentExtensionEnvelope, { key: Key }>>[] } = {
  qr: ['value', 'label', 'size', 'errorCorrection'],
  gallery: ['images', 'columns', 'fit', 'aspectRatio'],
  'links-grid': ['cards'],
  index: ['path', 'locale', 'depth', 'columns', 'showIcons', 'showTags', 'showPageAccent', 'showUpdatedAt', 'order', 'limit', 'emptyLabel'],
  tabs: ['tabs', 'active'],
  spoiler: ['label', 'hint', 'content'],
  infobox: ['title', 'image', 'imageAlt', 'caption', 'facts'],
  pdf: ['src', 'title', 'page', 'height'],
  media: ['kind', 'src', 'title', 'poster', 'caption'],
  youtube: ['videoId', 'source', 'title', 'start', 'controls'],
  diagram: ['source', 'caption', 'theme', 'align'],
  kroki: ['type', 'source', 'format', 'caption', 'align'],
  plantuml: ['source', 'format', 'caption', 'align'],
  map: ['latitude', 'longitude', 'zoom', 'height', 'label']
}
const nestedParameters: Record<string, readonly string[]> = {
  images: ['src', 'alt', 'caption'],
  cards: ['title', 'url', 'description', 'image', 'icon', 'tags'],
  tabs: ['label', 'content', 'headingLevel'],
  source: ['kind', 'videoId', 'playlistId'],
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

type PageLinkRange = { from: number; to: number; title: string; prefix: string }

function pageLinkRange(state: EditorState, position: number): PageLinkRange | null {
  const line = state.doc.lineAt(position)
  const before = line.text.slice(0, position - line.from)
  const match = /(\[([^\][\n]+)\]\()(\/[^\s()<>"\\]*|)$/.exec(before)
  if (!match || match[3].startsWith('//')) return null
  const from = position - match[3].length
  const opening = from - match[1].length
  const tree = syntaxTree(state)
  let link = tree.resolveInner(opening, 1)
  while (link.name !== 'Link' && link.parent) link = link.parent
  // The native parser owns the opener, including image and escape boundaries.
  if (link.name !== 'Link' || link.from !== opening) return null
  let block = link
  for (let node = link; node; node = node.parent!) {
    if (/^(?:CodeBlock|FencedCode|CodeText|InlineCode|HTMLBlock|HTMLTag|CommentBlock|Comment|ProcessingInstructionBlock|ProcessingInstruction|Image|Autolink|LinkReference)$/.test(node.name)) return null
    if (node.type.is('LeafBlock')) block = node
  }
  // Unfinished literal delimiters have no native node yet. Scan only this
  // native Markdown block, ignoring delimiters already owned by parsed syntax.
  for (const token of state.sliceDoc(block.from, opening).matchAll(/`|<!--|<\?/g)) {
    let owned = false
    for (let node = tree.resolveInner(block.from + token.index!, 1); node; node = node.parent!) {
      if (/^(?:Escape|InlineCode|HTMLTag|Comment|ProcessingInstruction|Autolink|Link|Image)$/.test(node.name)) {
        owned = true
        break
      }
      if (node.from === block.from && node.to === block.to) break
    }
    if (!owned) return null
  }
  const suffix = /^[^\s()<>"\\]*/.exec(state.sliceDoc(position, line.to))![0]
  return { from, to: position + suffix.length, title: match[2], prefix: match[3] }
}

/** Both discovery modes share exact source ownership and a single undoable insertion. */
export async function completeSourcePageLink(
  context: CompletionContext,
  locale: string,
  localizedPaths: boolean,
  active: () => boolean = () => true,
  fetchImpl: BrowserFetch = fetch,
  signal?: AbortSignal
): Promise<CompletionResult | null> {
  const state = context.state
  const range = pageLinkRange(state, context.pos)
  const live = () => !context.aborted && !signal?.aborted && active() &&
    !state.readOnly && (!context.view || (context.view.state.doc === state.doc &&
      context.view.state.selection.eq(state.selection) && !context.view.state.readOnly &&
      !context.view.compositionStarted && context.view.state.facet(EditorView.editable)))
  if (!range || !state.selection.ranges.every(selection => selection.empty) || !live()) return null
  const abort = new AbortController()
  context.addEventListener('abort', () => abort.abort(), { onDocChange: true })
  const cancel = () => abort.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const request: BrowserFetch = (input, init) => fetchImpl(input, { ...init, signal: abort.signal })
    const items = range.prefix
      ? await fetchPageLinkSuggestions(request, { locale, pathPrefix: range.prefix, limit: 20, signal: abort.signal })
      : (await searchPages(request, range.title, { locale })).results.map(result => ({
        ...result,
        href: `${result.visibility === 'private' ? '/_private' : ''}/${result.visibility === 'private' || localizedPaths ? `${encodeURIComponent(result.locale)}/` : ''}${result.path.split('/').map(encodeURIComponent).join('/')}`
      }))
    if (!live()) return null
    return {
      from: range.from,
      to: range.to,
      filter: false,
      options: items.map(result => ({
        label: `${result.href} - ${result.title}`,
        apply(view: EditorView, completion: Completion) {
          if (!live() || view.state.doc !== state.doc || !view.state.selection.eq(state.selection) ||
            view.state.readOnly || view.compositionStarted || !view.state.facet(EditorView.editable)) return
          const ranges = view.state.selection.ranges.map(selection => pageLinkRange(view.state, selection.head))
          if (ranges.some(candidate => !candidate || candidate.prefix !== range.prefix || (!range.prefix && candidate.title !== range.title))) return
          const href = result.href.replace(/[()]/g, character => `\\${character}`)
          const transaction = view.state.changeByRange(selection => {
            const candidate = pageLinkRange(view.state, selection.head)!
            const to = candidate.to + (view.state.sliceDoc(candidate.to, candidate.to + 1) === ')' ? 1 : 0)
            return {
              changes: { from: candidate.from, to, insert: `${href})` },
              range: EditorSelection.cursor(candidate.from + href.length + 1)
            }
          })
          view.dispatch({ ...transaction, userEvent: 'input.complete', annotations: pickedCompletion.of(completion) })
        }
      }))
    }
  } catch {
    return null
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export function createSourcePageLinkCompletion(
  locale: () => string,
  localizedPaths: boolean,
  active: () => boolean,
  fetchImpl: BrowserFetch = fetch
) {
  let abort = new AbortController()
  let destroyed = false
  let view: EditorView | null = null
  const invalidate = () => { abort.abort(); abort = new AbortController() }
  return {
    invalidate() { invalidate(); if (view) closeCompletion(view) },
    complete: (context: CompletionContext) =>
      completeSourcePageLink(context, locale(), localizedPaths, () => !destroyed && active(), fetchImpl, abort.signal),
    extension: ViewPlugin.define(editor => {
      view = editor
      return {
        update(update) {
          if (update.docChanged || update.selectionSet || update.state.readOnly || !active()) invalidate()
        },
        destroy() { destroyed = true; view = null; abort.abort() }
      }
    }, { eventHandlers: { compositionstart(_event, editor) { invalidate(); closeCompletion(editor) } } })
  }
}

export async function completeSourceAuthoring(
  context: CompletionContext,
  mode: SourceImageMode,
  fetchImpl: BrowserFetch = fetch,
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
      else if (!json.path.length && json.field === 'version') values = key === 'youtube' ? ['1', '2'] : ['1']
      else if (
        key &&
        json.path[0] === 'props' &&
        (json.path.length === 1 ? (parameters[key] as readonly string[]).includes(json.field) : nested.includes(json.field))
      )
        values = key === 'youtube' && json.path[json.path.length - 1] === 'source' && json.field === 'kind'
          ? ['playlist', 'video-playlist']
          : enumValues[json.field] ?? (['showIcons', 'showTags', 'showPageAccent', 'showUpdatedAt', 'controls'].includes(json.field) ? ['true', 'false'] : [])
      let to = context.pos
      if (json.quoted && context.state.sliceDoc(to, to + 1) === '"') to++
      if (json.key) {
        const tail = /^\s*:\s*/.exec(context.state.sliceDoc(to, line.to))
        if (tail) to += tail[0].length
      }
      const options = values
        .filter(value => (!json.key || !json.used.includes(value)) && value.toLowerCase().startsWith(json.prefix.toLowerCase()))
        .map(value => {
          const literal = !json.key && ['showIcons', 'showTags', 'showPageAccent', 'showUpdatedAt', 'controls', 'version'].includes(json.field)
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
          // The optional colon belongs to the replacement, not the completion label.
          filter: false,
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

export interface SourceAuthoring {
  extension: Extension
  complete: (context: CompletionContext) => Promise<CompletionResult | null>
  insertCodeBlock: () => boolean
  insertTable: () => boolean
  insertExtension: (content: string) => boolean
  destroy: () => void
}

export function createSourceAuthoring(mode: SourceImageMode, canEdit: () => boolean, owner: () => string): SourceAuthoring {
  let view: EditorView | null = null
  const initialOwner = owner()
  let abort = new AbortController()
  const active = () =>
    !abort.signal.aborted && owner() === initialOwner && canEdit() && !view?.compositionStarted && (!view || view.state.facet(EditorView.editable))
  const insert = (kind: 'code' | 'table' | 'block', serialized = ''): boolean => {
    if (!view || !active() || view.compositionStarted || view.state.readOnly || !view.state.facet(EditorView.editable)) return false
    const state = view.state
    const transaction = state.changeByRange(range => {
      const selected = state.sliceDoc(range.from, range.to)
      let content: string
      let cursor: number
      if (kind === 'block') {
        content = serialized
        cursor = content.length
      } else if (kind === 'code') {
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
      const after = !content.endsWith('\n') && range.to < state.doc.length && state.sliceDoc(range.to, range.to + 1) !== '\n' ? '\n' : ''
      return {
        changes: { from: range.from, to: range.to, insert: before + content + after },
        range: EditorSelection.cursor(range.from + before.length + cursor + (kind === 'block' ? after.length : 0))
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
    insertExtension: content => insert('block', content),
    destroy() {
      view = null
      abort.abort()
    }
  }
}
