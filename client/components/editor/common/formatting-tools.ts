// Shared formatting tool definitions for the Markdown (CodeMirror) and visual
// (Tiptap) editors. Each editor maps a tool id to its own command, but label,
// icon, keyboard shortcut and group stay identical so switching editors does
// not change what a tool looks like or how it is announced.

export type FormattingToolId =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'highlight'
  | 'subscript'
  | 'superscript'
  | 'heading'
  | 'inlineCode'
  | 'keyboardKey'
  | 'link'
  | 'blockquote'
  | 'unorderedList'
  | 'orderedList'
  | 'taskList'
  | 'outdent'
  | 'indent'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'horizontalBar'
  | 'codeBlock'
  | 'table'
  | 'assets'
  | 'diagram'
  | 'contentExtension'
  | 'definitionList'
  | 'abbreviation'

export type FormattingToolGroup = 'history' | 'text' | 'structure' | 'insert'

export type FormattingTool = {
  readonly id: FormattingToolId
  /** i18n key, always in the editor namespace. */
  readonly labelKey: string
  readonly icon: string
  readonly group: FormattingToolGroup
  /** CodeMirror/Tiptap style shortcut, `Mod` is Ctrl or ⌘. */
  readonly shortcut?: string
}

const tool = (id: FormattingToolId, labelKey: string, icon: string, group: FormattingToolGroup, shortcut?: string): FormattingTool =>
  Object.freeze({ id, labelKey: `editor:markup.${labelKey}`, icon, group, ...(shortcut ? { shortcut } : {}) })

export const FORMATTING_TOOLS: Readonly<Record<FormattingToolId, FormattingTool>> = Object.freeze({
  undo: tool('undo', 'undo', 'mdi-undo', 'history', 'Mod-z'),
  redo: tool('redo', 'redo', 'mdi-redo', 'history', 'Mod-Shift-z'),
  bold: tool('bold', 'bold', 'mdi-format-bold', 'text', 'Mod-b'),
  italic: tool('italic', 'italic', 'mdi-format-italic', 'text', 'Mod-i'),
  underline: tool('underline', 'underline', 'mdi-format-underline', 'text', 'Mod-u'),
  strikethrough: tool('strikethrough', 'strikethrough', 'mdi-format-strikethrough', 'text'),
  highlight: tool('highlight', 'highlight', 'mdi-format-color-highlight', 'text'),
  subscript: tool('subscript', 'subscript', 'mdi-format-subscript', 'text'),
  superscript: tool('superscript', 'superscript', 'mdi-format-superscript', 'text'),
  heading: tool('heading', 'headingLevel', 'mdi-format-header-pound', 'structure'),
  inlineCode: tool('inlineCode', 'inlineCode', 'mdi-code-tags', 'text'),
  keyboardKey: tool('keyboardKey', 'keyboardKey', 'mdi-keyboard-outline', 'text'),
  link: tool('link', 'insertLink', 'mdi-link-variant', 'insert'),
  blockquote: tool('blockquote', 'blockquote', 'mdi-format-quote-open', 'structure'),
  unorderedList: tool('unorderedList', 'unorderedList', 'mdi-format-list-bulleted', 'structure'),
  orderedList: tool('orderedList', 'orderedList', 'mdi-format-list-numbered', 'structure'),
  taskList: tool('taskList', 'taskList', 'mdi-format-list-checks', 'structure'),
  outdent: tool('outdent', 'outdent', 'mdi-format-indent-decrease', 'structure'),
  indent: tool('indent', 'indent', 'mdi-format-indent-increase', 'structure'),
  alignLeft: tool('alignLeft', 'alignLeft', 'mdi-format-align-left', 'structure'),
  alignCenter: tool('alignCenter', 'alignCenter', 'mdi-format-align-center', 'structure'),
  alignRight: tool('alignRight', 'alignRight', 'mdi-format-align-right', 'structure'),
  horizontalBar: tool('horizontalBar', 'horizontalBar', 'mdi-minus', 'structure'),
  codeBlock: tool('codeBlock', 'insertCodeBlock', 'mdi-code-braces', 'structure'),
  table: tool('table', 'tableHelper', 'mdi-table', 'structure'),
  assets: tool('assets', 'insertAssets', 'mdi-folder-multiple-image', 'insert'),
  diagram: tool('diagram', 'insertDiagram', 'mdi-chart-multiline', 'insert'),
  contentExtension: tool('contentExtension', 'insertContentExtension', 'mdi-puzzle-outline', 'insert'),
  definitionList: tool('definitionList', 'insertDefinitionList', 'mdi-format-list-group-plus', 'insert'),
  abbreviation: tool('abbreviation', 'insertAbbreviation', 'mdi-tooltip-plus-outline', 'insert')
})

const isApplePlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '')

/** Render `Mod-Shift-z` as `Ctrl+Shift+Z` or `⌘⇧Z`. */
export const formatShortcut = (shortcut: string, apple = isApplePlatform()): string => {
  const parts = shortcut.split('-')
  const key = (parts.pop() ?? '').toUpperCase()
  const modifiers = parts.map(part => {
    if (part === 'Mod') return apple ? '⌘' : 'Ctrl'
    if (part === 'Shift') return apple ? '⇧' : 'Shift'
    if (part === 'Alt') return apple ? '⌥' : 'Alt'
    return part
  })
  return apple ? [...modifiers, key].join('') : [...modifiers, key].join('+')
}

/** Tooltip text: `Bold (Ctrl+B)`; the accessible name stays the bare label. */
export const toolTooltip = (label: string, tool: FormattingTool, apple = isApplePlatform()): string =>
  tool.shortcut ? `${label} (${formatShortcut(tool.shortcut, apple)})` : label

export type MarkdownFormatState = {
  readonly bold: boolean
  readonly italic: boolean
  readonly strikethrough: boolean
  readonly subscript: boolean
  readonly superscript: boolean
  readonly inlineCode: boolean
  readonly link: boolean
  readonly blockquote: boolean
  readonly unorderedList: boolean
  readonly orderedList: boolean
  readonly codeBlock: boolean
  readonly table: boolean
  readonly headingLevel: number
}

export const EMPTY_MARKDOWN_FORMAT_STATE: MarkdownFormatState = Object.freeze({
  bold: false,
  italic: false,
  strikethrough: false,
  subscript: false,
  superscript: false,
  inlineCode: false,
  link: false,
  blockquote: false,
  unorderedList: false,
  orderedList: false,
  codeBlock: false,
  table: false,
  headingLevel: 0
})

/**
 * Map a Lezer Markdown node path (innermost first) to toolbar state. The
 * nearest list wins so a bullet list nested in a numbered list reads as bullet.
 */
export const markdownFormatStateFromPath = (path: readonly string[]): MarkdownFormatState => {
  let headingLevel = 0
  let list: 'unorderedList' | 'orderedList' | null = null
  const names = new Set(path)
  for (const name of path) {
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name)
    if (heading && headingLevel === 0) headingLevel = Number(heading[1])
    if (!list && name === 'BulletList') list = 'unorderedList'
    if (!list && name === 'OrderedList') list = 'orderedList'
  }
  return {
    bold: names.has('StrongEmphasis'),
    italic: names.has('Emphasis'),
    strikethrough: names.has('Strikethrough'),
    subscript: names.has('Subscript'),
    superscript: names.has('Superscript'),
    inlineCode: names.has('InlineCode'),
    link: names.has('Link'),
    blockquote: names.has('Blockquote'),
    unorderedList: list === 'unorderedList',
    orderedList: list === 'orderedList',
    codeBlock: names.has('FencedCode') || names.has('CodeBlock'),
    table: names.has('Table'),
    headingLevel
  }
}

/** Short status-bar summary such as `H2 · Bold · List`. */
export const describeMarkdownFormatState = (state: MarkdownFormatState, label: (key: string, values?: Record<string, unknown>) => string): string => {
  const parts: string[] = []
  if (state.headingLevel > 0) parts.push(label('editor:markup.headingShort', { level: state.headingLevel }))
  if (state.codeBlock) parts.push(label('editor:markup.insertCodeBlock'))
  if (state.table) parts.push(label('editor:markup.table'))
  if (state.blockquote) parts.push(label('editor:markup.blockquote'))
  if (state.unorderedList) parts.push(label('editor:markup.unorderedList'))
  if (state.orderedList) parts.push(label('editor:markup.orderedList'))
  if (state.bold) parts.push(label('editor:markup.bold'))
  if (state.italic) parts.push(label('editor:markup.italic'))
  if (state.strikethrough) parts.push(label('editor:markup.strikethrough'))
  if (state.inlineCode) parts.push(label('editor:markup.inlineCode'))
  if (state.link) parts.push(label('editor:markup.link'))
  return parts.join(' · ')
}
