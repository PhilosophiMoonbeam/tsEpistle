import MarkdownIt from 'markdown-it'
import type { StateInline, Token } from 'markdown-it'
import { parseWikiLinkAt, resolveWikiLinkHref, type WikiLink } from '../../shared/wikilinks.ts'

export interface PageMoveLinkRewriteInput {
  readonly source: string
  readonly editor: string
  readonly oldTarget: { readonly locale: string; readonly path: string }
  readonly newTarget: { readonly locale: string; readonly path: string }
  readonly sourcePage: { readonly locale: string; readonly path: string }
  readonly namespaced: boolean
  readonly absoluteLinks: boolean
  readonly wikiLinksEnabled: boolean
}

export interface PageMoveLinkRewriteResult {
  readonly source: string
  readonly changes: readonly { readonly before: string; readonly after: string }[]
  readonly unsupported: number
}

interface SourceEdit {
  readonly start: number
  readonly end: number
  readonly before: string
  readonly after: string
}

interface CapturedLink {
  readonly kind: 'markdown' | 'wiki'
  readonly href: string
  readonly start: number
  readonly end: number
  readonly marker: string
  readonly markerHref?: string
  readonly targetStart?: number
  readonly targetEnd?: number
  readonly wiki?: WikiLink
}

interface LinkDestinationResult {
  readonly ok: boolean
  readonly pos: number
  readonly str: string
}

type LinkDestinationParser = (source: string, pos: number, maximum: number) => LinkDestinationResult

type RouteStatus = 'other' | 'match' | 'unsupported'

const LOCALE_SHAPE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu
// biome-ignore lint/suspicious/noControlCharactersInRegex: mirror the page route parser's exact unsafe-character set.
const UNSAFE_ROUTE_CHARACTERS = /[\x00-\x1f\x7f-\x9f\\"|<>:*?]/u
const MARKDOWN_PUNCTUATION: Readonly<Record<string, true>> = {
  '!': true,
  '"': true,
  '#': true,
  '$': true,
  '%': true,
  '&': true,
  "'": true,
  '(': true,
  ')': true,
  '*': true,
  '+': true,
  ',': true,
  '-': true,
  '.': true,
  '/': true,
  ':': true,
  ';': true,
  '<': true,
  '=': true,
  '>': true,
  '?': true,
  '@': true,
  '[': true,
  '\\': true,
  ']': true,
  '^': true,
  '_': true,
  '`': true,
  '{': true,
  '|': true,
  '}': true,
  '~': true
}

const NO_CHANGES: readonly { readonly before: string; readonly after: string }[] = Object.freeze([])

const unchanged = (source: string): PageMoveLinkRewriteResult => ({ source, changes: NO_CHANGES, unsupported: 0 })

const equalLocale = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

const validPagePath = (path: string): boolean => {
  if (!path || path.startsWith('/') || path.endsWith('/') || path.trimEnd() !== path || path.includes('\\')) return false
  try {
    for (const segment of path.split('/')) {
      if (
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /\.{2,}/u.test(segment) ||
        UNSAFE_ROUTE_CHARACTERS.test(segment)
      ) return false
      encodeURIComponent(segment)
    }
    return true
  } catch {
    return false
  }
}

const targetIsUsable = (target: { readonly locale: string; readonly path: string }): boolean =>
  LOCALE_SHAPE.test(target.locale) && validPagePath(target.path)

const encodedPagePath = (path: string): string | null => {
  try {
    return path.split('/').map(segment => encodeURIComponent(segment).replace(/\./gu, '%2E')).join('/')
  } catch {
    return null
  }
}

const canonicalTargetRoute = (
  target: { readonly locale: string; readonly path: string },
  sourceLocale: string,
  namespaced: boolean
): string | null => {
  if (!targetIsUsable(target)) return null
  const encodedPath = encodedPagePath(target.path)
  if (encodedPath === null) return null
  const localePrefix = namespaced || !equalLocale(target.locale, sourceLocale)
    ? `/${encodeURIComponent(target.locale)}`
    : ''
  return `${localePrefix}/${encodedPath}`
}

const splitSuffix = (value: string): { readonly path: string; readonly suffix: string } => {
  const query = value.indexOf('?')
  const fragment = value.indexOf('#')
  let suffixStart = value.length
  if (query >= 0) suffixStart = query
  if (fragment >= 0 && fragment < suffixStart) suffixStart = fragment
  return { path: value.slice(0, suffixStart), suffix: value.slice(suffixStart) }
}

const isLocaleSegment = (segment: string, sourceLocale: string, targetLocale: string): boolean =>
  equalLocale(segment, sourceLocale) ||
  equalLocale(segment, targetLocale) ||
  /^[a-z]{2}(?:-[a-z]{2})?$/iu.test(segment)

const parseRouteSegments = (
  href: string,
  sourcePage: { readonly locale: string; readonly path: string },
  targetLocale: string,
  namespaced: boolean,
  absoluteLinks: boolean
): { readonly segments: string[]; readonly path: string; readonly lossy: boolean } | null => {
  if (!href || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(href)) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: route control bytes are rejected before URL identity comparison.
  if (/[\x00-\x1f\x7f-\x9f\\]/u.test(href)) return null

  const { path: hrefPath } = splitSuffix(href)
  if (!hrefPath) return null
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(hrefPath)
  } catch {
    return null
  }
  if (decodedPath.startsWith('//') || decodedPath.includes('\\')) return null

  const rooted = hrefPath.startsWith('/')
  const authoredSegments = decodedPath.replace(/^\//u, '').split('/')
  if (authoredSegments.some(segment => segment.length === 0)) return null

  let segments: string[]
  if (rooted) {
    segments = authoredSegments
    const first = segments[0] ?? ''
    const explicitLocale = isLocaleSegment(first, sourcePage.locale, targetLocale)
    if (namespaced && !explicitLocale) segments = [sourcePage.locale, ...segments]
  } else if (namespaced) {
    const base = absoluteLinks || sourcePage.path === 'home' ? [] : sourcePage.path.split('/')
    segments = [sourcePage.locale, ...base, ...authoredSegments]
  } else {
    const base = absoluteLinks || sourcePage.path === 'home' ? [] : sourcePage.path.split('/')
    segments = [...base, ...authoredSegments]
  }

  return {
    segments,
    path: hrefPath,
    lossy: /%(?:2f|5c)/iu.test(hrefPath) || segments.some(segment => /\.{2,}/u.test(segment))
  }
}

const identityFromSegments = (
  segments: readonly string[],
  sourceLocale: string,
  targetLocale: string
): { readonly locale: string; readonly path: string } | null => {
  if (segments.length === 0 || segments.some(segment => segment.length === 0)) return null
  let locale = sourceLocale
  let pageSegments = [...segments]
  const first = pageSegments[0] ?? ''
  if (isLocaleSegment(first, sourceLocale, targetLocale)) {
    locale = first
    pageSegments = pageSegments.slice(1)
  }
  if (pageSegments.length === 0) return null
  return { locale, path: pageSegments.join('/') }
}

const identityMatches = (
  identity: { readonly locale: string; readonly path: string } | null,
  target: { readonly locale: string; readonly path: string }
): boolean => identity !== null && equalLocale(identity.locale, target.locale) && identity.path === target.path

const looselyMatchesAfterRendererSanitizing = (
  href: string,
  sourcePage: { readonly locale: string; readonly path: string },
  target: { readonly locale: string; readonly path: string },
  namespaced: boolean,
  absoluteLinks: boolean
): boolean => {
  if (!href || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(href)) return false
  const { path } = splitSuffix(href)
  if (!path) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return false
  }

  // This deliberately mirrors only the lossy route cleanup which must not be used as rewrite authority.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: emulate parser cleanup only to report an unsafe candidate.
  decoded = decoded.trim().replace(/[\x00-\x1f\x80-\x9f"|<>:*?]/u, '').replace(/\\/gu, '').replace(/\/\//gu, '').replace(/\.{2,}/giu, '')
  const rooted = decoded.startsWith('/')
  let route = decoded.replace(/^\//u, '')
  if (!rooted && !absoluteLinks && sourcePage.path !== 'home') route = `${sourcePage.path}/${route}`
  if (namespaced && !rooted) route = `${sourcePage.locale}/${route}`
  else if (namespaced && rooted) {
    const first = route.split('/')[0] ?? ''
    if (!isLocaleSegment(first, sourcePage.locale, target.locale)) route = `${sourcePage.locale}/${route}`
  }
  const parts = route.split('/').map(segment => segment.trim()).filter(segment => segment !== '' && segment !== '.' && segment !== '..')
  if ((parts[0]?.length ?? 0) === 1) parts.shift()
  return identityMatches(identityFromSegments(parts, sourcePage.locale, target.locale), target)
}

const classifyHref = (
  href: string,
  sourcePage: { readonly locale: string; readonly path: string },
  target: { readonly locale: string; readonly path: string },
  namespaced: boolean,
  absoluteLinks: boolean
): RouteStatus => {
  const route = parseRouteSegments(href, sourcePage, target.locale, namespaced, absoluteLinks)
  if (route !== null) {
    const firstPageSegment = route.segments[0] ?? ''
    const hasLiteralDot = route.path.includes('.')
    const hasSystemPrefix = /^\/[a-z](?:\/|$)/iu.test(href)
    const validSegments = route.segments.every(segment =>
      segment !== '.' &&
      segment !== '..' &&
      !/\.{2,}/u.test(segment) &&
      !UNSAFE_ROUTE_CHARACTERS.test(segment) &&
      !segment.includes('/')
    )
    const identity = identityFromSegments(route.segments, sourcePage.locale, target.locale)
    if (identityMatches(identity, target)) {
      return hasLiteralDot || hasSystemPrefix || firstPageSegment.length === 1 || route.lossy || !validSegments
        ? 'unsupported'
        : 'match'
    }
    return looselyMatchesAfterRendererSanitizing(href, sourcePage, target, namespaced, absoluteLinks)
      ? 'unsupported'
      : 'other'
  }
  return looselyMatchesAfterRendererSanitizing(href, sourcePage, target, namespaced, absoluteLinks)
    ? 'unsupported'
    : 'other'
}
const sourceLineData = (source: string): { readonly starts: number[]; readonly lines: string[] } => {
  const starts = [0]
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 0x0a) continue
    const end = index > start && source.charCodeAt(index - 1) === 0x0d ? index - 1 : index
    lines.push(source.slice(start, end))
    start = index + 1
    starts.push(start)
  }
  lines.push(source.slice(start))
  return { starts, lines }
}

interface InlineSourceLine {
  readonly localStart: number
  readonly localEnd: number
  readonly sourceStart: number | null
}

const inlineSourceMapping = (
  content: string,
  lineMap: readonly number[] | null,
  sourceLines: readonly string[],
  sourceLineStarts: readonly number[]
): readonly InlineSourceLine[] | null => {
  if (lineMap === null) return null
  const [firstLine, lastLine] = lineMap
  if (firstLine === undefined || lastLine === undefined) return null
  const mapping: InlineSourceLine[] = []
  let localStart = 0
  let localLine = 0
  while (localStart <= content.length) {
    let lineBreak = localStart
    while (lineBreak < content.length && content.charCodeAt(lineBreak) !== 0x0a) lineBreak += 1
    let localEnd = lineBreak
    if (localEnd > localStart && content.charCodeAt(localEnd - 1) === 0x0d) localEnd -= 1
    const line = content.slice(localStart, localEnd)
    const sourceLineIndex = firstLine + localLine
    let sourceStart: number | null = null
    if (line && sourceLineIndex < lastLine) {
      const originalLine = sourceLines[sourceLineIndex] ?? ''
      const column = originalLine.indexOf(line)
      if (column >= 0 && originalLine.indexOf(line, column + 1) < 0) {
        sourceStart = (sourceLineStarts[sourceLineIndex] ?? 0) + column
      }
    }
    mapping.push({ localStart, localEnd, sourceStart })
    if (lineBreak >= content.length) break
    localStart = lineBreak + 1
    localLine += 1
  }
  return mapping
}

const inlineSourceRange = (
  start: number,
  end: number,
  mapping: readonly InlineSourceLine[] | null
): { readonly start: number; readonly end: number } | null => {
  if (mapping === null || start < 0 || end < start) return null
  let low = 0
  let high = mapping.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if ((mapping[middle]?.localStart ?? Number.POSITIVE_INFINITY) <= start) low = middle
    else high = middle
  }
  const line = mapping[low]
  if (!line || line.sourceStart === null || start < line.localStart || end > line.localEnd) return null
  const sourceStart = line.sourceStart + (start - line.localStart)
  return { start: sourceStart, end: sourceStart + (end - start) }
}

const sourceEditsResult = (source: string, edits: SourceEdit[], unsupported: number): PageMoveLinkRewriteResult => {
  if (edits.length === 0) return { source, changes: NO_CHANGES, unsupported }
  edits.sort((left, right) => left.start - right.start || left.end - right.end)
  const nonoverlapping: SourceEdit[] = []
  let lastEnd = -1
  for (const edit of edits) {
    if (edit.start < lastEnd) {
      unsupported += 1
      continue
    }
    nonoverlapping.push(edit)
    lastEnd = edit.end
  }
  const pieces: string[] = []
  let sourceEnd = source.length
  for (let index = nonoverlapping.length - 1; index >= 0; index -= 1) {
    const edit = nonoverlapping[index]
    if (!edit) continue
    pieces.push(source.slice(edit.end, sourceEnd), edit.after)
    sourceEnd = edit.start
  }
  pieces.push(source.slice(0, sourceEnd))
  pieces.reverse()
  const rewritten = pieces.join('')
  return {
    source: rewritten,
    changes: nonoverlapping.map(edit => ({ before: edit.before, after: edit.after })),
    unsupported
  }
}


const escapeMarkdownLabel = (text: string): string => {
  let escaped = ''
  for (const character of text) escaped += MARKDOWN_PUNCTUATION[character] === true ? `\\${character}` : character
  return escaped
}

const rewriteWikiLink = (
  capture: CapturedLink,
  sourcePage: { readonly locale: string; readonly path: string },
  input: PageMoveLinkRewriteInput
): { readonly start: number; readonly end: number; readonly replacement: string } | null => {
  const wiki = capture.wiki
  if (!wiki) return null
  const movedPageIsSource = equalLocale(sourcePage.locale, input.oldTarget.locale) && sourcePage.path === input.oldTarget.path
  const newSourceLocale = movedPageIsSource ? input.newTarget.locale : sourcePage.locale
  const fragment = wiki.fragment === null ? '' : `#${wiki.fragment}`
  const destination = canonicalTargetRoute(input.newTarget, newSourceLocale, input.namespaced)
  if (destination === null) return null

  if (equalLocale(input.newTarget.locale, newSourceLocale)) {
    const newAuthoredTarget = `/${input.newTarget.path}${fragment}`
    const newWikiSource = wiki.label === null
      ? `[[${newAuthoredTarget}|${wiki.text}]]`
      : `[[${newAuthoredTarget}|${wiki.label}]]`
    if (parseWikiLinkAt(newWikiSource) !== null) {
      return wiki.label === null
        ? { start: capture.start, end: capture.end, replacement: newWikiSource }
        : {
            start: capture.targetStart ?? capture.start,
            end: capture.targetEnd ?? capture.end,
            replacement: newAuthoredTarget
          }
    }
  }

  const encodedFragment = wiki.fragment === null ? '' : `#${encodeURIComponent(wiki.fragment)}`
  return {
    start: capture.start,
    end: capture.end,
    replacement: `[${escapeMarkdownLabel(wiki.text)}](<${destination}${encodedFragment}>)`
  }
}

// MarkdownIt tokens retain destinations but not source-node identity; carry a parser-only marker so equal hrefs remain distinct.
const withDestinationCaptureMarker = (destination: string, marker: string): string => {
  const fragmentStart = destination.indexOf('#')
  const destinationEnd = fragmentStart < 0 ? destination.length : fragmentStart
  const query = destination.slice(0, destinationEnd)
  const separator = query.includes('?') ? '&' : '?'
  return `${query}${separator}__omp_page_move_capture=${marker}${destination.slice(destinationEnd)}`
}

const markdownRewrite = (input: PageMoveLinkRewriteInput): PageMoveLinkRewriteResult => {
  const source = input.source
  if (!source.includes('[')) return unchanged(source)

  const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false })
  const env: Record<string, unknown> = {}
  const blockTokens: Token[] = []
  markdown.block.parse(source, markdown, env, blockTokens)
  const sourceLines = sourceLineData(source)
  let unsupported = 0
  const edits: SourceEdit[] = []
  const captures: CapturedLink[] = []
  const wikiContext = {
    locale: input.sourcePage.locale,
    pagePath: input.sourcePage.path,
    namespaced: input.namespaced
  }

  if (input.wikiLinksEnabled) {
    markdown.inline.ruler.before('link', 'page_move_wiki_link', (state: StateInline, silent: boolean) => {
      if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) return false
      const wiki = parseWikiLinkAt(state.src.slice(state.pos, state.posMax))
      if (!wiki) return false
      const start = state.pos
      const end = start + wiki.raw.length
      const href = resolveWikiLinkHref(wiki, wikiContext)
      if (!silent && href !== null) {
        const marker = `wiki-${captures.length}`
        const linkOpen = state.push('link_open', 'a', 1)
        linkOpen.attrSet('href', href)
        linkOpen.attrSet('data-omp-page-move-capture', marker)
        state.push('text', '', 0).content = wiki.text
        state.push('link_close', 'a', -1)
        const targetStart = start + 2
        const targetEnd = targetStart + wiki.authoredTarget.length
        const captured: CapturedLink = { kind: 'wiki', href, start, end, marker, targetStart, targetEnd, wiki }
        captures.push(captured)
      } else if (!silent && href === null) {
        state.pending += wiki.raw
      }
      state.pos = end
      return true
    })
  }
  const originalDestinationParser = markdown.helpers.parseLinkDestination as unknown as LinkDestinationParser
  const wrappedDestinationParser: LinkDestinationParser = (inlineSource, pos, maximum) => {
    const result = originalDestinationParser(inlineSource, pos, maximum)
    if (result.ok) {
      const angled = inlineSource.charCodeAt(pos) === 0x3c
      const start = pos + (angled ? 1 : 0)
      const end = angled ? result.pos - 1 : result.pos
      if (start >= 0 && end >= start && end <= inlineSource.length) {
        try {
          const href = markdown.normalizeLink(result.str)
          if (classifyHref(href, input.sourcePage, input.oldTarget, input.namespaced, input.absoluteLinks) !== 'other') {
            const marker = `markdown-${captures.length}`
            const markedDestination = withDestinationCaptureMarker(result.str, marker)
            captures.push({
              kind: 'markdown',
              href,
              start,
              end,
              marker,
              markerHref: markdown.normalizeLink(markedDestination)
            })
            return { ...result, str: markedDestination }
          }
        } catch {
          // An unnormalizable parser destination has no safe rewrite identity.
        }
      }
    }
    return result
  }
  markdown.helpers.parseLinkDestination = wrappedDestinationParser as typeof markdown.helpers.parseLinkDestination

  for (let tokenIndex = 0; tokenIndex < blockTokens.length; tokenIndex += 1) {
    const blockToken = blockTokens[tokenIndex]
    if (blockToken?.type === 'html_block') {
      const htmlCandidates = htmlRewrite({ ...input, source: blockToken.content })
      unsupported += htmlCandidates.changes.length + htmlCandidates.unsupported
      continue
    }
    if (blockToken?.type !== 'inline') continue
    const inlineToken = blockToken
    const inlineCaptures: CapturedLink[] = []
    captures.length = 0
    const children: Token[] = []
    markdown.inline.parse(inlineToken.content, markdown, env, children)
    inlineCaptures.push(...captures)
    inlineToken.children = children

    let parentMap: readonly number[] | null = null
    for (let parentIndex = tokenIndex - 1; parentIndex >= 0; parentIndex -= 1) {
      const parent = blockTokens[parentIndex]
      if (!parent?.type.endsWith('_open')) continue
      parentMap = parent.map
      break
    }
    for (const child of children) {
      if (child.type !== 'html_inline') continue
      const htmlCandidates = htmlRewrite({ ...input, source: child.content })
      unsupported += htmlCandidates.changes.length + htmlCandidates.unsupported
    }
    const sourceMapping = inlineSourceMapping(inlineToken.content, parentMap, sourceLines.lines, sourceLines.starts)

    const captureIndexByMarker = new Map<string, number>()
    for (let index = 0; index < inlineCaptures.length; index += 1) {
      const capture = inlineCaptures[index]
      if (!capture) continue
      let key: string
      if (capture.kind === 'wiki') key = `wiki:${capture.marker}`
      else if (capture.markerHref !== undefined) key = `markdown:${capture.markerHref}`
      else continue
      captureIndexByMarker.set(key, index)
    }
    const consumed = new Set<number>()
    for (const child of children) {
      if (child.type !== 'link_open') continue
      const attrHref = child.attrGet('href')
      const href = typeof attrHref === 'string' ? attrHref : ''
      const marker = child.attrGet('data-omp-page-move-capture')
      const key = typeof marker === 'string' ? `wiki:${marker}` : `markdown:${href}`
      let captureIndex = captureIndexByMarker.get(key) ?? -1
      if (consumed.has(captureIndex)) captureIndex = -1

      if (captureIndex < 0) {
        if (classifyHref(href, input.sourcePage, input.oldTarget, input.namespaced, input.absoluteLinks) !== 'other') unsupported += 1
        continue
      }
      consumed.add(captureIndex)
      const capture = inlineCaptures[captureIndex]
      if (!capture) continue
      const status = classifyHref(capture.href, input.sourcePage, input.oldTarget, input.namespaced, input.absoluteLinks)
      if (status === 'unsupported') {
        unsupported += 1
        continue
      }
      if (status !== 'match') continue

      const localRange = capture.kind === 'wiki'
        ? rewriteWikiLink(capture, input.sourcePage, input)
        : { start: capture.start, end: capture.end, replacement: '' }
      if (localRange === null) {
        unsupported += 1
        continue
      }
      if (capture.kind === 'markdown') {
        const beforeInInline = inlineToken.content.slice(capture.start, capture.end)
        const afterRoute = canonicalTargetRoute(input.newTarget, input.sourcePage.locale, input.namespaced)
        if (afterRoute === null) {
          unsupported += 1
          continue
        }
        const mapped = inlineSourceRange(capture.start, capture.end, sourceMapping)
        if (mapped === null) {
          unsupported += 1
          continue
        }
        edits.push({
          start: mapped.start,
          end: mapped.end,
          before: source.slice(mapped.start, mapped.end),
          after: `${afterRoute}${splitSuffix(beforeInInline).suffix}`
        })
        continue
      }
      const mapped = inlineSourceRange(localRange.start, localRange.end, sourceMapping)
      if (mapped === null) {
        unsupported += 1
        continue
      }
      edits.push({
        start: mapped.start,
        end: mapped.end,
        before: source.slice(mapped.start, mapped.end),
        after: localRange.replacement
      })
    }

    for (let captureIndex = 0; captureIndex < inlineCaptures.length; captureIndex += 1) {
      if (consumed.has(captureIndex)) continue
      const capture = inlineCaptures[captureIndex]
      if (!capture || capture.kind !== 'wiki') continue
      if (classifyHref(capture.href, input.sourcePage, input.oldTarget, input.namespaced, input.absoluteLinks) === 'match') unsupported += 1
    }
  }

  markdown.helpers.parseLinkDestination = originalDestinationParser as typeof markdown.helpers.parseLinkDestination
  return sourceEditsResult(source, edits, unsupported)
}

interface HtmlAttribute {
  readonly name: string
  readonly valueStart: number | null
  readonly valueEnd: number | null
  readonly value: string | null
  readonly quoted: boolean
}

interface HtmlTag {
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
  readonly end: number
  readonly attributes: readonly HtmlAttribute[]
  readonly valid: boolean
}

const isHtmlSpace = (character: number): boolean =>
  character === 0x09 || character === 0x0a || character === 0x0c || character === 0x0d || character === 0x20

const isHtmlNameEnd = (character: number): boolean =>
  character === 0x3e || character === 0x2f || character === 0x3d || isHtmlSpace(character)

const scanTag = (source: string, start: number): HtmlTag | null => {
  let cursor = start + 1
  let closing = false
  if (source.charCodeAt(cursor) === 0x2f) {
    closing = true
    cursor += 1
  }
  const nameStart = cursor
  while (cursor < source.length && !isHtmlNameEnd(source.charCodeAt(cursor))) cursor += 1
  if (cursor === nameStart || !/[a-z]/iu.test(source[nameStart] ?? '')) return null
  const name = source.slice(nameStart, cursor).toLowerCase()
  const attributes: HtmlAttribute[] = []
  let valid = true
  let selfClosing = false

  if (closing) {
    while (cursor < source.length && source.charCodeAt(cursor) !== 0x3e) cursor += 1
    if (cursor >= source.length) return { name, closing, selfClosing, end: source.length, attributes, valid: false }
    return { name, closing, selfClosing, end: cursor + 1, attributes, valid: true }
  }

  while (cursor < source.length) {
    while (isHtmlSpace(source.charCodeAt(cursor))) cursor += 1
    const character = source.charCodeAt(cursor)
    if (character === 0x3e) return { name, closing, selfClosing, end: cursor + 1, attributes, valid }
    if (character === 0x2f) {
      selfClosing = true
      cursor += 1
      while (isHtmlSpace(source.charCodeAt(cursor))) cursor += 1
      if (source.charCodeAt(cursor) === 0x3e) return { name, closing, selfClosing, end: cursor + 1, attributes, valid }
      valid = false
      continue
    }
    if (cursor >= source.length) break

    const attributeStart = cursor
    while (cursor < source.length && !isHtmlNameEnd(source.charCodeAt(cursor))) cursor += 1
    if (cursor === attributeStart) {
      valid = false
      cursor += 1
      continue
    }
    const attributeName = source.slice(attributeStart, cursor).toLowerCase()
    while (isHtmlSpace(source.charCodeAt(cursor))) cursor += 1
    let valueStart: number | null = null
    let valueEnd: number | null = null
    let value: string | null = null
    let quoted = false
    if (source.charCodeAt(cursor) === 0x3d) {
      cursor += 1
      while (isHtmlSpace(source.charCodeAt(cursor))) cursor += 1
      const quote = source.charCodeAt(cursor)
      if (quote === 0x22 || quote === 0x27) {
        quoted = true
        valueStart = cursor + 1
        cursor += 1
        while (cursor < source.length && source.charCodeAt(cursor) !== quote) cursor += 1
        if (cursor >= source.length) {
          valid = false
          break
        }
        valueEnd = cursor
        value = source.slice(valueStart, valueEnd)
        cursor += 1
      } else {
        valueStart = cursor
        while (cursor < source.length && !isHtmlSpace(source.charCodeAt(cursor)) && source.charCodeAt(cursor) !== 0x3e) cursor += 1
        valueEnd = cursor
        value = source.slice(valueStart, valueEnd)
      }
    }
    attributes.push({ name: attributeName, valueStart, valueEnd, value, quoted })
  }
  return { name, closing, selfClosing, end: source.length, attributes, valid: false }
}

const closingTagIndex = (source: string, from: number, name: string): number => {
  const lowerName = name.toLowerCase()
  for (let index = from; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 0x3c || source.charCodeAt(index + 1) !== 0x2f) continue
    let matched = true
    for (let offset = 0; offset < lowerName.length; offset += 1) {
      const character = source[index + 2 + offset]
      if (character?.toLowerCase() !== lowerName[offset]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    const boundary = source.charCodeAt(index + 2 + lowerName.length)
    if (boundary === 0x3e || boundary === 0x2f || isHtmlSpace(boundary)) return index
  }
  return -1
}

const htmlHrefCandidate = (
  href: string,
  sourcePage: { readonly locale: string; readonly path: string },
  input: PageMoveLinkRewriteInput
): RouteStatus => {
  const { path } = splitSuffix(href)
  if (/&(?:#|[a-z0-9])/iu.test(path)) {
    return looselyMatchesAfterRendererSanitizing(href, sourcePage, input.oldTarget, input.namespaced, input.absoluteLinks)
      ? 'unsupported'
      : 'other'
  }
  return classifyHref(href, sourcePage, input.oldTarget, input.namespaced, input.absoluteLinks)
}

const htmlRewrite = (input: PageMoveLinkRewriteInput): PageMoveLinkRewriteResult => {
  const source = input.source
  if (!source.includes('<')) return unchanged(source)
  const edits: SourceEdit[] = []
  let unsupported = 0
  let cursor = 0
  let codeDepth = 0

  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const commentEnd = source.indexOf('-->', cursor + 4)
      if (commentEnd < 0) break
      cursor = commentEnd + 3
      continue
    }
    if (source.charCodeAt(cursor) !== 0x3c) {
      cursor += 1
      continue
    }
    if (source.startsWith('<![CDATA[', cursor)) {
      const cdataEnd = source.indexOf(']]>', cursor + 9)
      if (cdataEnd < 0) break
      cursor = cdataEnd + 3
      continue
    }
    if (source.charCodeAt(cursor + 1) === 0x21 || source.charCodeAt(cursor + 1) === 0x3f) {
      let quote = 0
      let bracketDepth = 0
      cursor += 2
      while (cursor < source.length) {
        const character = source.charCodeAt(cursor)
        if (quote !== 0) {
          if (character === quote) quote = 0
        } else if (character === 0x22 || character === 0x27) quote = character
        else if (character === 0x5b) bracketDepth += 1
        else if (character === 0x5d && bracketDepth > 0) bracketDepth -= 1
        else if (character === 0x3e && bracketDepth === 0) {
          cursor += 1
          break
        }
        cursor += 1
      }
      continue
    }

    const tag = scanTag(source, cursor)
    if (tag === null) {
      cursor += 1
      continue
    }
    cursor = tag.end
    if (tag.name === 'plaintext') break
    if (
      tag.name === 'script' ||
      tag.name === 'style' ||
      tag.name === 'textarea' ||
      tag.name === 'title' ||
      tag.name === 'xmp' ||
      tag.name === 'iframe' ||
      tag.name === 'noembed' ||
      tag.name === 'noframes'
    ) {
      if (!tag.closing && !tag.selfClosing) {
        const closeAt = closingTagIndex(source, cursor, tag.name)
        if (closeAt < 0) break
        const closeTag = scanTag(source, closeAt)
        cursor = closeTag?.end ?? source.length
      }
      continue
    }

    if (tag.name === 'pre' || tag.name === 'code') {
      if (tag.closing) codeDepth = Math.max(0, codeDepth - 1)
      else if (!tag.selfClosing) codeDepth += 1
      continue
    }
    if (codeDepth > 0 || tag.closing || tag.name !== 'a') continue

    const hrefAttributes = tag.attributes.filter(attribute => attribute.name === 'href')
    if (hrefAttributes.length === 0) continue
    if (hrefAttributes.length !== 1 || !tag.valid) {
      if (hrefAttributes.some(attribute => attribute.value !== null && htmlHrefCandidate(attribute.value, input.sourcePage, input) !== 'other')) unsupported += 1
      continue
    }
    const attribute = hrefAttributes[0]
    if (!attribute || attribute.value === null) continue
    const status = htmlHrefCandidate(attribute.value, input.sourcePage, input)
    if (status === 'unsupported') {
      unsupported += 1
      continue
    }
    if (status !== 'match' || !attribute.quoted || attribute.valueStart === null || attribute.valueEnd === null) {
      if (status === 'match') unsupported += 1
      continue
    }
    const afterRoute = canonicalTargetRoute(input.newTarget, input.sourcePage.locale, input.namespaced)
    if (afterRoute === null) {
      unsupported += 1
      continue
    }
    const before = source.slice(attribute.valueStart, attribute.valueEnd)
    edits.push({
      start: attribute.valueStart,
      end: attribute.valueEnd,
      before,
      after: `${afterRoute}${splitSuffix(before).suffix}`
    })
  }

  return sourceEditsResult(source, edits, unsupported)
}

export const rewriteMovedPageLinks = (input: PageMoveLinkRewriteInput): PageMoveLinkRewriteResult => {
  if (!input.source || !targetIsUsable(input.oldTarget) || !targetIsUsable(input.newTarget) || !targetIsUsable(input.sourcePage)) {
    return unchanged(input.source)
  }
  if (input.editor === 'markdown' || input.editor === 'visual-markdown') return markdownRewrite(input)
  if (input.editor === 'ckeditor' || input.editor === 'html') return htmlRewrite(input)
  return unchanged(input.source)
}
