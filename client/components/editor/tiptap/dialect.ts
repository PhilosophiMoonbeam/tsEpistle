import {
  createAtomBlockMarkdownSpec,
  createInlineMarkdownSpec,
  mergeAttributes,
  Node,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownRendererHelpers,
  type MarkdownToken
} from '@tiptap/core'
import { Mark } from '@tiptap/core'
import { Subscript } from '@tiptap/extension-subscript'
import { Superscript } from '@tiptap/extension-superscript'
import { Base64 } from 'js-base64'

export type WikiSourceKind = 'abbreviation' | 'attributes' | 'footnote' | 'html' | 'image-size' | 'math' | 'multiline-table'

const SOURCE_KINDS: Record<WikiSourceKind, true> = {
  abbreviation: true,
  attributes: true,
  footnote: true,
  html: true,
  'image-size': true,
  math: true,
  'multiline-table': true
}

export function encodeWikiSource (source: string): string {
  return Base64.toBase64(source, true)
}

export function decodeWikiSource (source: unknown): string {
  if (typeof source !== 'string' || source.length === 0) return ''
  try {
    return Base64.fromBase64(source)
  } catch {
    return ''
  }
}

function sourceKind (value: unknown): WikiSourceKind {
  return typeof value === 'string' && value in SOURCE_KINDS
    ? value as WikiSourceKind
    : 'html'
}

function sourceAttributes (attrString: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of attrString.matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) {
    result[match[1]!] = match[2] ?? ''
  }
  return result
}

const sourceBlockMarkdown = createAtomBlockMarkdownSpec({
  nodeName: 'wikiSourceBlock',
  parseAttributes: sourceAttributes,
  requiredAttributes: ['kind', 'source'],
  allowedAttributes: ['kind', 'source']
})

export const WikiSourceBlock = Node.create({
  name: 'wikiSourceBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes () {
    return {
      kind: { default: 'html', rendered: false },
      source: { default: '', rendered: false }
    }
  },

  parseHTML () {
    return [{
      tag: 'wiki-source-block',
      getAttrs: element => ({
        kind: sourceKind(element.getAttribute('data-kind')),
        source: element.getAttribute('data-source') ?? ''
      })
    }]
  },

  renderHTML ({ node, HTMLAttributes }) {
    const kind = sourceKind(node.attrs.kind)
    const source = decodeWikiSource(node.attrs.source)
    return ['wiki-source-block', mergeAttributes(HTMLAttributes, {
      'data-kind': kind,
      'data-source': node.attrs.source,
      'data-wiki-source': 'block',
      contenteditable: 'false'
    }), ['span', { class: 'wiki-source-label' }, kind], ['code', {}, source]]
  },

  ...sourceBlockMarkdown,
  renderMarkdown (node: JSONContent) {
    return decodeWikiSource(node.attrs?.source)
  }
})

const sourceInlineMarkdown = createInlineMarkdownSpec({
  nodeName: 'wikiSourceInline',
  selfClosing: true,
  parseAttributes: sourceAttributes,
  allowedAttributes: ['kind', 'source']
})

export const WikiSourceInline = Node.create({
  name: 'wikiSourceInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes () {
    return {
      kind: { default: 'html', rendered: false },
      source: { default: '', rendered: false }
    }
  },

  parseHTML () {
    return [{
      tag: 'wiki-source-inline',
      getAttrs: element => ({
        kind: sourceKind(element.getAttribute('data-kind')),
        source: element.getAttribute('data-source') ?? ''
      })
    }]
  },

  renderHTML ({ node, HTMLAttributes }) {
    const kind = sourceKind(node.attrs.kind)
    const source = decodeWikiSource(node.attrs.source)
    return ['wiki-source-inline', mergeAttributes(HTMLAttributes, {
      'data-kind': kind,
      'data-source': node.attrs.source,
      'data-wiki-source': 'inline',
      contenteditable: 'false',
      title: `${kind}: ${source}`
    }), source]
  },

  ...sourceInlineMarkdown,
  renderMarkdown (node: JSONContent) {
    return decodeWikiSource(node.attrs?.source)
  }
})

export const Keyboard = Mark.create({
  name: 'keyboard',
  inclusive: false,

  parseHTML () {
    return [{ tag: 'kbd' }]
  },

  renderHTML ({ HTMLAttributes }) {
    return ['kbd', mergeAttributes(HTMLAttributes), 0]
  },

  markdownTokenizer: {
    name: 'keyboard',
    level: 'inline',
    start: source => source.search(/<kbd>/i),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(/^<kbd>([\s\S]*?)<\/kbd>/i)
      if (!match) return undefined
      return {
        type: 'keyboard',
        raw: match[0],
        tokens: lexer.inlineTokens(match[1] ?? '')
      }
    }
  },

  parseMarkdown (token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.applyMark('keyboard', helpers.parseInline(token.tokens ?? []))
  },

  renderMarkdown (node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `<kbd>${helpers.renderChildren(node)}</kbd>`
  }
})

export const WikiSubscript = Subscript.extend({
  markdownTokenizer: {
    name: 'subscript',
    level: 'inline',
    start: source => source.indexOf('~'),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(/^~([^~\n]+)~/)
      if (!match || /^~~/.test(source)) return undefined
      return {
        type: 'subscript',
        raw: match[0],
        tokens: lexer.inlineTokens(match[1] ?? '')
      }
    }
  },
  parseMarkdown (token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.applyMark('subscript', helpers.parseInline(token.tokens ?? []))
  },
  renderMarkdown (node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `~${helpers.renderChildren(node)}~`
  }
})

export const WikiSuperscript = Superscript.extend({
  markdownTokenizer: {
    name: 'superscript',
    level: 'inline',
    start: source => source.indexOf('^'),
    tokenize: (source, _tokens, lexer) => {
      const match = source.match(/^\^([^^\n]+)\^/)
      if (!match) return undefined
      return {
        type: 'superscript',
        raw: match[0],
        tokens: lexer.inlineTokens(match[1] ?? '')
      }
    }
  },
  parseMarkdown (token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.applyMark('superscript', helpers.parseInline(token.tokens ?? []))
  },
  renderMarkdown (node: JSONContent, helpers: MarkdownRendererHelpers) {
    return `^${helpers.renderChildren(node)}^`
  }
})

type DefinitionItem = {
  term: string
  definitions: string[]
}

function tokenizeDefinitionList (source: string): { raw: string, items: DefinitionItem[] } | undefined {
  const lines = source.split('\n')
  if (!lines[0]?.trim() || !/^:\s+/.test(lines[1] ?? '')) return undefined

  const items: DefinitionItem[] = []
  let index = 0
  while (index < lines.length) {
    const term = lines[index]?.trim()
    if (!term || /^[:#>*+-]\s/.test(term) || !/^:\s+/.test(lines[index + 1] ?? '')) break
    index += 1
    const definitions: string[] = []
    while (/^:\s+/.test(lines[index] ?? '')) {
      let definition = (lines[index] ?? '').replace(/^:\s+/, '')
      index += 1
      while (/^(?: {2,}|\t)\S/.test(lines[index] ?? '')) {
        definition += `\n${(lines[index] ?? '').trimStart()}`
        index += 1
      }
      definitions.push(definition)
    }
    items.push({ term, definitions })
    if (lines[index] === '' && lines[index + 1]?.trim() && /^:\s+/.test(lines[index + 2] ?? '')) index += 1
  }

  if (items.length === 0) return undefined
  const raw = lines.slice(0, index).join('\n')
  return { raw, items }
}

export const DefinitionTerm = Node.create({
  name: 'definitionTerm',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'dt' }],
  renderHTML: ({ HTMLAttributes }) => ['dt', mergeAttributes(HTMLAttributes), 0]
})

export const DefinitionDescription = Node.create({
  name: 'definitionDescription',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'dd' }],
  renderHTML: ({ HTMLAttributes }) => ['dd', mergeAttributes(HTMLAttributes), 0]
})

export const DefinitionList = Node.create({
  name: 'definitionList',
  group: 'block',
  content: '(definitionTerm definitionDescription+)+',

  parseHTML () {
    return [{ tag: 'dl' }]
  },

  renderHTML ({ HTMLAttributes }) {
    return ['dl', mergeAttributes(HTMLAttributes), 0]
  },

  markdownTokenizer: {
    name: 'definitionList',
    level: 'block',
    start: source => source.search(/^[^\n]+\n:\s+/m),
    tokenize: source => {
      const result = tokenizeDefinitionList(source)
      return result
        ? { type: 'definitionList', raw: result.raw, items: result.items }
        : undefined
    }
  },

  parseMarkdown (token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const items = Array.isArray(token.items) ? token.items as DefinitionItem[] : []
    const content: JSONContent[] = []
    for (const item of items) {
      const termTokens = helpers.tokenizeInline?.(item.term) ?? [{ type: 'text', raw: item.term, text: item.term }]
      content.push(helpers.createNode('definitionTerm', {}, helpers.parseInline(termTokens)))
      for (const definition of item.definitions) {
        const definitionTokens = helpers.tokenizeInline?.(definition) ?? [{ type: 'text', raw: definition, text: definition }]
        content.push(helpers.createNode('definitionDescription', {}, [
          helpers.createNode('paragraph', {}, helpers.parseInline(definitionTokens))
        ]))
      }
    }
    return helpers.createNode('definitionList', {}, content)
  },

  renderMarkdown (node: JSONContent, helpers: MarkdownRendererHelpers) {
    const lines: string[] = []
    for (const child of node.content ?? []) {
      if (child.type === 'definitionTerm') {
        if (lines.length > 0) lines.push('')
        lines.push(helpers.renderChildren(child).trim())
      } else if (child.type === 'definitionDescription') {
        const rendered = helpers.renderChildren(child).trim().split('\n')
        lines.push(`: ${rendered.shift() ?? ''}`)
        lines.push(...rendered.map(line => `  ${line}`))
      }
    }
    return lines.join('\n')
  }
})

function blockPlaceholder (kind: WikiSourceKind, source: string): string {
  return `:::wikiSourceBlock {kind="${kind}" source="${encodeWikiSource(source)}"} :::`
}

function inlinePlaceholder (kind: WikiSourceKind, source: string): string {
  return `[wikiSourceInline kind="${kind}" source="${encodeWikiSource(source)}"]`
}

function protectInlineSource (line: string): string {
  let result = ''
  let index = 0

  while (index < line.length) {
    if (line[index] === '`') {
      const marker = line.slice(index).match(/^`+/)?.[0] ?? '`'
      const close = line.indexOf(marker, index + marker.length)
      if (close >= 0) {
        result += line.slice(index, close + marker.length)
        index = close + marker.length
        continue
      }
    }

    const source = line.slice(index)
    const candidates: Array<{ kind: WikiSourceKind, match: RegExpMatchArray | null }> = [
      { kind: 'html', match: source.match(/^<!--[\s\S]*?-->/) },
      { kind: 'image-size', match: source.match(/^!\[[^\]\n]*\]\([^\n)]*(?:\s=\d*(?:x\d*)?|\s+\d+x\d+)[^\n)]*\)/) },
      { kind: 'footnote', match: source.match(/^\[\^[^\]\n]+\]/) },
      { kind: 'math', match: source.match(/^\\\([\s\S]+?\\\)/) },
      { kind: 'math', match: source.match(/^\$(?!\s|\$)(?:\\.|[^$\\\n])+?(?<!\s)\$/) },
      { kind: 'attributes', match: source.match(/^\{\s*(?:[#.][A-Za-z]|[^}\n]*(?:\bid\s*=|\bclass\s*=|\btarget\s*=))[^}\n]*\}/) },
      { kind: 'html', match: source.match(/^<(?!\/?kbd(?:\s|>))\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\s*\/?>/) }
    ]
    const candidate = candidates.find(item => item.match)
    if (candidate?.match) {
      const raw = candidate.match[0]
      result += inlinePlaceholder(candidate.kind, raw)
      index += raw.length
      continue
    }

    result += line[index]
    index += 1
  }

  return result
}

function isFence (line: string): RegExpMatchArray | null {
  return line.match(/^\s{0,3}(`{3,}|~{3,})/)
}

export function prepareTiptapMarkdown (source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  let index = 0
  let fence: { marker: string, length: number } | null = null

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fenceMatch = isFence(line)
    if (fence) {
      output.push(line)
      if (fenceMatch?.[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length) fence = null
      index += 1
      continue
    }
    if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0]!, length: fenceMatch[1].length }
      output.push(line)
      index += 1
      continue
    }

    if (/^\s*(?:\$\$|\\\[)/.test(line)) {
      const captured = [line]
      const closes = line.trim().startsWith('$$') ? /\$\$\s*$/ : /\\\]\s*$/
      index += 1
      if (!closes.test(line.replace(/^\s*(?:\$\$|\\\[)/, ''))) {
        while (index < lines.length) {
          captured.push(lines[index] ?? '')
          const done = closes.test(lines[index] ?? '')
          index += 1
          if (done) break
        }
      }
      output.push(blockPlaceholder('math', captured.join('\n')))
      continue
    }

    if (/^\s*\[\^[^\]]+\]:/.test(line)) {
      const captured = [line]
      index += 1
      while (index < lines.length && (/^(?: {2,}|\t)\S/.test(lines[index] ?? '') || (lines[index] === '' && /^(?: {2,}|\t)\S/.test(lines[index + 1] ?? '')))) {
        captured.push(lines[index] ?? '')
        index += 1
      }
      output.push(blockPlaceholder('footnote', captured.join('\n')))
      continue
    }

    if (/^\s*\*\[[^\]\n]+\]:/.test(line)) {
      output.push(blockPlaceholder('abbreviation', line))
      index += 1
      continue
    }

    if (/^\s*<!--/.test(line) || /^\s*<(?!\/?kbd(?:\s|>))[A-Za-z][A-Za-z0-9-]*(?:\s|>)/.test(line)) {
      const captured = [line]
      index += 1
      if (!/-->\s*$/.test(line) && !/<\/[A-Za-z][A-Za-z0-9-]*>\s*$/.test(line)) {
        while (index < lines.length && lines[index] !== '') {
          captured.push(lines[index] ?? '')
          index += 1
        }
      }
      output.push(blockPlaceholder('html', captured.join('\n')))
      continue
    }

    if (line.includes('|')) {
      let end = index
      while (end < lines.length && (lines[end] ?? '').includes('|')) end += 1
      const tableLines = lines.slice(index, end)
      if (tableLines.some(tableLine => /\^\^|\\\s*\|?\s*$/.test(tableLine))) {
        output.push(blockPlaceholder('multiline-table', tableLines.join('\n')))
        index = end
        continue
      }
    }

    output.push(protectInlineSource(line))
    index += 1
  }

  return output.join('\n')
}

function sourceNodeHtml (display: 'block' | 'inline', kind: WikiSourceKind, source: string): string {
  const tag = `wiki-source-${display}`
  const encoded = encodeWikiSource(source)
  return `<${tag} data-kind="${kind}" data-source="${encoded}"></${tag}>`
}

const HTML_BLOCK_TAGS: Record<string, true> = {
  address: true,
  article: true,
  aside: true,
  details: true,
  div: true,
  figcaption: true,
  figure: true,
  footer: true,
  header: true,
  main: true,
  nav: true,
  section: true,
  summary: true
}
const SUPPORTED_HTML_TAGS: Record<string, true> = {
  a: true,
  b: true,
  blockquote: true,
  br: true,
  code: true,
  col: true,
  colgroup: true,
  dd: true,
  del: true,
  dl: true,
  dt: true,
  em: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  hr: true,
  i: true,
  img: true,
  kbd: true,
  li: true,
  mark: true,
  ol: true,
  p: true,
  pre: true,
  s: true,
  strong: true,
  sub: true,
  sup: true,
  table: true,
  tbody: true,
  td: true,
  tfoot: true,
  th: true,
  thead: true,
  tr: true,
  u: true,
  ul: true
}

export function prepareTiptapHtml (source: string): string {
  if (!source || typeof document === 'undefined') return source
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, comment => sourceNodeHtml('block', 'html', comment))
  const template = document.createElement('template')
  template.innerHTML = withoutComments
  const elements = [...template.content.querySelectorAll('*')]
  for (const element of elements) {
    if (!element.isConnected && !template.content.contains(element)) continue
    const tag = element.tagName.toLowerCase()
    if (tag in SUPPORTED_HTML_TAGS || tag.startsWith('wiki-source-')) continue
    const display = tag in HTML_BLOCK_TAGS ? 'block' : 'inline'
    const replacement = document.createElement(`wiki-source-${display}`)
    replacement.setAttribute('data-kind', 'html')
    replacement.setAttribute('data-source', encodeWikiSource(element.outerHTML))
    element.replaceWith(replacement)
  }
  return template.innerHTML
}

export function restoreTiptapHtmlSources (source: string): string {
  if (!source || typeof document === 'undefined') return source
  const template = document.createElement('template')
  template.innerHTML = source
  for (const element of [...template.content.querySelectorAll('wiki-source-block, wiki-source-inline')]) {
    const restored = decodeWikiSource(element.getAttribute('data-source'))
    const marker = document.createTextNode(`__WIKI_SOURCE_${encodeWikiSource(restored)}__`)
    element.replaceWith(marker)
  }
  return template.innerHTML.replace(/__WIKI_SOURCE_([A-Za-z0-9_-]+)__/g, (_match, encoded: string) => decodeWikiSource(encoded))
}
