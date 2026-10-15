import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import { advanceMarkdownCodeFenceState, type MarkdownCodeFenceState } from '../../shared/markdown-code-fence'
import { isAsciiDocLiteralPosition } from './editor-source-context'
import type { SourceImageMode } from './editor-image-source'

type Cell = { from: number; to: number; start?: number; end?: number }
type Table = { cells: Cell[]; end: number; columns: number }

const MAX_AUTHORED_TABLE_COLUMNS = 100
const MAX_AUTHORED_TABLE_ROW_LENGTH = 4096

function pipeCells(line: string, offset: number, markdown: boolean): Cell[] {
  const separators: number[] = []
  let ticks = 0
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\') {
      index++
      continue
    }
    if (markdown && line[index] === '`') {
      let end = index + 1
      while (line[end] === '`') end++
      const count = end - index
      if (ticks === count) ticks = 0
      else if (ticks === 0) ticks = count
      index = end - 1
    } else if (line[index] === '|' && ticks === 0) separators.push(index)
  }
  if (!separators.length) return []
  const bounds = [...separators]
  if (line.slice(0, separators[0]).trim()) bounds.unshift(-1)
  if (line.slice(separators[separators.length - 1] + 1).trim()) bounds.push(line.length)
  const cells: Cell[] = []
  for (let index = 0; index < bounds.length - 1; index++) {
    let from = bounds[index] + 1
    let to = bounds[index + 1]
    while (from < to && /\s/.test(line[from])) from++
    while (to > from && /\s/.test(line[to - 1])) to--
    if (from === to) from = to = bounds[index] + 1
    cells.push({ from: offset + from, to: offset + to, start: offset + bounds[index] + 1, end: offset + bounds[index + 1] })
  }
  return cells
}

function markdownTable(state: EditorState, position: number): Table | null {
  const current = state.doc.lineAt(position)
  let fence: MarkdownCodeFenceState | null = null
  for (let number = 1; number < current.number; number++) fence = advanceMarkdownCodeFenceState(state.doc.line(number).text, fence)
  if (fence) return null
  let start = current.number
  let end = current.number
  while (start > 1 && pipeCells(state.doc.line(start - 1).text, 0, true).length) start--
  while (end < state.doc.lines && pipeCells(state.doc.line(end + 1).text, 0, true).length) end++
  if (end - start < 1) return null
  const header = pipeCells(state.doc.line(start).text, state.doc.line(start).from, true)
  const separator = state.doc.line(start + 1)
  const separatorCells = pipeCells(separator.text, separator.from, true)
  if (header.length < 1 || separatorCells.length !== header.length || !separatorCells.every(cell => /^:?-{3,}:?$/.test(state.sliceDoc(cell.from, cell.to))))
    return null
  if (current.number === start + 1) return null
  const cells = [...header]
  for (let number = start + 2; number <= end; number++) {
    const line = state.doc.line(number)
    const row = pipeCells(line.text, line.from, true)
    if (row.length !== header.length) return null
    cells.push(...row)
  }
  return { cells, end: state.doc.line(end).to, columns: header.length }
}

function asciiDocTable(state: EditorState, position: number): Table | null {
  const source = state.doc.toString()
  if (isAsciiDocLiteralPosition(source, position)) return null
  const current = state.doc.lineAt(position)
  let start = 0
  let literal = ''
  for (let number = 1; number <= current.number; number++) {
    const text = state.doc.line(number).text.trim()
    if (literal) {
      if (text === literal) literal = ''
      continue
    }
    if (/^(?:-{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(text)) {
      literal = text
      continue
    }
    if (text === '|===') start = start ? 0 : number
  }
  if (!start || start === current.number) return null
  let end = start + 1
  let closingLiteral = ''
  for (; end <= state.doc.lines; end++) {
    const text = state.doc.line(end).text.trim()
    if (closingLiteral) {
      if (text === closingLiteral) closingLiteral = ''
      continue
    }
    if (/^(?:-{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(text)) {
      closingLiteral = text
      continue
    }
    if (text === '|===') break
  }
  if (end > state.doc.lines || end <= current.number) return null
  const separators: Array<{ from: number; content: number }> = []
  let columns = 0
  let cellLiteral = ''
  for (let number = start + 1; number < end; number++) {
    const line = state.doc.line(number)
    const text = line.text.trim()
    if (cellLiteral) {
      if (text === cellLiteral) cellLiteral = ''
      continue
    }
    if (/^(?:-{4,}|\.{4,}|\+{4,}|\/{4,})$/.test(text)) {
      cellLiteral = text
      continue
    }
    let count = 0
    for (let index = 0; index < line.text.length; index++) {
      if (line.text[index] === '\\') {
        index++
        continue
      }
      if (line.text[index] !== '|') continue
      const spec = /(?:^|\s)((?:\d+(?:\.\d+)?[+*])?(?:[<^>](?:\.[<^>])?)?[aehdlmsv]?)$/.exec(line.text.slice(0, index))
      const prefix = spec?.[1] ?? ''
      separators.push({ from: line.from + index - prefix.length, content: line.from + index + 1 })
      count++
    }
    if (!columns && count) columns = count
  }
  const attributes = start > 1 ? state.doc.line(start - 1).text : ''
  const definition = /^\[.*\bcols=(?:"([^"]*)"|'([^']*)'|([^,\]\s]+))/.exec(attributes)
  if (definition) {
    const records = (definition[1] ?? definition[2] ?? definition[3]).replace(/ /g, '')
    if (!records) return null
    if (/^(?:0|[1-9]\d*)$/.test(records)) columns = Number(records)
    else {
      columns = 0
      for (const record of records.split(records.includes(',') ? ',' : ';')) {
        // Complete native ColumnSpecRx grammar; never interpret just a repetition prefix.
        const spec = /^(?:(\d+)\*)?([<^>](?:\.[<^>]?)?|(?:[<^>]?\.)?[<^>])?(\d+%?|~)?([a-z])?$/.exec(record)
        if (!spec) return null
        const count = spec[1] === undefined ? 1 : Number(spec[1])
        if (!Number.isSafeInteger(count) || count < 1 || count > MAX_AUTHORED_TABLE_COLUMNS - columns) return null
        columns += count
      }
    }
    if (!Number.isSafeInteger(columns) || columns < 1 || columns > MAX_AUTHORED_TABLE_COLUMNS) return null
  } else if (/^\[.*\bcols\s*=/.test(attributes)) return null
  const cells = separators.map((separator, index) => {
    let from = separator.content
    let to = separators[index + 1]?.from ?? state.doc.line(end).from
    while (from < to && /\s/.test(source[from])) from++
    while (to > from && /\s/.test(source[to - 1])) to--
    if (from === to) from = to = separator.content
    return { from, to, start: separator.content, end: separators[index + 1]?.from ?? state.doc.line(end).from }
  })
  return cells.length ? { cells, end: state.doc.line(end).from, columns } : null
}

function htmlTable(state: EditorState, position: number): Table | null {
  const source = state.doc.toString()
  // Tokenize tags, not rendered DOM: browser repair must not change canonical source offsets.
  type HtmlTable = { start: number; cells: Cell[]; columns: number; rowCells: number; bodyEnd: number | null }
  const stack: HtmlTable[] = []
  let active: HtmlTable | undefined
  let opaque = ''
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*?>/g)) {
    const raw = match[0]
    if (raw.startsWith('<!--')) continue
    const tag = /^<\s*(\/?)\s*([\w-]+)/.exec(raw)
    if (!tag) continue
    const name = tag[2].toLowerCase()
    const closing = tag[1] === '/'
    if (opaque) {
      if (closing && name === opaque) opaque = ''
      continue
    }
    if (!closing && (name === 'script' || name === 'style')) {
      opaque = name
      continue
    }
    const from = match.index
    if (name === 'table') {
      if (!closing) {
        active = { start: from, cells: [], columns: 0, rowCells: 0, bodyEnd: null }
        stack.push(active)
      } else {
        const table = stack.pop()
        if (table && table.start <= position && position <= from + raw.length && table.cells.some(cell => cell.from <= position && position <= cell.to)) {
          return { cells: table.cells, end: table.bodyEnd ?? from, columns: table.columns || table.rowCells || 1 }
        }
        active = stack[stack.length - 1]
      }
    } else if (active && (name === 'td' || name === 'th')) {
      if (!closing) {
        active.cells.push({ from: from + raw.length, to: from + raw.length })
        active.rowCells += Math.min(1000, Math.max(1, Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(raw)?.[1] ?? 1)))
      } else {
        const cell = active.cells[active.cells.length - 1]
        if (cell) cell.to = from
      }
    } else if (active && name === 'tr' && closing) {
      active.columns = Math.max(active.columns, active.rowCells)
      active.rowCells = 0
    } else if (active && name === 'tbody' && closing) active.bodyEnd = from
  }
  return null
}

/** Return null outside an actual supported table, including its syntax-only separator row. */
export function sourceTableNavigation(state: EditorState, mode: SourceImageMode, backwards: boolean): TransactionSpec | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null
  const selection = state.selection.main
  const table =
    mode === 'markdown' ? markdownTable(state, selection.head) : mode === 'asciidoc' ? asciiDocTable(state, selection.head) : htmlTable(state, selection.head)
  if (!table) return null
  const index = table.cells.findIndex(cell => (cell.start ?? cell.from) <= selection.from && (cell.end ?? cell.to) >= selection.to)
  if (index < 0) return null
  const next = table.cells[index + (backwards ? -1 : 1)]
  if (next) return { selection: EditorSelection.single(next.from, next.to), scrollIntoView: true, userEvent: 'select.table-cell' }
  if (backwards) return null
  if (!Number.isSafeInteger(table.columns) || table.columns < 1 || table.columns > MAX_AUTHORED_TABLE_COLUMNS) return null
  const rowLength = mode === 'markdown' ? 4 * table.columns + 2 : mode === 'asciidoc' ? 2 * table.columns + 1 : 9 * table.columns + 10
  if (rowLength > MAX_AUTHORED_TABLE_ROW_LENGTH) return null
  const row =
    mode === 'markdown'
      ? `\n| ${'  | '.repeat(table.columns).trimEnd()}`
      : mode === 'asciidoc'
        ? `${'| '.repeat(table.columns)}\n`
        : `<tr>${'<td></td>'.repeat(table.columns)}</tr>\n`
  const cursor = table.end + (mode === 'markdown' ? 2 : mode === 'asciidoc' ? 1 : 8)
  return { changes: { from: table.end, insert: row }, selection: EditorSelection.cursor(cursor), scrollIntoView: true, userEvent: 'input.table-row' }
}
