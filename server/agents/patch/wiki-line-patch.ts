import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { z } from 'zod'

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_SOURCE_LINES = 20_000
const MAX_DISCLOSED_LINES = 5_000
const MAX_PATCH_OPERATIONS = 1_000
const TOKEN_VERSION = 'wiki-line-snapshot-token-v1'
export const WIKI_LINE_PATCH_ENGINE_VERSION = 1
export const WIKI_LINE_DIFF_RENDERER_VERSION = 1

const LineAnchorSchema = z.strictObject({
  line: z.number().int().positive(),
  tag: z.string().regex(/^[a-f0-9]{12}$/)
})
const LineRangeSchema = z.strictObject({ startLine: z.number().int().positive(), endLine: z.number().int().positive() })
const InsertOperationSchema = z.strictObject({
  kind: z.literal('insert'),
  gap: z.strictObject({ after: LineAnchorSchema.nullable(), before: LineAnchorSchema.nullable() }),
  lines: z.array(z.string()).min(1).max(5_000)
})
const ReplaceOperationSchema = z.strictObject({
  kind: z.literal('replace'),
  range: z.strictObject({ start: LineAnchorSchema, end: LineAnchorSchema }),
  lines: z.array(z.string()).min(1).max(5_000)
})
const DeleteOperationSchema = z.strictObject({
  kind: z.literal('delete'),
  range: z.strictObject({ start: LineAnchorSchema, end: LineAnchorSchema })
})

export const WikiLinePatchV1Schema = z.strictObject({
  version: z.literal('wiki-line-patch-v1'),
  snapshotToken: z.string().min(1).max(16_384),
  baseDocumentTag: z.string().regex(/^[a-f0-9]{12}$/),
  resultFinalNewline: z.boolean(),
  operations: z.array(z.discriminatedUnion('kind', [InsertOperationSchema, ReplaceOperationSchema, DeleteOperationSchema])).min(1).max(MAX_PATCH_OPERATIONS)
})
export type WikiLinePatchV1 = z.infer<typeof WikiLinePatchV1Schema>
export const WikiSourceWarningSchema = z.strictObject({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  codePoint: z.string().regex(/^U\+[A-F0-9]{4,6}$/),
  reason: z.enum(['line-separator', 'bidi-control', 'default-ignorable'])
})
export const WikiLineSnapshotV1Schema = z.strictObject({
  version: z.literal('wiki-line-snapshot-v1'),
  page: z.strictObject({
    id: z.number().int().positive(),
    locale: z.string().min(1).max(35),
    path: z.string().min(1).max(1024),
    contentType: z.literal('markdown')
  }),
  revision: z.strictObject({
    sourceRevision: z.string().min(1).max(64),
    rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
    canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  documentTag: z.string().regex(/^[a-f0-9]{12}$/),
  lineEnding: z.enum(['lf', 'crlf']),
  finalNewline: z.boolean(),
  disclosed: z.array(z.strictObject({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    lines: z.array(z.strictObject({
      number: z.number().int().positive(),
      tag: z.string().regex(/^[a-f0-9]{12}$/),
      text: z.string().max(MAX_SOURCE_BYTES)
    })).max(MAX_DISCLOSED_LINES)
  })).max(MAX_DISCLOSED_LINES),
  snapshotToken: z.string().min(1).max(16_384),
  expiresAt: z.string().min(20).max(32),
  warnings: z.array(WikiSourceWarningSchema)
})

export interface WikiSourceWarning {
  readonly line: number
  readonly column: number
  readonly codePoint: string
  readonly reason: 'line-separator' | 'bidi-control' | 'default-ignorable'
}

export interface ValidatedWikiMarkdownSource {
  readonly text: string
  readonly bytes: Buffer
  readonly canonicalText: string
  readonly canonicalBytes: Buffer
  readonly lines: readonly string[]
  readonly lineEnding: 'lf' | 'crlf'
  readonly finalNewline: boolean
  readonly rawSha256: string
  readonly canonicalSha256: string
  readonly documentTag: string
  readonly warnings: readonly WikiSourceWarning[]
}

export interface DisclosedLineRange {
  readonly startLine: number
  readonly endLine: number
}

export interface WikiLineSnapshotV1 {
  readonly version: 'wiki-line-snapshot-v1'
  readonly page: { readonly id: number; readonly locale: string; readonly path: string; readonly contentType: 'markdown' }
  readonly revision: { readonly sourceRevision: string; readonly rawSha256: string; readonly canonicalSha256: string }
  readonly documentTag: string
  readonly lineEnding: 'lf' | 'crlf'
  readonly finalNewline: boolean
  readonly disclosed: readonly {
    readonly startLine: number
    readonly endLine: number
    readonly lines: readonly { readonly number: number; readonly tag: string; readonly text: string }[]
  }[]
  readonly snapshotToken: string
  readonly expiresAt: string
  readonly warnings: readonly WikiSourceWarning[]
}

export interface WikiLinePatchResult {
  readonly source: ValidatedWikiMarkdownSource
  readonly patchSha256: string
  readonly diff: string
  readonly diffSha256: string
  readonly disclosedRangesSha256: string
  readonly engineVersion: 1
  readonly diffRendererVersion: 1
}

export class WikiLinePatchError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const TokenPayloadSchema = z.strictObject({
  version: z.literal(TOKEN_VERSION),
  pageId: z.number().int().positive(),
  requesterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().min(1).max(64),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  documentTag: z.string().regex(/^[a-f0-9]{12}$/),
  lineEnding: z.enum(['lf', 'crlf']),
  finalNewline: z.boolean(),
  lineCount: z.number().int().nonnegative().max(MAX_SOURCE_LINES),
  disclosed: z.array(LineRangeSchema).max(MAX_SOURCE_LINES),
  disclosedRangesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAtEpochMs: z.number().int().positive()
})
type TokenPayload = z.infer<typeof TokenPayloadSchema>

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const assertValidUtf16 = (text: string, label: string): void => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new WikiLinePatchError('INVALID_UTF16', `${label} contains a lone high surrogate`)
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new WikiLinePatchError('INVALID_UTF16', `${label} contains a lone low surrogate`)
    }
  }
}

const decodeSource = (source: string | Uint8Array): { readonly text: string; readonly bytes: Buffer } => {
  if (typeof source === 'string') {
    assertValidUtf16(source, 'Markdown source')
    const bytes = Buffer.from(source, 'utf8')
    const roundTrip = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (roundTrip !== source) throw new WikiLinePatchError('INVALID_UTF8', 'Markdown source does not round-trip as UTF-8')
    return { text: source, bytes }
  }
  const bytes = Buffer.from(source)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WikiLinePatchError('INVALID_UTF8', 'Markdown source is not valid UTF-8')
  }
  assertValidUtf16(text, 'Markdown source')
  return { text, bytes }
}

const warningReason = (codePoint: number): WikiSourceWarning['reason'] | null => {
  if (codePoint === 0x85 || codePoint === 0x2028 || codePoint === 0x2029) return 'line-separator'
  if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069) || codePoint === 0x200e || codePoint === 0x200f || codePoint === 0x061c) return 'bidi-control'
  if (
    codePoint === 0x00ad || codePoint === 0x034f || codePoint === 0x061c || codePoint === 0xfeff ||
    (codePoint >= 0x180b && codePoint <= 0x180f) || (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) return 'default-ignorable'
  return null
}

const sourceWarnings = (text: string): readonly WikiSourceWarning[] => {
  const warnings: WikiSourceWarning[] = []
  let line = 1
  let column = 1
  for (const character of text) {
    if (character === '\n') {
      line += 1
      column = 1
      continue
    }
    if (character === '\r') continue
    const codePoint = character.codePointAt(0) as number
    const reason = warningReason(codePoint)
    if (reason) warnings.push({ line, column, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`, reason })
    column += 1
  }
  return warnings
}

export const validateWikiMarkdownSource = (source: string | Uint8Array): ValidatedWikiMarkdownSource => {
  const decoded = decodeSource(source)
  if (decoded.bytes.byteLength > MAX_SOURCE_BYTES) throw new WikiLinePatchError('SOURCE_TOO_LARGE', 'Markdown source exceeds one MiB')
  if (decoded.text.includes('\0')) throw new WikiLinePatchError('SOURCE_CONTAINS_NUL', 'Markdown source contains NUL')

  let lineEnding: 'lf' | 'crlf' = 'lf'
  if (decoded.text.includes('\r')) {
    for (let index = 0; index < decoded.text.length; index += 1) {
      if (decoded.text[index] === '\r' && decoded.text[index + 1] !== '\n') throw new WikiLinePatchError('MIXED_LINE_ENDINGS', 'Markdown source contains CR outside CRLF')
      if (decoded.text[index] === '\n' && decoded.text[index - 1] !== '\r') throw new WikiLinePatchError('MIXED_LINE_ENDINGS', 'Markdown source mixes LF and CRLF')
    }
    lineEnding = 'crlf'
  }
  const canonicalText = lineEnding === 'crlf' ? decoded.text.replaceAll('\r\n', '\n') : decoded.text
  const finalNewline = canonicalText.endsWith('\n')
  const lines = canonicalText === '' ? [] : canonicalText.split('\n')
  if (finalNewline) lines.pop()
  if (lines.length > MAX_SOURCE_LINES) throw new WikiLinePatchError('SOURCE_TOO_MANY_LINES', 'Markdown source exceeds its line limit')
  const canonicalBytes = Buffer.from(canonicalText, 'utf8')
  const canonicalSha256 = sha256(canonicalBytes)
  return {
    text: decoded.text,
    bytes: decoded.bytes,
    canonicalText,
    canonicalBytes,
    lines,
    lineEnding,
    finalNewline,
    rawSha256: sha256(decoded.bytes),
    canonicalSha256,
    documentTag: canonicalSha256.slice(0, 12),
    warnings: sourceWarnings(decoded.text)
  }
}

const lineTag = (documentTag: string, lineNumber: number, text: string): string =>
  sha256(`${documentTag}\0${lineNumber}\0${text}`).slice(0, 12)

const normalizeRanges = (ranges: readonly DisclosedLineRange[], lineCount: number): readonly DisclosedLineRange[] => {
  if (lineCount === 0) {
    if (ranges.length > 0) throw new WikiLinePatchError('INVALID_DISCLOSURE', 'Empty documents have no line ranges')
    return []
  }
  const sorted = ranges.map(range => {
    if (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine || range.endLine > lineCount) {
      throw new WikiLinePatchError('INVALID_DISCLOSURE', 'Snapshot disclosure range is invalid')
    }
    return { startLine: range.startLine, endLine: range.endLine }
  }).sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
  const normalized: DisclosedLineRange[] = []
  for (const range of sorted) {
    const previous = normalized.at(-1)
    if (previous && range.startLine <= previous.endLine + 1) {
      normalized[normalized.length - 1] = { startLine: previous.startLine, endLine: Math.max(previous.endLine, range.endLine) }
    } else {
      normalized.push(range)
    }
  }
  const count = normalized.reduce((total, range) => total + range.endLine - range.startLine + 1, 0)
  if (count > MAX_DISCLOSED_LINES) throw new WikiLinePatchError('DISCLOSURE_TOO_LARGE', 'Snapshot disclosure exceeds its line limit')
  return normalized
}

const rangesHash = (ranges: readonly DisclosedLineRange[]): string => sha256(JSON.stringify(ranges))
const requesterHash = (requesterScope: string): string => sha256(requesterScope)

const signToken = (payload: TokenPayload, secret: Uint8Array): string => {
  if (secret.byteLength < 32) throw new WikiLinePatchError('INVALID_TOKEN_SECRET', 'Snapshot signing secret must be at least 256 bits', 500)
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `v1.${encoded}.${signature}`
}

const verifyTokenSignature = (token: string, secret: Uint8Array): TokenPayload => {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) throw new WikiLinePatchError('INVALID_SNAPSHOT_TOKEN', 'Snapshot token has an invalid format', 409)
  const expected = createHmac('sha256', secret).update(parts[1]).digest()
  let received: Buffer
  try {
    received = Buffer.from(parts[2], 'base64url')
  } catch {
    throw new WikiLinePatchError('INVALID_SNAPSHOT_TOKEN', 'Snapshot token signature is invalid', 409)
  }
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) throw new WikiLinePatchError('INVALID_SNAPSHOT_TOKEN', 'Snapshot token signature is invalid', 409)
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new WikiLinePatchError('INVALID_SNAPSHOT_TOKEN', 'Snapshot token payload is invalid', 409)
  }
  const payload = TokenPayloadSchema.safeParse(decoded)
  if (!payload.success || payload.data.expiresAtEpochMs <= Date.now() || rangesHash(payload.data.disclosed) !== payload.data.disclosedRangesSha256) {
    throw new WikiLinePatchError('INVALID_SNAPSHOT_TOKEN', 'Snapshot token is invalid or expired', 409)
  }
  return payload.data
}

export const inspectWikiLineSnapshotToken = (token: string, secret: Uint8Array, requesterScope: string): { readonly pageId: number; readonly sourceRevision: string } => {
  const payload = verifyTokenSignature(token, secret)
  if (payload.requesterSha256 !== requesterHash(requesterScope)) throw new WikiLinePatchError('STALE_SNAPSHOT', 'Snapshot requester authority no longer matches', 409)
  return { pageId: payload.pageId, sourceRevision: payload.sourceRevision }
}

const verifyTokenContext = (payload: TokenPayload, expected: {
  readonly pageId: number
  readonly requesterScope: string
  readonly sourceRevision: string
  readonly source: ValidatedWikiMarkdownSource
}): void => {
  if (
    payload.pageId !== expected.pageId || payload.requesterSha256 !== requesterHash(expected.requesterScope) ||
    payload.sourceRevision !== expected.sourceRevision || payload.rawSha256 !== expected.source.rawSha256 ||
    payload.canonicalSha256 !== expected.source.canonicalSha256 || payload.documentTag !== expected.source.documentTag ||
    payload.lineEnding !== expected.source.lineEnding || payload.finalNewline !== expected.source.finalNewline ||
    payload.lineCount !== expected.source.lines.length
  ) throw new WikiLinePatchError('STALE_SNAPSHOT', 'Page source no longer matches the snapshot', 409)
}

export const issueWikiLineSnapshot = (input: {
  readonly page: { readonly id: number; readonly locale: string; readonly path: string; readonly contentType: 'markdown' }
  readonly sourceRevision: string
  readonly source: string | Uint8Array
  readonly requesterScope: string
  readonly signingSecret: Uint8Array
  readonly requestedRanges?: readonly DisclosedLineRange[]
  readonly previousSnapshotToken?: string
  readonly ttlMs?: number
}): WikiLineSnapshotV1 => {
  const source = validateWikiMarkdownSource(input.source)
  const requested = input.requestedRanges ?? (source.lines.length === 0 ? [] : [{ startLine: 1, endLine: source.lines.length }])
  let prior: readonly DisclosedLineRange[] = []
  if (input.previousSnapshotToken) {
    const payload = verifyTokenSignature(input.previousSnapshotToken, input.signingSecret)
    verifyTokenContext(payload, { pageId: input.page.id, requesterScope: input.requesterScope, sourceRevision: input.sourceRevision, source })
    prior = payload.disclosed
  }
  const disclosed = normalizeRanges([...prior, ...requested], source.lines.length)
  const ttlMs = input.ttlMs ?? 5 * 60 * 1000
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60 * 1000) throw new WikiLinePatchError('INVALID_SNAPSHOT_TTL', 'Snapshot TTL is outside its allowed range')
  const expiresAtEpochMs = Date.now() + ttlMs
  const payload: TokenPayload = {
    version: TOKEN_VERSION,
    pageId: input.page.id,
    requesterSha256: requesterHash(input.requesterScope),
    sourceRevision: input.sourceRevision,
    rawSha256: source.rawSha256,
    canonicalSha256: source.canonicalSha256,
    documentTag: source.documentTag,
    lineEnding: source.lineEnding,
    finalNewline: source.finalNewline,
    lineCount: source.lines.length,
    disclosed: [...disclosed],
    disclosedRangesSha256: rangesHash(disclosed),
    expiresAtEpochMs
  }
  return {
    version: 'wiki-line-snapshot-v1',
    page: input.page,
    revision: { sourceRevision: input.sourceRevision, rawSha256: source.rawSha256, canonicalSha256: source.canonicalSha256 },
    documentTag: source.documentTag,
    lineEnding: source.lineEnding,
    finalNewline: source.finalNewline,
    disclosed: disclosed.map(range => ({
      ...range,
      lines: source.lines.slice(range.startLine - 1, range.endLine).map((text, offset) => {
        const number = range.startLine + offset
        return { number, tag: lineTag(source.documentTag, number, text), text }
      })
    })),
    snapshotToken: signToken(payload, input.signingSecret),
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
    warnings: source.warnings.filter(warning => lineIsDisclosed(warning.line, disclosed))
  }
}

const lineIsDisclosed = (line: number, ranges: readonly DisclosedLineRange[]): boolean => ranges.some(range => line >= range.startLine && line <= range.endLine)

const assertPatchLine = (value: string): void => {
  assertValidUtf16(value, 'Patch line')
  if (value.includes('\r') || value.includes('\n') || value.includes('\0')) throw new WikiLinePatchError('INVALID_PATCH_LINE', 'Patch lines must not contain CR, LF, or NUL')
}

const resolveRange = (
  range: { readonly start: z.infer<typeof LineAnchorSchema>; readonly end: z.infer<typeof LineAnchorSchema> },
  source: ValidatedWikiMarkdownSource,
  disclosed: readonly DisclosedLineRange[]
): { readonly start: number; readonly end: number } => {
  const start = range.start.line
  const end = range.end.line
  if (start > end || end > source.lines.length || !lineIsDisclosed(start, disclosed) || !lineIsDisclosed(end, disclosed)) {
    throw new WikiLinePatchError('UNDISCLOSED_PATCH_RANGE', 'Patch range is invalid or was not fully disclosed', 409)
  }
  for (let line = start; line <= end; line += 1) {
    if (!lineIsDisclosed(line, disclosed)) throw new WikiLinePatchError('UNDISCLOSED_PATCH_RANGE', 'Patch range crosses undisclosed lines', 409)
  }
  if (lineTag(source.documentTag, start, source.lines[start - 1] as string) !== range.start.tag || lineTag(source.documentTag, end, source.lines[end - 1] as string) !== range.end.tag) {
    throw new WikiLinePatchError('STALE_LINE_ANCHOR', 'Patch line anchor does not match the snapshot', 409)
  }
  return { start, end }
}

const resolveGap = (
  gap: z.infer<typeof InsertOperationSchema>['gap'],
  source: ValidatedWikiMarkdownSource,
  disclosed: readonly DisclosedLineRange[]
): number => {
  const lineCount = source.lines.length
  if (lineCount === 0) {
    if (gap.after !== null || gap.before !== null) throw new WikiLinePatchError('INVALID_PATCH_GAP', 'Empty documents require null gap anchors', 409)
    return 0
  }
  if (gap.after === null && gap.before === null) throw new WikiLinePatchError('INVALID_PATCH_GAP', 'Non-empty documents require a gap anchor', 409)
  if (gap.after && (gap.after.line > lineCount || lineTag(source.documentTag, gap.after.line, source.lines[gap.after.line - 1] as string) !== gap.after.tag)) {
    throw new WikiLinePatchError('STALE_LINE_ANCHOR', 'Patch gap after-anchor does not match the snapshot', 409)
  }
  if (gap.before && (gap.before.line > lineCount || lineTag(source.documentTag, gap.before.line, source.lines[gap.before.line - 1] as string) !== gap.before.tag)) {
    throw new WikiLinePatchError('STALE_LINE_ANCHOR', 'Patch gap before-anchor does not match the snapshot', 409)
  }
  let gapIndex: number
  if (gap.after && gap.before) {
    if (gap.after.line + 1 !== gap.before.line) throw new WikiLinePatchError('INVALID_PATCH_GAP', 'Patch gap anchors must be adjacent', 409)
    gapIndex = gap.after.line
  } else if (gap.after) {
    if (gap.after.line !== lineCount) throw new WikiLinePatchError('INVALID_PATCH_GAP', 'A lone after-anchor must identify the final line', 409)
    gapIndex = lineCount
  } else {
    if (gap.before?.line !== 1) throw new WikiLinePatchError('INVALID_PATCH_GAP', 'A lone before-anchor must identify the first line', 409)
    gapIndex = 0
  }
  const covered = gapIndex === 0
    ? lineIsDisclosed(1, disclosed)
    : gapIndex === lineCount
      ? lineIsDisclosed(lineCount, disclosed)
      : lineIsDisclosed(gapIndex, disclosed) && lineIsDisclosed(gapIndex + 1, disclosed)
  if (!covered) throw new WikiLinePatchError('UNDISCLOSED_PATCH_GAP', 'Patch gap was not fully disclosed', 409)
  return gapIndex
}

export const applyWikiLinePatch = (input: {
  readonly pageId: number
  readonly sourceRevision: string
  readonly source: string | Uint8Array
  readonly requesterScope: string
  readonly signingSecret: Uint8Array
  readonly patch: unknown
}): WikiLinePatchResult => {
  const parsed = WikiLinePatchV1Schema.safeParse(input.patch)
  if (!parsed.success) throw new WikiLinePatchError('INVALID_PATCH', 'Patch does not match wiki-line-patch-v1')
  const patch = parsed.data
  const source = validateWikiMarkdownSource(input.source)
  const token = verifyTokenSignature(patch.snapshotToken, input.signingSecret)
  verifyTokenContext(token, { pageId: input.pageId, requesterScope: input.requesterScope, sourceRevision: input.sourceRevision, source })
  if (patch.baseDocumentTag !== source.documentTag) throw new WikiLinePatchError('STALE_DOCUMENT_TAG', 'Patch document tag does not match the source', 409)

  const ranges = new Map<number, { readonly end: number; readonly lines: readonly string[] }>()
  const modifiedRanges: Array<{ readonly start: number; readonly end: number }> = []
  const gaps = new Map<number, readonly string[]>()
  let previousPositionEnd = -1
  for (const operation of patch.operations) {
    if (operation.kind === 'insert') {
      operation.lines.forEach(assertPatchLine)
      const gap = resolveGap(operation.gap, source, token.disclosed)
      const position = gap * 2
      if (position <= previousPositionEnd || gaps.has(gap)) throw new WikiLinePatchError('PATCH_ORDER_CONFLICT', 'Patch operations must be uniquely and strictly ordered', 409)
      previousPositionEnd = position
      gaps.set(gap, operation.lines)
      continue
    }
    const range = resolveRange(operation.range, source, token.disclosed)
    const position = range.start * 2 - 1
    const positionEnd = range.end * 2 - 1
    if (position <= previousPositionEnd || ranges.has(range.start)) throw new WikiLinePatchError('PATCH_ORDER_CONFLICT', 'Patch ranges overlap or are out of order', 409)
    previousPositionEnd = positionEnd
    const lines = operation.kind === 'replace' ? operation.lines : []
    lines.forEach(assertPatchLine)
    ranges.set(range.start, { end: range.end, lines })
    modifiedRanges.push(range)
  }
  for (const gap of gaps.keys()) {
    if (modifiedRanges.some(range => gap >= range.start - 1 && gap <= range.end)) {
      throw new WikiLinePatchError('PATCH_INCIDENT_GAP', 'Patch insertion gap is incident to a replaced or deleted range', 409)
    }
  }

  const resultLines: string[] = []
  const initialInsert = gaps.get(0)
  if (initialInsert) resultLines.push(...initialInsert)
  let line = 1
  while (line <= source.lines.length) {
    const replacement = ranges.get(line)
    if (replacement) {
      resultLines.push(...replacement.lines)
      line = replacement.end + 1
      continue
    }
    resultLines.push(source.lines[line - 1] as string)
    const insertion = gaps.get(line)
    if (insertion) resultLines.push(...insertion)
    line += 1
  }
  const canonicalResult = `${resultLines.join('\n')}${patch.resultFinalNewline ? '\n' : ''}`
  const restoredResult = source.lineEnding === 'crlf' ? canonicalResult.replaceAll('\n', '\r\n') : canonicalResult
  const result = validateWikiMarkdownSource(restoredResult)
  if (result.canonicalSha256 === source.canonicalSha256) throw new WikiLinePatchError('PATCH_NO_OP', 'Patch does not change canonical Markdown source', 409)
  const patchJson = JSON.stringify(patch)
  const diff = createTwoFilesPatch('base.md', 'result.md', source.canonicalText, result.canonicalText, undefined, undefined, { context: 3 })
  return {
    source: result,
    patchSha256: sha256(patchJson),
    diff,
    diffSha256: sha256(diff),
    disclosedRangesSha256: token.disclosedRangesSha256,
    engineVersion: WIKI_LINE_PATCH_ENGINE_VERSION,
    diffRendererVersion: WIKI_LINE_DIFF_RENDERER_VERSION
  }
}
