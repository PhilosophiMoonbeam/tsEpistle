export interface MarkdownCodeFence {
  marker: '`' | '~'
  markerLength: number
  info: string
  content: string
  closed: boolean
}

export interface MarkdownCodeFenceMetadata {
  language: string
  title: string
  lineStart: number
  lineHighlights: string
}

export interface MarkdownCodeFenceRenderOptions {
  source: string
  info?: string
  sourceLine?: number
  decodeDiagram?: (source: string) => string
  unescape?: (value: string) => string
}

const FENCE_ATTRIBUTE = /([a-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"']+))/gi
const LINE_RANGE = /^(\d+)(?:\s*-\s*(\d+))?$/

interface MarkdownLine {
  start: number
  end: number
  next: number
}

const markdownLineAt = (source: string, start: number): MarkdownLine => {
  let end = start
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
  let next = end
  if (source[next] === '\r') next += 1
  if (source[next] === '\n') next += 1
  return { start, end, next }
}

const fenceMarkerAt = (source: string, line: MarkdownLine): { marker: '`' | '~'; markerLength: number; rest: number } | null => {
  let cursor = line.start
  let indentation = 0
  while (cursor < line.end) {
    if (source[cursor] === ' ') {
      indentation += 1
    } else if (source[cursor] === '\t') {
      indentation += 4 - (indentation % 4)
    } else {
      break
    }
    if (indentation > 3) return null
    cursor += 1
  }

  const marker = source[cursor]
  if (marker !== '`' && marker !== '~') return null
  const markerStart = cursor
  while (cursor < line.end && source[cursor] === marker) cursor += 1
  const markerLength = cursor - markerStart
  return markerLength >= 3 ? { marker, markerLength, rest: cursor } : null
}

const isClosingFence = (source: string, line: MarkdownLine, marker: '`' | '~', markerLength: number): boolean => {
  const candidate = fenceMarkerAt(source, line)
  if (!candidate || candidate.marker !== marker || candidate.markerLength < markerLength) return false
  for (let cursor = candidate.rest; cursor < line.end; cursor += 1) {
    if (source[cursor] !== ' ' && source[cursor] !== '\t') return false
  }
  return true
}

export function* parseMarkdownCodeFences(source: string): Generator<MarkdownCodeFence> {
  let lineStart = 0
  while (lineStart < source.length) {
    const openingLine = markdownLineAt(source, lineStart)
    const opening = fenceMarkerAt(source, openingLine)
    if (!opening) {
      lineStart = openingLine.next
      continue
    }

    const info = source.slice(opening.rest, openingLine.end)
    if (opening.marker === '`' && info.includes('`')) {
      lineStart = openingLine.next
      continue
    }

    const contentStart = openingLine.next
    let closingLineStart = contentStart
    let closingLine: MarkdownLine | null = null
    while (closingLineStart < source.length) {
      const candidate = markdownLineAt(source, closingLineStart)
      if (isClosingFence(source, candidate, opening.marker, opening.markerLength)) {
        closingLine = candidate
        break
      }
      closingLineStart = candidate.next
    }

    yield {
      marker: opening.marker,
      markerLength: opening.markerLength,
      info,
      content: source.slice(contentStart, closingLine?.start ?? source.length),
      closed: closingLine !== null
    }
    if (!closingLine) return
    lineStart = closingLine.next
  }
}

type LineRange = [from: number, to: number]

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const parseAttributes = (source: string, decodeAttribute: (value: string) => string): Record<string, string> => {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(FENCE_ATTRIBUTE)) {
    const key = match[1]
    const value = match[2] ?? match[3] ?? match[4]
    if (key !== undefined && value !== undefined) attributes[key.toLowerCase()] = decodeAttribute(value)
  }
  return attributes
}

const safeLineNumber = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const parseLineRanges = (value: string): LineRange[] => {
  const ranges: LineRange[] = []
  for (const entry of value.split(',')) {
    const match = LINE_RANGE.exec(entry.trim())
    if (!match?.[1]) continue
    const first = safeLineNumber(match[1])
    const second = match[2] === undefined ? first : safeLineNumber(match[2])
    if (first === null || second === null) continue
    ranges.push([Math.min(first, second), Math.max(first, second)])
  }
  ranges.sort(([leftFrom, leftTo], [rightFrom, rightTo]) => leftFrom - rightFrom || leftTo - rightTo)
  const merged: LineRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], range[1])
    } else {
      merged.push([...range])
    }
  }
  return merged
}

const serializeLineRanges = (ranges: readonly LineRange[]): string => ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(',')

const logicalLineCount = (source: string): number => {
  const content = source.endsWith('\n') ? source.slice(0, -1) : source
  return content.length === 0 ? 1 : content.split('\n').length
}

export const parseMarkdownCodeFenceInfo = (info = '', decodeInfo: (value: string) => string = value => value): MarkdownCodeFenceMetadata => {
  const normalized = info.trim()
  const boundary = normalized.search(/\s/)
  const language = decodeInfo(boundary < 0 ? normalized : normalized.slice(0, boundary))
  const attributes = parseAttributes(boundary < 0 ? '' : normalized.slice(boundary + 1), decodeInfo)
  const requestedStart = safeLineNumber(attributes.linesstart?.trim() ?? '')
  return {
    language,
    title: (attributes.title ?? '').trim(),
    lineStart: requestedStart ?? 1,
    lineHighlights: serializeLineRanges(parseLineRanges(attributes.lineshighlight ?? ''))
  }
}

export const renderMarkdownCodeFence = ({
  source,
  info = '',
  sourceLine,
  decodeDiagram = value => value,
  unescape: decodeInfo = value => value
}: MarkdownCodeFenceRenderOptions): string => {
  const metadata = parseMarkdownCodeFenceInfo(info, decodeInfo)
  const sourceMarker = Number.isSafeInteger(sourceLine) && (sourceLine ?? -1) >= 0 ? ` data-source-line="${sourceLine}"` : ''

  if (metadata.language === 'diagram') {
    return `<pre class="diagram"${sourceMarker}>${decodeDiagram(source)}</pre>\n`
  }
  if (metadata.language === 'mermaid' || metadata.language === 'plantuml') {
    return `<pre class="codeblock-${metadata.language}"${sourceMarker}><code>${escapeHtml(source)}</code></pre>\n`
  }

  const language = metadata.language || 'none'
  const numbered = logicalLineCount(source) > 1 || metadata.lineStart !== 1
  const classes = ['prismjs', `language-${escapeHtml(language)}`]
  if (numbered) classes.push('line-numbers')
  const start = numbered && metadata.lineStart !== 1 ? ` data-start="${metadata.lineStart}" data-line-offset="${metadata.lineStart - 1}"` : ''
  const highlights = metadata.lineHighlights ? ` data-line="${metadata.lineHighlights}"` : ''
  const pre = `<pre class="${classes.join(' ')}"${sourceMarker}${start}${highlights}><code class="language-${escapeHtml(language)}">${escapeHtml(source)}</code></pre>`
  if (!metadata.title) return `${pre}\n`
  return `<figure class="codeblock-framed"${sourceMarker}><figcaption class="codeblock-title">${escapeHtml(metadata.title)}</figcaption>${pre.replace(sourceMarker, '')}</figure>\n`
}
