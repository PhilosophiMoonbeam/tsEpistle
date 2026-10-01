import type { MarkdownIt, MarkdownItOptions, Token } from 'markdown-it'
import * as markdownItModule from 'markdown-it'
import { load } from 'cheerio'

import { parseOkfDocument } from '../../okf/format.ts'

export interface SourceSpan {
  readonly start: number
  readonly end: number
}
export interface SourceLink {
  readonly label: string
  readonly destination: string
  readonly unitId: string
  readonly sourceSpans: readonly SourceSpan[]
  readonly dependencySpans: readonly SourceSpan[]
  readonly kind: 'link' | 'autolink'
}
export interface SourceContext {
  readonly id: string
  readonly kind: 'heading' | 'summary' | 'list-item' | 'table-header'
  readonly sourceSpans: readonly SourceSpan[]
  readonly normalizedLabel: string
  readonly parentId: string | null
  readonly complete: boolean
}
export interface SourceField {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly unitIds: readonly string[]
  readonly sourceSpans: readonly SourceSpan[]
  readonly order: number
  readonly complete: boolean
}
export interface SourceRecord {
  readonly id: string
  readonly kind: 'list-item' | 'labeled-record' | 'table-row'
  readonly contextIds: readonly string[]
  readonly fields: readonly SourceField[]
  readonly unitIds: readonly string[]
  readonly complete: boolean
}
export interface SourceUnit {
  readonly id: string
  readonly kind: 'paragraph' | 'list-item' | 'table-row' | 'heading' | 'summary' | 'code' | 'opaque'
  readonly sourceSpans: readonly SourceSpan[]
  readonly normalizedText: string
  readonly contextIds: readonly string[]
  readonly recordId: string | null
  readonly structuralLabels: readonly string[]
  readonly links: readonly SourceLink[]
  readonly complete: boolean
}
export interface SourceSection {
  readonly headingId: string
  readonly level: number
  readonly syntax: 'atx' | 'setext' | 'html'
  readonly ancestry: readonly string[]
  readonly startOffset: number
  readonly endOffset: number
  readonly unitIds: readonly string[]
}
export interface ParsedSourceDocument {
  readonly source: string
  readonly units: readonly SourceUnit[]
  readonly contexts: readonly SourceContext[]
  readonly records: readonly SourceRecord[]
  readonly sections: readonly SourceSection[]
}

type Factory = (options?: MarkdownItOptions) => MarkdownIt
const factory = (module: unknown): Factory => {
  if (typeof module === 'function') return module as Factory
  if (typeof module === 'object' && module !== null && 'default' in module && typeof module.default === 'function') return module.default as Factory
  throw new TypeError('markdown-it does not export a callable parser')
}
const literalMarkdown = factory(markdownItModule)({ html: false, linkify: false })
const whitespace = (text: string): string => text.replace(/\s+/gu, ' ').trim()
const identity = (text: string): string => whitespace(text).normalize('NFKC').toLowerCase()
const labelField = (text: string): { label: string; value: string } | null => {
  const match = /^([^:\n]{1,80}):\s*(\S[\s\S]*)$/u.exec(text)
  if (!match || /[.!?]|:\/\//u.test(match[1]!)) return null
  return { label: whitespace(match[1]!), value: whitespace(match[2]!) }
}
const sentenceAbbreviations: Readonly<Record<string, true>> = {
  approx: true,
  dept: true,
  dr: true,
  e: true,
  etc: true,
  g: true,
  inc: true,
  jr: true,
  mr: true,
  mrs: true,
  ms: true,
  no: true,
  sr: true,
  st: true,
  vs: true
}
export const isSourceSentenceAbbreviation = (value: string): boolean => sentenceAbbreviations[value.toLowerCase()] === true

const closedProseSentence = (tokens: readonly Token[]): boolean => {
  let finalText: string | null = null
  let ordinary = ''
  let opaqueLink = false
  const html: string[] = []
  const voidTags: Readonly<Record<string, true>> = {
    area: true,
    base: true,
    br: true,
    col: true,
    embed: true,
    hr: true,
    img: true,
    input: true,
    link: true,
    meta: true,
    param: true,
    source: true,
    track: true,
    wbr: true
  }
  for (const token of tokens) {
    if (token.type === 'link_open') opaqueLink = token.info === 'auto' || token.markup === 'linkify'
    else if (token.type === 'link_close') opaqueLink = false
    else if (token.type === 'text') {
      if (!opaqueLink) {
        if (token.content.trim()) finalText = token.content
        ordinary += token.content
      } else finalText = null
    } else if (token.type === 'code_inline' || token.type === 'image') finalText = null
    else if (token.type === 'softbreak' || token.type === 'hardbreak') ordinary += '\n'
    else if (token.type === 'html_inline') {
      const tag = /^<(\/?)([a-z][\w:-]*)\b[^>]*>$/iu.exec(token.content)
      if (!tag) return false
      const name = tag[2]!.toLowerCase()
      if (tag[1]) {
        if (html.pop() !== name) return false
      } else if (!voidTags[name] && !token.content.endsWith('/>')) html.push(name)
    }
  }
  if (html.length > 0 || finalText === null || /`|(?:^|\s)[*_~]+(?=\S)/u.test(ordinary)) return false
  const pairs: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '“': '”', '‘': '’' }
  const closers: Readonly<Record<string, true>> = { ')': true, ']': true, '}': true, '”': true, '’': true }
  const stack: string[] = []
  for (let index = 0; index < ordinary.length; index += 1) {
    const char = ordinary[index]!
    if ((char === "'" || char === '’') && /\p{L}/u.test(ordinary[index - 1] ?? '') && /\p{L}/u.test(ordinary[index + 1] ?? '')) continue
    if (char === '"' || char === "'") {
      if (stack.at(-1) === char) stack.pop()
      else stack.push(char)
    } else if (pairs[char]) stack.push(pairs[char])
    else if (closers[char] && stack.pop() !== char) return false
  }
  if (stack.length > 0) return false
  const ending = finalText.trimEnd().replace(/["'”’)\]}]+$/u, '')
  if (!/[.!?]$/u.test(ending) || /\.{2,}$/u.test(ending) || /[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)+\.$/u.test(ending)) return false
  const word = ending.match(/([\p{L}]+)\.$/u)?.[1]
  return word === undefined || (word.length > 1 && !isSourceSentenceAbbreviation(word))
}
const lineStarts = (text: string): number[] => {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1)
  return starts
}

interface Location {
  startOffset: number
  endOffset: number
  startTag?: Location
  endTag?: Location
}
interface HtmlNode {
  type: string
  name?: string
  data?: string
  attribs?: Record<string, string>
  children?: HtmlNode[]
  sourceCodeLocation?: Location
}
interface InlineProjection {
  text: string
  links: Array<Omit<SourceLink, 'unitId' | 'sourceSpans'>>
}
interface Block {
  type: string
  span: SourceSpan
  text?: string | undefined
  inline?: Token[] | undefined
  children: Block[]
  level?: number | undefined
  syntax?: SourceSection['syntax'] | undefined
  complete: boolean
}
interface MutableRecord {
  id: string
  kind: SourceRecord['kind']
  contextIds: string[]
  fields: SourceField[]
  unitIds: string[]
  complete: boolean
}

// Mask only delimiters within literal Markdown code before parsing HTML. The
// original bytes still supply text and spans; the mask cannot supply evidence.
const maskHtmlCode = (raw: string): string => {
  const chars = raw.split('')
  const mask = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) if (chars[index] === '<' || chars[index] === '>') chars[index] = ' '
  }
  // HTML parsing must not turn indented Markdown code into real DOM nodes.
  // Use block-token boundaries, including code nested inside list items.
  const starts = lineStarts(raw)
  const literalTokens: Token[] = []
  literalMarkdown.block.parse(raw.replaceAll('\r\n', '\n'), literalMarkdown, {}, literalTokens)
  for (const token of literalTokens) {
    if (token.type === 'code_block' && token.map) mask(starts[token.map[0]] ?? 0, starts[token.map[1]] ?? raw.length)
  }
  let fence: { char: string; length: number; start: number } | null = null
  let offset = 0
  for (const line of raw.split(/(?<=\n)/u)) {
    const summaryPrefix: string | undefined = !fence ? /^[\s\S]*<\/summary\s*>/iu.exec(line)?.[0] : undefined
    const column: number = summaryPrefix?.length ?? 0
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/u.exec(line.slice(column))
    if (marker && !fence && !(marker[1]![0] === '`' && marker[2]!.includes('`')))
      fence = { char: marker[1]![0]!, length: marker[1]!.length, start: offset + column }
    else if (marker && fence && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === '') {
      mask(fence.start, offset + line.length)
      fence = null
    }
    offset += line.length
  }
  if (fence) mask(fence.start, raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '`') continue
    let end = index + 1
    while (raw[end] === '`') end += 1
    const delimiter = raw.slice(index, end)
    let close = raw.indexOf(delimiter, end)
    while (close >= 0 && (raw[close - 1] === '`' || raw[close + delimiter.length] === '`')) close = raw.indexOf(delimiter, close + delimiter.length)
    if (close >= 0) {
      mask(index, close + delimiter.length)
      index = close + delimiter.length - 1
    } else index = end - 1
  }
  return chars.join('')
}

export const parseSourceDocument = (
  source: string,
  options: { readonly representation: 'markdown' | 'recent-excerpt' | 'okf'; readonly truncated: boolean }
): ParsedSourceDocument => {
  let bodyOffset = 0
  if (options.representation === 'okf') {
    // Validate through the canonical parser, but parse its original suffix: the
    // returned body normalizes CRLF and therefore is not an offset authority.
    parseOkfDocument(source)
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(source)!
    bodyOffset = frontmatter[0].length
    const blank = /^\r?\n/u.exec(source.slice(bodyOffset))
    bodyOffset += blank?.[0].length ?? 0
  }
  const markdown = factory(markdownItModule)({ html: true, breaks: true, linkify: true, typographer: false })
  const environment: { references?: Record<string, { href: string; title: string }> } = {}
  const references = new Map<string, SourceSpan[]>()
  const cut = options.representation === 'recent-excerpt' && options.truncated
  const bounded = (span: SourceSpan): boolean => !cut || span.end < source.length || /\r?\n\s*\r?\n$/u.test(source.slice(span.start, span.end))
  const originalRules = markdown.block.ruler.getRules('')
  const referenceRule = originalRules.find(rule => rule.name === 'reference')
  if (!referenceRule) throw new TypeError('markdown-it reference rule is unavailable')
  let activeStarts: number[] = []
  let activeOffset = 0
  markdown.block.ruler.at('reference', (state, start, end, silent) => {
    if (silent) return referenceRule(state, start, end, silent)
    const previous = state.env.references as typeof environment.references
    state.env.references = {}
    const result = referenceRule(state, start, end, false)
    const definitions = state.env.references as NonNullable<typeof environment.references>
    state.env.references = previous ?? {}
    if (result) {
      const span = { start: activeOffset + (activeStarts[start] ?? 0), end: activeOffset + (activeStarts[state.line] ?? activeStarts.at(-1) ?? 0) }
      for (const [key, definition] of Object.entries(definitions)) {
        const earlier = references.get(key)?.[0]
        if (!earlier || span.start < earlier.start) {
          references.set(key, [span])
          state.env.references[key] = definition
        }
      }
    }
    return result
  })
  const linkRule = markdown.inline.ruler.getRules('').find(rule => rule.name === 'link')
  if (!linkRule) throw new TypeError('markdown-it link rule is unavailable')
  markdown.inline.ruler.at('link', (state, silent) => {
    const start = state.pos
    const before = state.tokens.length
    const labelEnd = state.src[start] === '[' ? markdown.helpers.parseLinkLabel(state, start, false) : -1
    const result = linkRule(state, silent)
    if (result && !silent && labelEnd >= 0 && state.src[labelEnd + 1] !== '(') {
      const suffix = state.src.slice(labelEnd + 1, state.pos)
      const explicit = /^\[([^\]]*)\]/u.exec(suffix)?.[1]
      const key = markdown.utils.normalizeReference(explicit || state.src.slice(start + 1, labelEnd))
      const opening = state.tokens.slice(before).find(token => token.type === 'link_open')
      if (opening) opening.meta = { sourceReference: key }
    }
    return result
  })

  // The bridge consumes complete presentational elements before CommonMark's
  // blank-line-terminated html_block rule can swallow only part of a disclosure.
  markdown.block.ruler.before(
    'html_block',
    'source_html',
    (state, start, end, silent) => {
      if (state.sCount[start]! - state.blkIndent > 3) return false
      const begin = state.bMarks[start]! + state.tShift[start]!
      const rest = state.src.slice(begin)
      const first = /^<(details|div|p|ul|ol|table|h[1-6]|pre|code|script|style|template|summary)(?:\s[^>]*|\s*)>/iu.exec(rest)
      if (!first) return false
      if (silent) return true
      const masked = maskHtmlCode(rest)
      const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/giu
      const root = first[1]!.toLowerCase()
      let depth = 0
      let finish = rest.length
      let suppressed: { name: string; depth: number } | null = null
      for (const match of masked.matchAll(tags)) {
        const name = match[1]?.toLowerCase()
        const closing = match[0].startsWith('</')
        if (suppressed) {
          if (name === suppressed.name) {
            if (closing) suppressed.depth -= 1
            else if (name === 'template') suppressed.depth += 1
            if (suppressed.depth === 0) suppressed = null
          }
          continue
        }
        if (name !== root && name && ['script', 'style', 'template', 'pre', 'code'].includes(name) && !closing) {
          suppressed = { name, depth: 1 }
          continue
        }
        if (name !== root) continue
        if (match[0].startsWith('</')) depth -= 1
        else if (!match[0].endsWith('/>')) depth += 1
        if (depth === 0) {
          finish = match.index! + match[0].length
          break
        }
      }
      const absoluteEnd = begin + finish
      let next = start + 1
      while (next < end && state.bMarks[next]! < absoluteEnd) next += 1
      const token = state.push('source_html', '', 0)
      token.block = true
      token.map = [start, next]
      token.content = state.src.slice(begin, state.bMarks[next] ?? state.src.length)
      token.meta = { startColumn: state.tShift[start] }
      state.line = next
      return true
    },
    { alt: ['paragraph', 'reference', 'blockquote'] }
  )
  markdown.block.ruler.disable(['html_block'])

  const parseInline = (text: string): Token[] => markdown.parseInline(text, environment)[0]?.children ?? []
  const htmlProjection = (raw: string): string => {
    const $ = load(raw, {}, false)
    $('script,style,template').remove()
    $('br').replaceWith('\n')
    return $.root().text()
  }
  const inlineProjections = new WeakMap<readonly Token[], InlineProjection>()
  const projection = (tokens: readonly Token[]): InlineProjection => {
    const cached = inlineProjections.get(tokens)
    if (cached) return cached
    let text = ''
    const links: InlineProjection['links'] = []
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!
      if (token.type === 'link_open') {
        const child: Token[] = []
        index += 1
        for (; index < tokens.length && tokens[index]!.type !== 'link_close'; index += 1) child.push(tokens[index]!)
        const label = whitespace(projection(child).text)
        const destination = String(token.attrGet('href') ?? '')
        const kind = token.info === 'auto' || token.markup === 'linkify' ? 'autolink' : 'link'
        // References are syntactic dependencies, never factual vocabulary.
        const key = (token.meta as { sourceReference?: string } | null)?.sourceReference
        const dependencies = key ? (references.get(key) ?? []) : []
        links.push({ label, destination, kind, dependencySpans: dependencies })
        if (kind !== 'autolink') text += label
        else if (/^mailto:/iu.test(destination)) text += label.replace(/^mailto:/iu, '')
      } else if (token.type === 'code_inline') text += `${token.markup}${token.content}${token.markup}`
      else if (token.type === 'text')
        text += token.content.replace(
          /\{(?:[.#][\w-]+|(?:id|class|target)=(?:"[^"]*"|'[^']*'|[^\s}]+))(?:\s+(?:[.#][\w-]+|(?:id|class|target)=(?:"[^"]*"|'[^']*'|[^\s}]+)))*\}/gu,
          ''
        )
      else if (token.type === 'softbreak' || token.type === 'hardbreak') text += '\n'
      else if (token.type === 'image') text += token.content
      else if (token.type === 'html_inline') {
        const opening = /^<(script|style|template)\b/iu.exec(token.content)
        if (opening) {
          while (index + 1 < tokens.length && !new RegExp(`^<\\/${opening[1]}\\s*>`, 'iu').test(tokens[index]!.content)) index += 1
          continue
        }
        if (/^<(?:pre|code)\b/iu.test(token.content)) {
          const name = /^<([a-z]+)/iu.exec(token.content)![1]!
          const literal: string[] = []
          index += 1
          for (; index < tokens.length && !new RegExp(`^<\\/${name}\\s*>`, 'iu').test(tokens[index]!.content); index += 1) literal.push(tokens[index]!.content)
          text += `\`${htmlProjection(literal.join(''))}\``
        } else if (/^<a\b/iu.test(token.content)) {
          const anchor: Token[] = []
          index += 1
          for (; index < tokens.length && !/^<\/a\s*>/iu.test(tokens[index]!.content); index += 1) anchor.push(tokens[index]!)
          const label = whitespace(projection(anchor).text)
          const $ = load(`${token.content}</a>`, {}, false)
          const destination = $('a').attr('href')
          text += label
          if (index < tokens.length && destination && markdown.validateLink(destination))
            links.push({ label, destination: markdown.normalizeLink(destination), kind: 'link', dependencySpans: [] })
        } else if (/^<br\b/iu.test(token.content)) text += '\n'
        else if (!/^<\/?[a-z]|^<!--/iu.test(token.content)) text += htmlProjection(token.content)
      }
    }
    const result = { text, links }
    inlineProjections.set(tokens, result)
    return result
  }

  const inlineFragments = (tokens: readonly Token[], separators: RegExp, breakLines: boolean): Token[][] => {
    const fragments: Token[][] = [[]]
    let linkDepth = 0
    let anchorDepth = 0
    for (const token of tokens) {
      if (token.type === 'link_open') linkDepth += 1
      if (token.type === 'html_inline' && /^<a\b/iu.test(token.content)) anchorDepth += 1
      if (breakLines && (token.type === 'softbreak' || token.type === 'hardbreak' || (token.type === 'html_inline' && /^<br\b/iu.test(token.content))))
        fragments.push([])
      else if (token.type === 'text' && linkDepth === 0 && anchorDepth === 0 && separators.test(token.content)) {
        const parts = token.content.split(separators)
        for (let index = 0; index < parts.length; index += 1) {
          if (index > 0) fragments.push([])
          if (parts[index]) fragments.at(-1)!.push(Object.assign(Object.create(Object.getPrototypeOf(token)), token, { content: parts[index] }) as Token)
        }
      } else fragments.at(-1)!.push(token)
      if (token.type === 'link_close') linkDepth -= 1
      if (token.type === 'html_inline' && /^<\/a\s*>/iu.test(token.content)) anchorDepth -= 1
    }
    return fragments
  }

  const tokenBlocks = (tokens: Token[], offset: number, starts: number[], rawLength: number): Block[] => {
    let cursor = 0
    const range = (token: Token, enclosing: SourceSpan): SourceSpan =>
      token.map ? { start: offset + (starts[token.map[0]] ?? 0), end: offset + (starts[token.map[1]] ?? rawLength) } : enclosing
    const group = (closing?: string, enclosing: SourceSpan = { start: offset, end: offset + rawLength }): Block[] => {
      const result: Block[] = []
      while (cursor < tokens.length) {
        const token = tokens[cursor++]!
        if (token.type === closing) break
        if (token.type === 'inline') continue
        if (token.type === 'html_block' || token.type === 'source_html') {
          const span = range(token, enclosing)
          const column = (token.meta as { startColumn?: number } | null)?.startColumn ?? 0
          result.push(...htmlBlocks(source.slice(span.start + column, span.end), span.start + column))
        } else if (token.type === 'fence' || token.type === 'code_block') {
          const span = range(token, enclosing)
          result.push({ type: 'code', span, text: source.slice(span.start, span.end), children: [], complete: bounded(span) })
        } else if (token.nesting === 1) {
          const span = range(token, enclosing)
          const children = group(token.type.replace(/_open$/u, '_close'), span)
          if (token.type === 'paragraph_open' || token.type === 'heading_open' || token.type === 'th_open' || token.type === 'td_open') {
            const inline = tokens[cursor - 2]?.type === 'inline' ? tokens[cursor - 2] : null
            result.push({
              type: token.type.replace(/_open$/u, ''),
              span,
              text: inline?.content ?? '',
              children,
              level: token.type === 'heading_open' ? Number(token.tag.slice(1)) : undefined,
              syntax: token.markup === '=' || token.markup === '-' ? 'setext' : 'atx',
              complete: bounded(span)
            })
          } else result.push({ type: token.type.replace(/_open$/u, ''), span, children, complete: bounded(span) })
        }
      }
      return result
    }
    return group()
  }
  const markdownBlocks = (raw: string, offset: number): Block[] => {
    if (!raw.trim()) return []
    const starts = lineStarts(raw)
    const normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\0', '\uFFFD')
    const previousStarts = activeStarts
    const previousOffset = activeOffset
    activeStarts = [...starts, raw.length]
    activeOffset = offset
    const tokens: Token[] = []
    markdown.block.parse(normalized, markdown, environment, tokens)
    activeStarts = previousStarts
    activeOffset = previousOffset
    return tokenBlocks(tokens, offset, starts, raw.length)
  }
  const htmlBlocks = (raw: string, offset: number): Block[] => {
    const $ = load(maskHtmlCode(raw), { sourceCodeLocationInfo: true }, false)
    const opaque = (span: SourceSpan): Block => ({ type: 'opaque', span, text: '', children: [], complete: false })
    const decodeText = (value: string): string => load(value, {}, false).root().text()
    const nodes = (children: HtmlNode[]): Block[] => {
      const result: Block[] = []
      let run: SourceSpan | null = null
      const flush = (): void => {
        if (run) result.push(...markdownBlocks(raw.slice(run.start, run.end), offset + run.start))
        run = null
      }
      for (const node of children) {
        const location = node.sourceCodeLocation
        const inline = node.type === 'text' || ['a', 'b', 'strong', 'em', 'i', 'span', 'br', 's', 'u'].includes(node.name ?? '')
        if (inline && location && (node.type === 'text' || node.name === 'br' || location.endTag)) {
          if (run && run.end !== location.startOffset) flush()
          run = { start: (run as SourceSpan | null)?.start ?? location.startOffset, end: location.endOffset }
          continue
        }
        flush()
        if (node.type === 'comment') continue
        if (!location) {
          // parse5 inserts tbody for ordinary tables. It is presentation only;
          // every row/cell still needs its own original, explicitly closed span.
          if (node.name === 'tbody') result.push(...nodes(node.children ?? []))
          else if (node.type !== 'text') result.push(opaque({ start: offset, end: offset + raw.length }))
          continue
        }
        const span = { start: offset + location.startOffset, end: offset + location.endOffset }
        const name = node.name ?? ''
        if (['script', 'style', 'template'].includes(name)) continue
        if (name === 'br') continue
        if (!location.startTag || !location.endTag || location.endTag.startOffset < location.startTag.endOffset) {
          result.push(opaque(span))
          continue
        }
        if (
          ['th', 'td'].includes(name) &&
          ['colspan', 'rowspan'].some(attribute => node.attribs?.[attribute] !== undefined && node.attribs[attribute] !== '1')
        ) {
          result.push(opaque(span))
          continue
        }
        const inner = raw.slice(location.startTag.endOffset, location.endTag.startOffset)
        if (name === 'pre' || name === 'code') {
          result.push({ type: 'code', span, text: decodeText(inner), children: [], complete: bounded(span) })
          continue
        }
        if (name === 'details') {
          const meaningful = (node.children ?? []).filter(child => child.type !== 'comment' && !(child.type === 'text' && !child.data?.trim()))
          const summaries = meaningful.filter(child => child.name === 'summary')
          if (summaries.length > 1 || (summaries.length === 1 && meaningful[0] !== summaries[0])) {
            result.push(opaque(span))
            continue
          }
          result.push({ type: 'details', span, children: nodes(node.children ?? []), complete: bounded(span) })
        } else if (name === 'summary' || /^h[1-6]$/u.test(name) || ['p', 'li', 'th', 'td'].includes(name)) {
          const hasBlocks = (node.children ?? []).some(child => ['ul', 'ol', 'p', 'details', 'table'].includes(child.name ?? ''))
          result.push({
            type: name === 'p' ? 'paragraph' : name === 'li' ? 'list_item' : /^h/u.test(name) ? 'heading' : name,
            span,
            text: hasBlocks ? undefined : inner,
            children: hasBlocks ? nodes(node.children ?? []) : [],
            level: /^h[1-6]$/u.test(name) ? Number(name[1]) : undefined,
            syntax: 'html',
            complete: bounded(span)
          })
        } else if (['ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'div'].includes(name)) {
          result.push({
            type: name === 'ul' ? 'bullet_list' : name === 'ol' ? 'ordered_list' : name,
            span,
            children: nodes(node.children ?? []),
            complete: bounded(span)
          })
        } else {
          // Unknown elements never contribute attribute values or guessed
          // containers. Their visible, explicitly bounded body is local prose.
          result.push({ type: 'paragraph', span, text: inner, children: [], complete: bounded(span) })
        }
      }
      flush()
      return result
    }
    return nodes($.root().contents().toArray() as unknown as HtmlNode[])
  }

  const blocks = markdownBlocks(source.slice(bodyOffset), bodyOffset)
  // Inline parsing is deferred until all bounded runs have contributed their
  // reference definitions to this one document environment.
  const hydrate = (items: Block[]): void => {
    for (const item of items) {
      if (item.text !== undefined && !['code', 'opaque'].includes(item.type)) item.inline = parseInline(item.text)
      hydrate(item.children)
    }
  }
  hydrate(blocks)
  const units: SourceUnit[] = []
  const contexts: SourceContext[] = []
  const contextIndex = new Map<string, { context: SourceContext; order: number }>()
  const records: MutableRecord[] = []
  const headings: Array<{ level: number; context: SourceContext }> = []
  let headingFloor = 0
  let scope: string[] = []
  let detailsDepth = 0
  let ordinal = 0
  const id = (prefix: string, span: SourceSpan): string => `${prefix}:${span.start}:${span.end}:${ordinal++}`
  const sections: Array<Omit<SourceSection, 'endOffset' | 'unitIds'>> = []
  const contextIds = (): string[] =>
    [...new Set([...headings.map(heading => heading.context.id), ...scope])].sort(
      (left, right) => contextIndex.get(left)!.order - contextIndex.get(right)!.order
    )
  const context = (kind: SourceContext['kind'], label: string, block: Block): SourceContext => {
    const parent = contextIds().at(-1) ?? null
    const sourceSpans = [block.span]
    const seenSpans = new Set([`${block.span.start}:${block.span.end}`])
    const includeReferences = (item: Block): void => {
      for (const link of item.inline ? projection(item.inline).links : []) {
        for (const span of link.dependencySpans) {
          const key = `${span.start}:${span.end}`
          if (!seenSpans.has(key)) {
            seenSpans.add(key)
            sourceSpans.push(span)
          }
        }
      }
      for (const child of item.children) includeReferences(child)
    }
    includeReferences(block)
    const value: SourceContext = {
      id: id('context', block.span),
      kind,
      normalizedLabel: whitespace(label),
      sourceSpans,
      parentId: parent,
      complete: block.complete && sourceSpans.every(bounded)
    }
    contexts.push(value)
    contextIndex.set(value.id, { context: value, order: contextIndex.size })
    return value
  }
  const unit = (block: Block, kind: SourceUnit['kind'], owner: MutableRecord | null = null, text?: string): SourceUnit => {
    const value = block.inline ? projection(block.inline) : { text: block.text ?? '', links: [] }
    const unitId = id('unit', block.span)
    const activeContextIds = contextIds()
    const normalizedText = whitespace(text ?? value.text)
    const itemContextId = kind === 'list-item' ? activeContextIds.findLast(key => contextIndex.get(key)!.context.kind === 'list-item') : undefined
    const localLabel = kind === 'heading' || kind === 'summary' ? normalizedText : itemContextId ? contextIndex.get(itemContextId)!.context.normalizedLabel : ''
    const localLinkLabels =
      kind === 'code' || kind === 'opaque' || kind === 'table-row' ? [] : value.links.filter(link => link.kind === 'link').map(link => link.label)
    const declarationLabels =
      (kind === 'heading' || kind === 'summary') && block.inline && value.text.includes('|')
        ? inlineFragments(block.inline, /\|/u, false)
            .map(tokens => whitespace(projection(tokens).text))
            .filter(label => /[\p{L}\p{N}]/u.test(label))
        : []
    const valueUnit: SourceUnit = {
      id: unitId,
      kind,
      sourceSpans: [block.span],
      normalizedText,
      contextIds: activeContextIds,
      recordId: owner?.id ?? null,
      structuralLabels: [...new Set([localLabel, ...declarationLabels, ...localLinkLabels].filter(Boolean))],
      links: kind === 'code' || kind === 'opaque' ? [] : value.links.map(link => ({ ...link, unitId, sourceSpans: [block.span] })),
      complete: block.complete && value.links.every(link => link.dependencySpans.every(bounded))
    }
    units.push(valueUnit)
    if (owner) {
      owner.unitIds.push(unitId)
      owner.complete &&= valueUnit.complete
    }
    return valueUnit
  }
  const record = (block: Block, kind: SourceRecord['kind']): MutableRecord => {
    const value: MutableRecord = { id: id('record', block.span), kind, contextIds: contextIds(), fields: [], unitIds: [], complete: block.complete }
    records.push(value)
    return value
  }
  const field = (owner: MutableRecord, parsed: { label: string; value: string }, member: SourceUnit): void => {
    owner.fields.push({
      id: id('field', member.sourceSpans[0]!),
      ...parsed,
      unitIds: [member.id],
      sourceSpans: member.sourceSpans,
      order: owner.fields.length,
      complete: member.complete
    })
  }
  const visible = (block: Block): string => (block.inline ? projection(block.inline).text : (block.text ?? ''))
  const paragraph = (block: Block, owner: MutableRecord | null): void => {
    const nonempty = inlineFragments(block.inline ?? [], /[|;]/u, true).filter(tokens => whitespace(projection(tokens).text))
    const fields = nonempty.map(tokens => labelField(whitespace(projection(tokens).text)))
    const owned = owner ?? (fields.length > 0 && fields.every(Boolean) ? record(block, 'labeled-record') : null)
    if (owned && fields.length > 1 && fields.every(Boolean)) {
      for (let index = 0; index < fields.length; index += 1) {
        const parsed = fields[index]!
        const member = unit({ ...block, inline: nonempty[index] }, owner ? 'list-item' : 'paragraph', owned, `${parsed!.label}: ${parsed!.value}`)
        field(owned, parsed!, member)
      }
    } else {
      const assertionComplete =
        !owned &&
        cut &&
        block.span.end === source.length &&
        contextIds().every(key => contextIndex.get(key)!.context.complete) &&
        closedProseSentence(block.inline ?? [])
      const member = unit(assertionComplete ? { ...block, complete: true } : block, owner ? 'list-item' : 'paragraph', owned)
      const parsed = labelField(whitespace(visible(block)))
      if (owned && parsed) field(owned, parsed, member)
    }
  }
  const visit = (items: Block[], owner: MutableRecord | null = null): void => {
    for (const block of items) {
      if (block.type === 'heading') {
        const label = whitespace(visible(block))
        const level = block.level ?? 1
        while (headings.length > headingFloor && headings.at(-1)!.level >= level) headings.pop()
        const value = context('heading', label, block)
        headings.push({ level, context: value })
        unit(block, 'heading')
        if (detailsDepth === 0)
          sections.push({
            headingId: value.id,
            level,
            syntax: block.syntax ?? 'atx',
            ancestry: headings.map(item => item.context.normalizedLabel),
            startOffset: block.span.start
          })
      } else if (block.type === 'details') {
        const savedHeadings = [...headings]
        const savedScope = [...scope]
        const savedFloor = headingFloor
        headingFloor = headings.length
        detailsDepth += 1
        visit(block.children)
        headings.splice(0, headings.length, ...savedHeadings)
        scope = savedScope
        headingFloor = savedFloor
        detailsDepth -= 1
      } else if (block.type === 'summary') {
        const value = context('summary', visible(block), block)
        scope.push(value.id)
        unit(block, 'summary')
      } else if (block.type === 'list_item') {
        const previous = [...scope]
        const direct = block.text !== undefined ? [{ ...block, type: 'paragraph', children: [] }] : block.children.filter(child => child.type === 'paragraph')
        const first = direct[0]
        const label = first ? whitespace(visible(first)) : ''
        const value = context('list-item', label, first ?? block)
        scope.push(value.id)
        // A nested syntactically labeled field belongs to its explicit parent
        // record, not to a sibling or an arbitrary nearby prose passage.
        const isField =
          direct.length === 1 && labelField(label) !== null && !block.children.some(child => child.type === 'bullet_list' || child.type === 'ordered_list')
        const own = owner && isField ? owner : record(block, 'list-item')
        if (block.text !== undefined) paragraph({ ...block, type: 'paragraph' }, own)
        else visit(block.children, own)
        scope = previous
      } else if (block.type === 'paragraph') paragraph(block, owner)
      else if (block.type === 'code' || block.type === 'opaque') unit(block, block.type)
      else if (block.type === 'table') {
        const rows: Block[] = []
        const collect = (children: Block[]): void => {
          for (const child of children)
            if (child.type === 'tr') rows.push(child)
            else collect(child.children)
        }
        collect(block.children)
        const header = rows[0]
        if (!header || !header.children.every(cell => cell.type === 'th')) {
          for (const row of rows) unit({ ...row, text: '', inline: undefined }, 'opaque')
          continue
        }
        const labels = header.children.map(cell => whitespace(visible(cell)))
        const headerContext = context('table-header', labels.join(' | '), {
          ...header,
          span: { start: header.span.start, end: rows[1]?.span.start ?? block.span.end }
        })
        const previous = [...scope]
        scope.push(headerContext.id)
        for (const row of rows.slice(1)) {
          const values = row.children.map(cell => whitespace(visible(cell)))
          const own = record(row, 'table-row')
          const valid =
            labels.length === values.length &&
            row.children.every(cell => cell.type === 'td') &&
            header.children.every(cell => cell.type === 'th') &&
            labels.every(Boolean) &&
            new Set(labels.map(identity)).size === labels.length
          own.complete &&= valid
          if (valid) {
            for (let column = 0; column < labels.length; column += 1) {
              const cell = row.children[column]!
              const member = unit(cell, 'table-row', own, `${labels[column]}: ${values[column]}`)
              field(own, { label: labels[column]!, value: values[column]! }, member)
            }
          } else unit({ ...row, text: '', inline: undefined }, 'opaque', own)
        }
        scope = previous
      } else visit(block.children, owner)
    }
  }
  visit(blocks)
  for (const value of records) {
    const duplicates = new Set<string>()
    const seen = new Set<string>()
    for (const item of value.fields) {
      const key = identity(item.label)
      if (seen.has(key)) duplicates.add(key)
      seen.add(key)
    }
    if (duplicates.size) {
      value.fields = value.fields.map(item => (duplicates.has(identity(item.label)) ? { ...item, complete: false } : item))
      value.complete = false
    }
  }
  const selectedSections = sections.map(section => ({ ...section, endOffset: source.length, unitIds: [] as string[] }))
  const openSections: number[] = []
  for (let index = 0; index < selectedSections.length; index += 1) {
    const section = selectedSections[index]!
    while (openSections.length && selectedSections[openSections.at(-1)!]!.level >= section.level) {
      selectedSections[openSections.pop()!]!.endOffset = section.startOffset
    }
    openSections.push(index)
  }
  openSections.length = 0
  let nextSection = 0
  for (const member of units) {
    const start = member.sourceSpans[0]!.start
    while (nextSection < selectedSections.length && selectedSections[nextSection]!.startOffset <= start) {
      const section = selectedSections[nextSection]!
      while (openSections.length && selectedSections[openSections.at(-1)!]!.endOffset <= section.startOffset) openSections.pop()
      openSections.push(nextSection++)
    }
    for (const index of openSections) {
      const section = selectedSections[index]!
      if (member.sourceSpans.some(span => span.start >= section.startOffset && span.end <= section.endOffset)) section.unitIds.push(member.id)
    }
  }
  return { source, units, contexts, records, sections: selectedSections }
}
