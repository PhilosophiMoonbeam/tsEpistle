import { createHash } from 'node:crypto'
import path from 'node:path'
import * as yaml from 'js-yaml'

export const OKF_VERSION = '0.2' as const
export const OKF_MAX_DOCUMENT_BYTES = 1_048_576

const MAX_FRONTMATTER_BYTES = 65_536
const MAX_TREE_DEPTH = 20
const MAX_TREE_NODES = 5_000
const RESERVED_BASENAMES = new Set(['index', 'log'])
const STATUS_VALUES = new Set(['draft', 'stable', 'deprecated'])
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const FIELD_ORDER = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'status',
  'generated',
  'verified',
  'stale_after',
  'sources',
  'usage_window',
  'runtime',
  'parameters',
  'computation',
  'executor',
  'attester'
] as const
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u
const MARKDOWN_LINK = /(\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)\n]+)/gu
const FENCE = /^ {0,3}(`{3,}|~{3,})/u

export interface OkfActorEvent extends Record<string, unknown> {
  by: string
  at?: string
}

export interface OkfSource extends Record<string, unknown> {
  resource: string
  id?: string
  title?: string
}

export interface OkfMetadata extends Record<string, unknown> {
  type: string
  title?: string
  description?: string
  resource?: string
  tags?: string[]
  status?: 'draft' | 'stable' | 'deprecated'
  generated?: OkfActorEvent
  verified?: OkfActorEvent | OkfActorEvent[]
  stale_after?: string
  sources?: OkfSource[]
}

export interface OkfTrustSummary {
  readonly trustTier: 'unverified' | 'machine-confirmed' | 'human-reviewed'
  readonly verification: 'unverified' | 'current' | 'outdated'
  readonly status: 'draft' | 'stable' | 'deprecated'
  readonly stale: boolean
  readonly generatedAt: string | null
  readonly verifiedAt: string | null
}

export interface ParsedOkfDocument {
  readonly version: typeof OKF_VERSION
  readonly metadata: OkfMetadata
  readonly body: string
  readonly trust: OkfTrustSummary
}

export interface OkfPageInput {
  readonly locale: string
  readonly path: string
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly content: string
  readonly updatedAt: string
  readonly authorId: number
  readonly metadata?: unknown
}
export interface OkfMetadataMutation {
  readonly existing?: unknown
  readonly proposed?: unknown
  readonly producer: string
  readonly knowledgeChanged: boolean
  readonly mode?: 'merge' | 'replace'
  readonly at?: string | Date
  readonly restore?: {
    readonly revision: string | number
  }
}

/**
 * Normalize metadata at a mutation boundary.
 *
 * Metadata supplied by callers is never trusted for generated, verified, or
 * restore provenance. Existing valid trust events are retained for no-ops
 * (and as historical evidence after an edit), while every knowledge edit
 * receives a server-stamped generated event. Merge mode preserves unknown JSON
 * extensions; replace mode takes ordinary and extension authority exclusively
 * from the proposed metadata.
 */
export const mutateOkfMetadata = (input: OkfMetadataMutation): OkfMetadata => {
  const producer = nonEmptyString(input.producer, 'producer', 255, 'INVALID_OKF_PRODUCER')
  const producerMatch = /^(human|agent|mcp|import):(\S+)$/u.exec(producer)
  if (!producerMatch || (producerMatch[1] === 'human' && !/^\d+$/u.test(producerMatch[2]!)))
    return fail('INVALID_OKF_PRODUCER', 'OKF producer must identify a human, agent, MCP request, or import')
  let at: string
  if (input.at instanceof Date) {
    if (!Number.isFinite(input.at.valueOf())) return fail('INVALID_OKF_TIMESTAMP', 'OKF mutation timestamp must be an ISO 8601 datetime with an explicit UTC offset')
    at = input.at.toISOString()
  } else {
    at = input.at ?? new Date().toISOString()
  }
  if (!isOkfTimestamp(at)) return fail('INVALID_OKF_TIMESTAMP', 'OKF mutation timestamp must be an ISO 8601 datetime with an explicit UTC offset')

  const existing = input.existing === undefined ? undefined : validateMetadata(input.existing)
  const proposed = input.proposed === undefined ? undefined : validateMetadata(input.proposed)
  const metadata = validateMetadata(
    input.mode === 'replace'
      ? (proposed ?? { type: 'Reference', status: 'stable' })
      : {
          ...(existing ?? { type: 'Reference', status: 'stable' }),
          ...(proposed ?? {})
        }
  )

  // Trust fields are server-owned. Never let proposed authority add, replace,
  // or remove them; an edit deliberately advances generated while retaining
  // older verification so the trust summary marks it as outdated.
  if (input.knowledgeChanged || existing === undefined) metadata.generated = { by: producer, at }
  else if (existing.generated === undefined) delete metadata.generated
  else metadata.generated = existing.generated
  if (producer.startsWith('import:')) {
    // Imported claims are external evidence, not locally issued trust.
    delete metadata.verified
  } else if (existing?.verified === undefined) delete metadata.verified
  else metadata.verified = existing.verified

  if (input.restore === undefined) {
    if (existing?.restored_from === undefined) delete metadata.restored_from
    else metadata.restored_from = existing.restored_from
  } else {
    const revision = nonEmptyString(String(input.restore.revision), 'restore.revision', 255, 'INVALID_RESTORE')
    metadata.restored_from = { revision, by: producer, at }
  }
  return validateMetadata(metadata)
}


export interface OkfPageDocument {
  readonly version: typeof OKF_VERSION
  readonly conceptId: string
  readonly filePath: string
  readonly markdown: string
  readonly sha256: string
  readonly metadata: OkfMetadata
  readonly trust: OkfTrustSummary
}

export class OkfDocumentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OkfDocumentError'
    this.code = code
  }
}

const fail = (code: string, message: string): never => {
  throw new OkfDocumentError(code, message)
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value: unknown, field: string, maximum: number, code = `INVALID_${field.toUpperCase()}`): string => {
  if (typeof value !== 'string' || value.trim().length === 0) return fail(code, `OKF field ${field} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length > maximum) return fail(code, `OKF field ${field} exceeds ${maximum} characters`)
  return normalized
}

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export const isOkfTimestamp = (value: string): boolean => {
  const match = ISO_WITH_OFFSET.exec(value)
  if (!match) return false
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue, offsetHourValue, offsetMinuteValue] = match
  const year = Number(yearValue)
  const month = Number(monthValue)
  const day = Number(dayValue)
  const hour = Number(hourValue)
  const minute = Number(minuteValue)
  const second = Number(secondValue)
  const offsetHour = offsetHourValue === undefined ? 0 : Number(offsetHourValue)
  const offsetMinute = offsetMinuteValue === undefined ? 0 : Number(offsetMinuteValue)
  const validOffset = offsetHour <= 14 && offsetMinute <= 59 && (offsetHour < 14 || offsetMinute === 0)
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    validOffset &&
    Number.isFinite(Date.parse(value))
  )
}

const actorEvent = (value: unknown, field: string, code: string): OkfActorEvent => {
  if (!isRecord(value)) return fail(code, `OKF field ${field} must be an actor event`)
  const by = nonEmptyString(value.by, `${field}.by`, 255, code)
  const at = value.at === undefined ? undefined : nonEmptyString(value.at, `${field}.at`, 64, code)
  if (at !== undefined && !isOkfTimestamp(at))
    return fail(code, `OKF field ${field}.at must be an ISO 8601 datetime with an explicit UTC offset`)
  return { ...value, by, ...(at === undefined ? {} : { at }) }
}

const assertJsonTree = (root: unknown): void => {
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_TREE_NODES) return fail('OKF_METADATA_TOO_COMPLEX', `OKF frontmatter exceeds ${MAX_TREE_NODES} values`)
    if (depth > MAX_TREE_DEPTH) return fail('OKF_METADATA_TOO_DEEP', `OKF frontmatter exceeds ${MAX_TREE_DEPTH} nested levels`)
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return fail('INVALID_OKF_NUMBER', 'OKF frontmatter numbers must be finite')
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    if (!isRecord(value)) return fail('INVALID_OKF_VALUE', 'OKF frontmatter must contain only JSON-compatible values')
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) return fail('INVALID_OKF_KEY', `OKF frontmatter key ${key} is not allowed`)
      visit(entry, depth + 1)
    }
  }
  visit(root, 0)
}

const orderedMetadata = (metadata: OkfMetadata): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {}
  for (const field of FIELD_ORDER) if (metadata[field] !== undefined) ordered[field] = metadata[field]
  for (const field of Object.keys(metadata)
    .filter(field => !FIELD_ORDER.includes(field as (typeof FIELD_ORDER)[number]))
    .sort())
    ordered[field] = metadata[field]
  return ordered
}

const serializeMetadata = (metadata: OkfMetadata): string =>
  yaml.dump(orderedMetadata(metadata), { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()

const validateMetadataAndSerialize = (value: unknown): { readonly metadata: OkfMetadata; readonly serialized: string } => {
  if (!isRecord(value)) return fail('INVALID_OKF_ROOT', 'OKF frontmatter must be a YAML mapping')
  assertJsonTree(value)
  const metadata: OkfMetadata = { ...value, type: nonEmptyString(value.type, 'type', 128) }
  if (value.title !== undefined) metadata.title = nonEmptyString(value.title, 'title', 255)
  if (value.description !== undefined) metadata.description = nonEmptyString(value.description, 'description', 2_000)
  if (value.resource !== undefined) metadata.resource = nonEmptyString(value.resource, 'resource', 4_096)
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 100) return fail('INVALID_TAGS', 'OKF field tags must be a list of at most 100 non-empty strings')
    metadata.tags = value.tags.map((tag, index) => nonEmptyString(tag, `tags[${index}]`, 255, 'INVALID_TAGS'))
  }
  if (value.status !== undefined) {
    if (typeof value.status !== 'string' || !STATUS_VALUES.has(value.status))
      return fail('INVALID_STATUS', 'OKF field status must be draft, stable, or deprecated')
    metadata.status = value.status as 'draft' | 'stable' | 'deprecated'
  }
  if (value.generated !== undefined) metadata.generated = actorEvent(value.generated, 'generated', 'INVALID_GENERATED')
  if (value.verified !== undefined) {
    const events = Array.isArray(value.verified) ? value.verified : [value.verified]
    if (events.length === 0 || events.length > 100) return fail('INVALID_VERIFIED', 'OKF field verified must contain between 1 and 100 actor events')
    const normalized = events.map((event, index) => actorEvent(event, `verified[${index}]`, 'INVALID_VERIFIED'))
    metadata.verified = Array.isArray(value.verified) ? normalized : normalized[0]!
  }
  if (value.stale_after !== undefined) {
    const staleAfter = nonEmptyString(value.stale_after, 'stale_after', 64)
    if (!isOkfTimestamp(staleAfter)) return fail('INVALID_STALE_AFTER', 'OKF field stale_after must be an ISO 8601 datetime with an explicit UTC offset')
    metadata.stale_after = staleAfter
  }
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > 100)
      return fail('INVALID_SOURCES', 'OKF field sources must be a list of at most 100 source mappings')
    metadata.sources = value.sources.map((source, index) => {
      if (!isRecord(source)) return fail('INVALID_SOURCES', `OKF source ${index + 1} must be a mapping`)
      return {
        ...source,
        resource: nonEmptyString(source.resource, `sources[${index}].resource`, 4_096, 'INVALID_SOURCES'),
        ...(source.id === undefined ? {} : { id: nonEmptyString(source.id, `sources[${index}].id`, 255, 'INVALID_SOURCES') }),
        ...(source.title === undefined ? {} : { title: nonEmptyString(source.title, `sources[${index}].title`, 512, 'INVALID_SOURCES') })
      }
    })
  }
  const serialized = serializeMetadata(metadata)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FRONTMATTER_BYTES)
    return fail('OKF_FRONTMATTER_TOO_LARGE', `OKF frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`)
  return { metadata, serialized }
}

const validateMetadata = (value: unknown): OkfMetadata => validateMetadataAndSerialize(value).metadata

const verificationEvents = (metadata: OkfMetadata): readonly OkfActorEvent[] =>
  metadata.verified === undefined ? [] : Array.isArray(metadata.verified) ? metadata.verified : [metadata.verified]

const summarizeValidatedOkfTrust = (metadata: OkfMetadata, now: Date): OkfTrustSummary => {
  const events = verificationEvents(metadata)
  const generatedAt = metadata.generated?.at ?? null
  const datedVerification = events
    .map(event => event.at)
    .filter((value): value is string => value !== undefined)
    .sort()
  const verifiedAt = datedVerification.at(-1) ?? null
  const trustTier = events.length === 0 ? 'unverified' : events.some(event => event.by.startsWith('human:')) ? 'human-reviewed' : 'machine-confirmed'
  const verification =
    events.length === 0
      ? 'unverified'
      : generatedAt !== null && (verifiedAt === null || Date.parse(verifiedAt) < Date.parse(generatedAt))
        ? 'outdated'
        : 'current'
  return {
    trustTier,
    verification,
    status: metadata.status ?? 'stable',
    stale: metadata.stale_after !== undefined && now.valueOf() >= Date.parse(metadata.stale_after),
    generatedAt,
    verifiedAt
  }
}

export const summarizeOkfTrust = (metadata: OkfMetadata, now = new Date()): OkfTrustSummary => summarizeValidatedOkfTrust(validateMetadata(metadata), now)

export const validateStoredOkfMetadata = (value: unknown, now = new Date()): { readonly metadata: OkfMetadata; readonly trust: OkfTrustSummary } | null => {
  try {
    const metadata = validateMetadata(value)
    return { metadata, trust: summarizeValidatedOkfTrust(metadata, now) }
  } catch {
    return null
  }
}

export const parseOkfDocument = (document: string, now = new Date()): ParsedOkfDocument => {
  if (Buffer.byteLength(document, 'utf8') > OKF_MAX_DOCUMENT_BYTES)
    return fail('OKF_DOCUMENT_TOO_LARGE', `OKF document exceeds ${OKF_MAX_DOCUMENT_BYTES} bytes`)
  const match = FRONTMATTER.exec(document)
  if (!match?.[1]) return fail('MISSING_OKF_FRONTMATTER', 'OKF document must begin with a YAML frontmatter block')
  if (Buffer.byteLength(match[1], 'utf8') > MAX_FRONTMATTER_BYTES)
    return fail('OKF_FRONTMATTER_TOO_LARGE', `OKF frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`)
  let raw: unknown
  try {
    raw = yaml.load(match[1], {
      schema: yaml.JSON_SCHEMA,
      maxDepth: MAX_TREE_DEPTH + 1,
      maxAliases: 0,
      maxTotalMergeKeys: 0
    })
  } catch (error: unknown) {
    return fail('INVALID_OKF_YAML', error instanceof Error ? `Invalid OKF YAML: ${error.message}` : 'Invalid OKF YAML')
  }
  const metadata = validateMetadata(raw)
  const body = document
    .slice(match[0].length)
    .replace(/^\r?\n/u, '')
    .replaceAll('\r\n', '\n')
  return { version: OKF_VERSION, metadata, body, trust: summarizeValidatedOkfTrust(metadata, now) }
}


export const renderOkfDocument = (metadataInput: OkfMetadata, body: string): string => {
  const { serialized } = validateMetadataAndSerialize(metadataInput)
  const normalizedBody = body.replaceAll('\r\n', '\n').replace(/^\n+/u, '')
  const document = `---\n${serialized}\n---\n${normalizedBody.length > 0 ? `\n${normalizedBody}` : ''}`
  if (Buffer.byteLength(document, 'utf8') > OKF_MAX_DOCUMENT_BYTES)
    return fail('OKF_DOCUMENT_TOO_LARGE', `OKF document exceeds ${OKF_MAX_DOCUMENT_BYTES} bytes`)
  return document
}


const escapedConceptPath = (pagePath: string): string => {
  const segments = pagePath.split('/')
  const basename = segments.at(-1) ?? ''
  if (RESERVED_BASENAMES.has(basename.toLowerCase())) segments[segments.length - 1] = `${basename}.concept`
  return segments.join('/')
}

export const okfFilePath = (locale: string, pagePath: string): string => `${locale}/${escapedConceptPath(pagePath)}.md`
export const okfConceptId = (locale: string, pagePath: string): string => okfFilePath(locale, pagePath).replace(/\.md$/u, '')

const splitDestination = (destination: string): { path: string; suffix: string } => {
  const index = destination.search(/[?#]/u)
  return index < 0 ? { path: destination, suffix: '' } : { path: destination.slice(0, index), suffix: destination.slice(index) }
}

const exportLink = (destination: string): string => {
  const wrapped = destination.startsWith('<') && destination.endsWith('>')
  const raw = wrapped ? destination.slice(1, -1) : destination
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/_private/')) return destination
  const parts = splitDestination(raw)
  const segments = parts.path.slice(1).split('/')
  if (segments.length < 2 || !/^[A-Za-z][A-Za-z0-9-]{1,34}$/u.test(segments[0] ?? '') || segments.slice(1).some(segment => segment.includes('.')))
    return destination
  const converted = `/${okfFilePath(segments[0]!, segments.slice(1).join('/'))}${parts.suffix}`
  return wrapped ? `<${converted}>` : converted
}

const importedConceptIdentity = (filePath: string): { locale: string; pagePath: string } | null => {
  const normalized = path.posix.normalize(filePath).replace(/^\/+/, '')
  if (normalized.startsWith('../')) return null
  const segments = normalized.split('/')
  if (segments.length < 2 || !segments.at(-1)?.endsWith('.md')) return null
  const locale = segments.shift()!
  let basename = segments.pop()!.replace(/\.md$/u, '')
  if (basename.endsWith('.concept') && RESERVED_BASENAMES.has(basename.slice(0, -'.concept'.length).toLowerCase()))
    basename = basename.slice(0, -'.concept'.length)
  else if (RESERVED_BASENAMES.has(basename.toLowerCase())) return null
  segments.push(basename)
  return { locale, pagePath: segments.join('/') }
}

export const parseOkfFilePath = (filePath: string): { locale: string; pagePath: string } | null => {
  const identity = importedConceptIdentity(filePath)
  if (identity === null || identity.locale.length === 0 || identity.pagePath.length === 0) return null
  return okfFilePath(identity.locale, identity.pagePath) === filePath ? identity : null
}

const importLink = (destination: string, currentFilePath: string): string => {
  const wrapped = destination.startsWith('<') && destination.endsWith('>')
  const raw = wrapped ? destination.slice(1, -1) : destination
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return destination
  const parts = splitDestination(raw)
  if (!parts.path.toLowerCase().endsWith('.md')) return destination
  const target = parts.path.startsWith('/') ? parts.path : path.posix.join('/', path.posix.dirname(currentFilePath), parts.path)
  const identity = importedConceptIdentity(target)
  if (!identity) return destination
  const converted = `/${identity.locale}/${identity.pagePath}${parts.suffix}`
  return wrapped ? `<${converted}>` : converted
}

interface MarkdownFence {
  readonly marker: string
  readonly length: number
}

interface CodeSpan {
  readonly start: number
  readonly end: number
}

const codeSpans = (markdown: string): readonly CodeSpan[] => {
  const runs: Array<{ start: number; end: number; length: number; escaped: boolean; next: number | undefined }> = []
  const nextByLength = new Map<number, number>()
  for (let index = 0; index < markdown.length; ) {
    if (markdown[index] !== '`') {
      index += 1
      continue
    }
    const start = index
    while (markdown[index] === '`') index += 1
    let slashes = 0
    for (let before = start - 1; before >= 0 && markdown[before] === '\\'; before--) slashes += 1
    runs.push({ start, end: index, length: index - start, escaped: slashes % 2 === 1, next: undefined })
  }
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!
    run.next = nextByLength.get(run.length)
    nextByLength.set(run.length, index)
  }
  const spans: CodeSpan[] = []
  for (let index = 0; index < runs.length; ) {
    const opener = runs[index]!
    if (opener.escaped || opener.next === undefined) {
      index += 1
      continue
    }
    const closer = runs[opener.next]!
    spans.push({ start: opener.start, end: closer.end })
    index = opener.next + 1
  }
  return spans
}
const rewriteInlineMarkdownLinks = (markdown: string, rewrite: (destination: string) => string): string => {
  const spans = codeSpans(markdown)
  let spanIndex = 0
  return markdown.replace(MARKDOWN_LINK, (match, prefix: string, destination: string, offset: number) => {
    while (spans[spanIndex] !== undefined && spans[spanIndex]!.end <= offset) spanIndex += 1
    const span = spans[spanIndex]
    if (markdown[offset - 1] === '!' || (span !== undefined && offset >= span.start && offset < span.end)) return match
    return `${prefix}${rewrite(destination)}`
  })
}

const rewriteMarkdownLinks = (markdown: string, rewrite: (destination: string) => string): string => {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const output: string[] = []
  let fence: MarkdownFence | null = null
  let inlineLines: string[] = []
  const flushInlineLines = (): void => {
    if (inlineLines.length === 0) return
    output.push(...rewriteInlineMarkdownLinks(inlineLines.join('\n'), rewrite).split('\n'))
    inlineLines = []
  }
  for (const line of lines) {
    const match = FENCE.exec(line)
    const sequence = match?.[1]
    if (fence !== null) {
      flushInlineLines()
      output.push(line)
      if (sequence?.[0] === fence.marker && sequence.length >= fence.length && line.slice(match![0].length).trim().length === 0) fence = null
      continue
    }
    if (sequence !== undefined && (sequence[0] !== '`' || !line.slice(match![0].length).includes('`'))) {
      flushInlineLines()
      fence = { marker: sequence[0]!, length: sequence.length }
      output.push(line)
      continue
    }
    inlineLines.push(line)
  }
  flushInlineLines()
  return output.join('\n')
}

export const exportOkfLinks = (markdown: string): string => rewriteMarkdownLinks(markdown, exportLink)
export const importOkfLinks = (markdown: string, locale: string, pagePath: string): string =>
  rewriteMarkdownLinks(markdown, destination => importLink(destination, okfFilePath(locale, pagePath)))

export const createOkfPageDocument = (input: OkfPageInput, now = new Date()): OkfPageDocument => {
  const metadata = mutateOkfMetadata({
    proposed: input.metadata,
    producer: `human:${input.authorId}`,
    knowledgeChanged: true,
    at: input.updatedAt
  })
  const authoritativeMetadata: OkfMetadata = {
    ...metadata,
    title: input.title,
    ...(input.description.trim().length > 0 ? { description: input.description } : {}),
    tags: [...input.tags]
  }
  const markdown = renderOkfDocument(authoritativeMetadata, exportOkfLinks(input.content))
  const validatedMetadata = validateMetadata(authoritativeMetadata)
  return {
    version: OKF_VERSION,
    conceptId: okfConceptId(input.locale, input.path),
    filePath: okfFilePath(input.locale, input.path),
    markdown,
    sha256: createHash('sha256').update(markdown).digest('hex'),
    metadata: validatedMetadata,
    trust: summarizeOkfTrust(validatedMetadata, now)
  }
}
