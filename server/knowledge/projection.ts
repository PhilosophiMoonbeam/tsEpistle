import { createHash } from 'node:crypto'
import type { MarkdownIt, MarkdownItOptions, Token } from 'markdown-it'
import * as markdownItModule from 'markdown-it'
import { z } from 'zod'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { validateStoredOkfMetadata, type OkfMetadata, type OkfTrustSummary } from '../okf/format.ts'

export const KNOWLEDGE_SCHEMA_VERSION = 2 as const
export const KNOWLEDGE_DETERMINISTIC_VERSION = 'wiki-knowledge-v2' as const

const LifecycleStatusSchema = z.enum(['draft', 'stable', 'deprecated'])
const TrustTierSchema = z.enum(['unverified', 'machine-confirmed', 'human-reviewed'])
const VerificationSchema = z.enum(['unverified', 'current', 'outdated'])
const GapSchema = z.enum([
  'concept.type',
  'concept.summary',
  'concept.tags',
  'concept.entities',
  'concept.relationships',
  'concept.openQuestions',
  'concept.searchTerms'
])

const EntitySchema = z.strictObject({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(128)
})
const RelationshipSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  predicate: z.string().min(1).max(128),
  object: z.string().min(1).max(1_024)
})
const FieldProvenanceSchema = z.strictObject({
  field: z.string().min(1).max(128),
  source: z.enum(['page', 'metadata', 'deterministic', 'utility']),
  evidence: z.string().min(1).max(1_024)
})

export const KnowledgeUtilityResultSchema = z.strictObject({
  type: z.string().trim().min(1).max(128).nullable(),
  summary: z.string().trim().min(1).max(2_000).nullable(),
  tags: z.array(z.string().trim().min(1).max(255)).max(20),
  entities: z.array(EntitySchema).max(20),
  relationships: z.array(RelationshipSchema).max(20),
  openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(20),
  searchTerms: z.array(z.string().trim().min(1).max(120)).max(20)
})
export type KnowledgeUtilityResult = z.infer<typeof KnowledgeUtilityResultSchema>

export const KnowledgeProjectionSchema = z.strictObject({
  version: z.literal(KNOWLEDGE_SCHEMA_VERSION),
  source: z.strictObject({
    pageId: z.number().int().positive(),
    sourceRevision: z.string().regex(/^[1-9][0-9]*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    locale: z.string().min(1).max(35),
    path: z.string().min(1).max(1_024),
    visibility: z.enum(['public', 'private']),
    contentType: z.string().min(1).max(128),
    updatedAt: z.string().datetime(),
    authorId: z.number().int().positive()
  }),
  concept: z.strictObject({
    id: z.string().min(1).max(10_000),
    type: z.string().min(1).max(128).nullable(),
    title: z.string().min(1).max(255),
    description: z.string().max(2_000),
    summary: z.string().max(2_000),
    tags: z.array(z.string().min(1).max(255)).max(100),
    searchTerms: z.array(z.string().min(1).max(120)).max(20),
    sections: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(255),
          title: z.string().min(1).max(512),
          level: z.number().int().min(1).max(6),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/)
        })
      )
      .max(100),
    links: z
      .array(
        z.strictObject({
          label: z.string().max(512),
          target: z.string().min(1).max(4_096),
          kind: z.enum(['page', 'external']),
          line: z.number().int().positive().nullable()
        })
      )
      .max(100),
    sources: z.array(z.strictObject({ resource: z.string().min(1).max(4_096), title: z.string().max(512).nullable() })).max(100),
    entities: z.array(EntitySchema).max(20),
    relationships: z.array(RelationshipSchema).max(20),
    openQuestions: z.array(z.string().min(1).max(1_000)).max(20)
  }),
  lifecycle: z.strictObject({
    status: LifecycleStatusSchema,
    trustTier: TrustTierSchema,
    verification: VerificationSchema,
    generatedAt: z.string().datetime(),
    verifiedAt: z.string().datetime().nullable(),
    staleAfter: z.string().datetime().nullable()
  }),
  completeness: z.strictObject({
    state: z.enum(['complete', 'partial']),
    missingFields: z.array(GapSchema).max(7)
  }),
  provenance: z.strictObject({
    deterministicVersion: z.literal(KNOWLEDGE_DETERMINISTIC_VERSION),
    fields: z.array(FieldProvenanceSchema).max(100),
    utility: z
      .strictObject({
        profileVersionId: z.uuid(),
        model: z.string().min(1).max(255),
        inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
        outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
        generatedAt: z.string().datetime()
      })
      .nullable()
  })
})
export type KnowledgeProjection = z.infer<typeof KnowledgeProjectionSchema>
export type KnowledgeGap = z.infer<typeof GapSchema>

export const KnowledgeProjectionViewSchema = z.strictObject({
  schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
  sourceRevision: z.string().regex(/^[1-9][0-9]*$/),
  state: z.enum(['complete', 'partial']),
  conceptType: z.string().min(1).max(128).nullable(),
  summary: z.string().max(2_000),
  tags: z.array(z.string().min(1).max(255)).max(100),
  searchTerms: z.array(z.string().min(1).max(120)).max(20),
  entities: z.array(EntitySchema).max(20),
  relationships: z.array(RelationshipSchema).max(20),
  openQuestions: z.array(z.string().min(1).max(1_000)).max(20),
  lifecycle: z.strictObject({
    status: LifecycleStatusSchema,
    trustTier: TrustTierSchema,
    verification: VerificationSchema,
    stale: z.boolean(),
    generatedAt: z.string().datetime(),
    verifiedAt: z.string().datetime().nullable(),
    staleAfter: z.string().datetime().nullable()
  }),
  missingFields: z.array(GapSchema).max(7),
  provenance: z.strictObject({
    deterministicVersion: z.literal(KNOWLEDGE_DETERMINISTIC_VERSION),
    fields: z.array(FieldProvenanceSchema).max(100).optional(),
    utility: z
      .strictObject({
        profileVersionId: z.uuid(),
        model: z.string().min(1).max(255),
        inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
        outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
        generatedAt: z.string().datetime()
      })
      .nullable()
  })
})
export type KnowledgeProjectionView = z.infer<typeof KnowledgeProjectionViewSchema>

export interface KnowledgePageSource {
  readonly pageId: number
  readonly sourceRevision: string | number | bigint
  readonly locale: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly contentType: string
  readonly content: string
  readonly title: string
  readonly description: string | null
  readonly tags: readonly string[]
  readonly updatedAt: string | Date
  readonly authorId: number
  readonly metadata?: unknown
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const clean = (value: string, maximum: number): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  let result = ''
  for (const character of normalized) {
    if (result.length + character.length > maximum) break
    result += character
  }
  return result
}
const unique = (values: readonly string[], maximum: number): string[] =>
  [...new Map(values.map(value => [value.toLocaleLowerCase(), value] as const)).values()].slice(0, maximum)
const tagValues = (values: readonly string[]): string[] => unique(values.map(value => clean(value, 255)).filter(Boolean), 100)
const titleSearchTerms = (title: string): string[] => {
  const words = title.match(/[\p{Letter}\p{Number}]+/gu) ?? []
  if (words.length < 2 || words.length > 6 || words.some(word => word.length < 2 || word[0] === word[0]?.toLocaleLowerCase())) return []
  const acronym = clean(
    words
      .map(word => word[0]!)
      .join('')
      .toLocaleUpperCase(),
    120
  )
  return acronym.length >= 2 ? [acronym] : []
}
const sourceSha256 = (input: KnowledgePageSource, sourceRevision: string): string =>
  sha256(
    canonicalJson({
      pageId: input.pageId,
      sourceRevision,
      locale: input.locale,
      path: input.path,
      visibility: input.visibility,
      contentType: input.contentType,
      content: input.content,
      title: input.title,
      description: input.description,
      tags: tagValues(input.tags),
      updatedAt: new Date(input.updatedAt).toISOString(),
      authorId: input.authorId,
      metadata: input.metadata ?? null
    })
  )

const plainText = (content: string, contentType: string): string => {
  const withoutCode = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' ')
  if (contentType === 'markdown') {
    return clean(
      withoutCode
        .replace(/^ {0,3}#{1,6}\s+.*$/gmu, ' ')
        .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, '$1')
        .replace(/[*_`~>|-]/gu, ' '),
      20_000
    )
  }
  return clean(withoutCode.replace(/<[^>]+>/gu, ' '), 20_000)
}

const deterministicSummary = (input: KnowledgePageSource): string => {
  const description = clean(input.description ?? '', 2_000)
  if (description) return description
  const text = plainText(input.content, input.contentType)
  if (!text) return ''
  const characters = [...text]
  if (characters.length <= 600) return text
  const prefix = characters.slice(0, 601).join('')
  const boundary = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf(' '))
  return clean(boundary >= 160 ? prefix.slice(0, boundary + (prefix[boundary] === '.' ? 1 : 0)) : characters.slice(0, 600).join(''), 600)
}

const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return (normalized || fallback).slice(0, 255)
}

type MarkdownItFactory = (options?: MarkdownItOptions) => MarkdownIt

const markdownItFactory = (value: unknown): MarkdownItFactory => {
  if (typeof value === 'function') return value as MarkdownItFactory
  if (typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function') return value.default as MarkdownItFactory
  throw new TypeError('markdown-it does not export a callable parser')
}

const markdownParser = markdownItFactory(markdownItModule)({ html: false, linkify: false })

const linkLabel = (tokens: readonly Token[], start: number): { label: string; end: number } => {
  let label = ''
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.type === 'link_close') return { label: clean(label, 512), end: index }
    if (token.type === 'softbreak' || token.type === 'hardbreak') {
      label += ' '
      continue
    }
    if (token.type === 'text' || token.type === 'code_inline' || token.type === 'html_inline') label += token.content
  }
  return { label: clean(label, 512), end: tokens.length }
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
  for (let index = runs.length - 1; index >= 0; index -= 1) {
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

const MarkdownLinkSourceExpression = /(?:\[([^\]\n]*)\](?:\(\s*(<?)([^\s)>\n]+)>?(?:\s+['"][^'"\n]*['"])?\s*\)|\[([^\]\n]*)\])?|<(https?:\/\/[^>\s]+)>)/gu

interface InlineLinkLocation {
  readonly label: string
  readonly target: string | null
  readonly line: number
}

const inlineText = (markdown: string): string => {
  const token = markdownParser.parseInline(markdown, {})[0]
  if (token?.children === null || token?.children === undefined) return clean(markdown, 512)
  return clean(
    token.children
      .filter(child => child.type === 'text' || child.type === 'code_inline' || child.type === 'html_inline')
      .map(child => child.content)
      .join(' '),
    512
  )
}

const inlineLinkLines = (markdown: string, startLine: number): readonly InlineLinkLocation[] => {
  const spans = codeSpans(markdown)
  let spanIndex = 0
  let line = startLine
  let lineCursor = 0
  const links: InlineLinkLocation[] = []
  for (const match of markdown.matchAll(MarkdownLinkSourceExpression)) {
    const offset = match.index ?? 0
    for (; lineCursor < offset; lineCursor += 1) if (markdown[lineCursor] === '\n') line += 1
    while (spans[spanIndex] !== undefined && spans[spanIndex]!.end <= offset) spanIndex += 1
    const span = spans[spanIndex]
    if (markdown[offset - 1] === '!' || (span !== undefined && offset >= span.start && offset < span.end)) continue
    const autolink = match[5]
    links.push({
      label: autolink === undefined ? inlineText(match[1] ?? '') : autolink,
      target: autolink ?? match[3] ?? null,
      line
    })
  }
  return links
}

const markdownProjection = (content: string, contentType: string): Pick<KnowledgeProjection['concept'], 'sections' | 'links'> => {
  if (contentType !== 'markdown') return { sections: [], links: [] }
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const headings: Array<{ index: number; level: number; title: string }> = []
  const links: KnowledgeProjection['concept']['links'] = []
  const tokens = markdownParser.parse(content, {})
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.type === 'heading_open' && token.map !== null && headings.length < 100) {
      const title = clean(tokens[index + 1]?.content ?? '', 512)
      const level = Number(token.tag.slice(1))
      if (title && Number.isInteger(level) && level >= 1 && level <= 6) headings.push({ index: token.map[0], level, title })
      continue
    }
    if (token.type !== 'inline' || token.children === null || token.map === null || links.length >= 100) continue
    const sourceLinks = inlineLinkLines(token.content, token.map[0] + 1)
    let sourceLinkIndex = 0
    for (let childIndex = 0; childIndex < token.children.length; childIndex += 1) {
      const child = token.children[childIndex]!
      if (child.type !== 'link_open' || links.length >= 100) continue
      const href = child.attrGet('href')
      const target = typeof href === 'string' ? href : ''
      const label = linkLabel(token.children, childIndex + 1)
      childIndex = label.end
      if (!target || target.startsWith('#') || /^(?:mailto|tel|data|javascript):/iu.test(target)) continue
      let source: (typeof sourceLinks)[number] | undefined
      for (let sourceIndex = sourceLinkIndex; sourceIndex < sourceLinks.length; sourceIndex += 1) {
        const candidate = sourceLinks[sourceIndex]!
        const targetMatches = candidate.target !== null && (candidate.target === target || markdownParser.normalizeLink(candidate.target) === target)
        if (!targetMatches && !(candidate.target === null && candidate.label === label.label)) continue
        source = candidate
        sourceLinkIndex = sourceIndex + 1
        break
      }
      links.push({
        label: label.label,
        target: target.slice(0, 4_096),
        kind: /^https?:\/\//iu.test(target) ? 'external' : 'page',
        line: source?.line ?? null
      })
    }
  }
  const usedIds = new Set<string>()
  const sections = headings.map((heading, offset) => {
    const base = slug(heading.title, `section-${offset + 1}`)
    let id = base
    for (let occurrence = 2; usedIds.has(id); occurrence += 1) {
      const suffix = `-${occurrence}`
      id = `${base.slice(0, 255 - suffix.length)}${suffix}`
    }
    usedIds.add(id)
    let endIndex = (headings[offset + 1]?.index ?? lines.length) - 1
    while (endIndex > heading.index && lines[endIndex]?.trim() === '') endIndex -= 1
    return {
      id,
      title: heading.title,
      level: heading.level,
      startLine: heading.index + 1,
      endLine: Math.max(heading.index + 1, endIndex + 1),
      sha256: sha256(lines.slice(heading.index, endIndex + 1).join('\n'))
    }
  })
  return { sections, links }
}
const mergedSources = (metadata: OkfMetadata | null, pageLinks: KnowledgeProjection['concept']['links']): KnowledgeProjection['concept']['sources'] => {
  const results: KnowledgeProjection['concept']['sources'] = []
  const indexes = new Map<string, number>()
  const add = (resource: string, title: string | null): void => {
    const existingIndex = indexes.get(resource)
    if (existingIndex !== undefined) {
      const existing = results[existingIndex]!
      if (existing.title === null && title !== null) results[existingIndex] = { resource: existing.resource, title }
      return
    }
    if (results.length >= 100) return
    indexes.set(resource, results.length)
    results.push({ resource, title })
  }
  if (metadata?.resource !== undefined) add(metadata.resource, null)
  for (const source of metadata?.sources ?? []) add(source.resource, source.title ?? null)
  for (const link of pageLinks) if (link.kind === 'external') add(link.target, link.label || null)
  return results
}

const metadataLifecycle = (metadata: OkfMetadata | null, trust: OkfTrustSummary | null, input: KnowledgePageSource): KnowledgeProjection['lifecycle'] => {
  if (metadata === null || trust === null) {
    return {
      status: 'stable',
      trustTier: 'unverified',
      verification: 'unverified',
      generatedAt: new Date(input.updatedAt).toISOString(),
      verifiedAt: null,
      staleAfter: null
    }
  }
  return {
    status: trust.status,
    trustTier: trust.trustTier,
    verification: trust.verification,
    generatedAt: trust.generatedAt === null ? new Date(input.updatedAt).toISOString() : new Date(trust.generatedAt).toISOString(),
    verifiedAt: trust.verifiedAt === null ? null : new Date(trust.verifiedAt).toISOString(),
    staleAfter: metadata.stale_after === undefined ? null : new Date(metadata.stale_after).toISOString()
  }
}

const completenessState = (missingFields: readonly KnowledgeGap[]): KnowledgeProjection['completeness']['state'] =>
  missingFields.some(field => field === 'concept.type' || field === 'concept.summary') ? 'partial' : 'complete'

export const projectPageKnowledge = (input: KnowledgePageSource): KnowledgeProjection => {
  const sourceRevision = String(input.sourceRevision)
  if (!/^[1-9][0-9]*$/.test(sourceRevision)) throw new Error('Page knowledge source revision is invalid')
  const validatedMetadata = validateStoredOkfMetadata(input.metadata, new Date(input.updatedAt))
  const metadata = validatedMetadata?.metadata ?? null
  const type = metadata === null ? null : clean(metadata.type, 128)
  const summary = deterministicSummary(input)
  const tags = tagValues(input.tags)
  const searchTerms = titleSearchTerms(input.title)
  const markdown = markdownProjection(input.content, input.contentType)
  const pageLinks = markdown.links
  const sources = mergedSources(metadata, pageLinks)
  const entities = unique(
    pageLinks
      .filter(link => link.kind === 'page')
      .map(link => clean(link.label || link.target, 255))
      .filter(Boolean),
    20
  ).map(name => ({ name, type: 'WikiPage' }))
  const relationships = pageLinks
    .filter(link => link.kind === 'page')
    .slice(0, 20)
    .map(link => ({ subject: clean(input.title, 255), predicate: 'linksTo', object: clean(link.target, 1_024) }))
  const lifecycle = metadataLifecycle(metadata, validatedMetadata?.trust ?? null, input)
  const missingFields: KnowledgeGap[] = [
    ...(type === null ? ['concept.type' as const] : []),
    ...(summary === '' ? ['concept.summary' as const] : []),
    ...(tags.length === 0 ? ['concept.tags' as const] : []),
    ...(entities.length === 0 ? ['concept.entities' as const] : []),
    ...(relationships.length === 0 ? ['concept.relationships' as const] : []),
    ...(lifecycle.status === 'draft' ? ['concept.openQuestions' as const] : []),
    'concept.searchTerms'
  ]
  const projection: KnowledgeProjection = {
    version: KNOWLEDGE_SCHEMA_VERSION,
    source: {
      pageId: input.pageId,
      sourceRevision,
      sha256: sourceSha256(input, sourceRevision),
      locale: input.locale,
      path: input.path,
      visibility: input.visibility,
      contentType: input.contentType,
      updatedAt: new Date(input.updatedAt).toISOString(),
      authorId: input.authorId
    },
    concept: {
      id: `wiki:${encodeURIComponent(input.locale)}:${input.path.split('/').map(encodeURIComponent).join('/')}`,
      type,
      title: clean(input.title, 255),
      description: clean(input.description ?? '', 2_000),
      summary,
      tags,
      searchTerms,
      sections: markdown.sections,
      links: pageLinks,
      sources,
      entities,
      relationships,
      openQuestions: []
    },
    lifecycle,
    completeness: { state: completenessState(missingFields), missingFields },
    provenance: {
      deterministicVersion: KNOWLEDGE_DETERMINISTIC_VERSION,
      fields: [
        { field: 'concept.title', source: 'page', evidence: 'pages.title' },
        { field: 'concept.description', source: 'page', evidence: 'pages.description' },
        {
          field: 'concept.summary',
          source: input.description?.trim() ? 'page' : 'deterministic',
          evidence: input.description?.trim() ? 'pages.description' : 'first source paragraph'
        },
        { field: 'concept.tags', source: 'page', evidence: 'pageTags' },
        { field: 'concept.searchTerms', source: 'deterministic', evidence: 'conservative title acronym aliases' },
        {
          field: 'concept.type',
          source: type === null ? 'deterministic' : 'metadata',
          evidence: type === null ? 'missing or invalid pages.extra.okf.type' : 'pages.extra.okf.type'
        },
        { field: 'concept.sections', source: 'deterministic', evidence: 'Markdown heading spans and hashes' },
        { field: 'concept.links', source: 'deterministic', evidence: 'Markdown link destinations' },
        ...(metadata?.resource === undefined ? [] : [{ field: 'concept.sources', source: 'metadata' as const, evidence: 'pages.extra.okf.resource' }]),
        ...(metadata?.sources?.length ? [{ field: 'concept.sources', source: 'metadata' as const, evidence: 'pages.extra.okf.sources' }] : []),
        ...(pageLinks.some(link => link.kind === 'external')
          ? [{ field: 'concept.sources', source: 'deterministic' as const, evidence: 'Markdown external link destinations' }]
          : []),
        { field: 'concept.entities', source: 'deterministic', evidence: 'Markdown page-link labels' },
        { field: 'concept.relationships', source: 'deterministic', evidence: 'Markdown page-link destinations' },
        { field: 'concept.openQuestions', source: 'deterministic', evidence: 'No authoritative page field' },
        {
          field: 'lifecycle.status',
          source: metadata?.status === undefined ? 'deterministic' : 'metadata',
          evidence: metadata?.status === undefined ? 'validated OKF default stable' : 'pages.extra.okf.status'
        },
        {
          field: 'lifecycle.generatedAt',
          source: metadata?.generated?.at === undefined ? 'page' : 'metadata',
          evidence: metadata?.generated?.at === undefined ? 'pages.updatedAt' : 'pages.extra.okf.generated.at'
        },
        {
          field: 'lifecycle.trustTier',
          source: metadata?.verified === undefined ? 'deterministic' : 'metadata',
          evidence: metadata?.verified === undefined ? 'validated OKF unverified default' : 'pages.extra.okf.verified'
        },
        {
          field: 'lifecycle.verification',
          source: metadata?.verified === undefined ? 'deterministic' : 'metadata',
          evidence: metadata?.verified === undefined ? 'validated OKF unverified default' : 'pages.extra.okf.verified and generated'
        },
        {
          field: 'lifecycle.verifiedAt',
          source: metadata?.verified === undefined ? 'deterministic' : 'metadata',
          evidence: metadata?.verified === undefined ? 'validated OKF unverified default' : 'pages.extra.okf.verified.at'
        },
        {
          field: 'lifecycle.staleAfter',
          source: metadata?.stale_after === undefined ? 'deterministic' : 'metadata',
          evidence: metadata?.stale_after === undefined ? 'validated OKF no-staleness default' : 'pages.extra.okf.stale_after'
        }
      ],
      utility: null
    }
  }
  return KnowledgeProjectionSchema.parse(projection)
}

const withoutGap = (gaps: readonly KnowledgeGap[], field: KnowledgeGap, filled: boolean): KnowledgeGap[] =>
  filled ? gaps.filter(gap => gap !== field) : [...gaps]

export const mergeKnowledgeUtilityResult = (
  projection: KnowledgeProjection,
  result: KnowledgeUtilityResult,
  provenance: NonNullable<KnowledgeProjection['provenance']['utility']>
): KnowledgeProjection => {
  const gaps = new Set(projection.completeness.missingFields)
  const concept = { ...projection.concept }
  const fields = [...projection.provenance.fields]
  if (gaps.has('concept.type') && result.type) {
    concept.type = clean(result.type, 128)
    fields.push({ field: 'concept.type', source: 'utility', evidence: provenance.outputSha256 })
  }
  if (gaps.has('concept.summary') && result.summary) {
    concept.summary = clean(result.summary, 2_000)
    fields.push({ field: 'concept.summary', source: 'utility', evidence: provenance.outputSha256 })
  }
  if (gaps.has('concept.tags') && result.tags.length > 0) {
    concept.tags = tagValues(result.tags)
    fields.push({ field: 'concept.tags', source: 'utility', evidence: provenance.outputSha256 })
  }
  if (gaps.has('concept.entities') && result.entities.length > 0) {
    concept.entities = result.entities
    fields.push({ field: 'concept.entities', source: 'utility', evidence: provenance.outputSha256 })
  }
  if (gaps.has('concept.relationships') && result.relationships.length > 0) {
    concept.relationships = result.relationships
    fields.push({ field: 'concept.relationships', source: 'utility', evidence: provenance.outputSha256 })
  }
  if (gaps.has('concept.openQuestions') && result.openQuestions.length > 0) {
    concept.openQuestions = result.openQuestions
    fields.push({ field: 'concept.openQuestions', source: 'utility', evidence: provenance.outputSha256 })
  }
  if (gaps.has('concept.searchTerms') && result.searchTerms.length > 0) {
    concept.searchTerms = unique([...concept.searchTerms, ...result.searchTerms.map(term => clean(term, 120)).filter(Boolean)], 20)
    fields.push({ field: 'concept.searchTerms', source: 'utility', evidence: provenance.outputSha256 })
  }
  let remaining = [...projection.completeness.missingFields]
  remaining = withoutGap(remaining, 'concept.type', concept.type !== null)
  remaining = withoutGap(remaining, 'concept.summary', concept.summary.length > 0)
  remaining = withoutGap(remaining, 'concept.tags', concept.tags.length > 0)
  remaining = withoutGap(remaining, 'concept.entities', concept.entities.length > 0)
  remaining = withoutGap(remaining, 'concept.relationships', concept.relationships.length > 0)
  remaining = withoutGap(remaining, 'concept.openQuestions', concept.openQuestions.length > 0)
  remaining = withoutGap(remaining, 'concept.searchTerms', !gaps.has('concept.searchTerms') || result.searchTerms.length > 0)
  return KnowledgeProjectionSchema.parse({
    ...projection,
    concept,
    completeness: { state: completenessState(remaining), missingFields: remaining },
    provenance: { ...projection.provenance, fields, utility: provenance }
  })
}

export const knowledgeSearchText = (projection: KnowledgeProjection): string =>
  clean(
    [
      projection.concept.type ?? '',
      projection.concept.title,
      projection.concept.description,
      projection.concept.summary,
      ...projection.concept.tags,
      ...projection.concept.searchTerms,
      ...projection.concept.entities.flatMap(entity => [entity.name, entity.type]),
      ...projection.concept.relationships.flatMap(relationship => [relationship.subject, relationship.predicate, relationship.object]),
      ...projection.concept.openQuestions
    ]
      .join(' ')
      .toLocaleLowerCase(),
    50_000
  )

export const knowledgeProjectionView = (projection: KnowledgeProjection, now = new Date()): KnowledgeProjectionView =>
  KnowledgeProjectionViewSchema.parse({
    schemaVersion: projection.version,
    sourceRevision: projection.source.sourceRevision,
    state: projection.completeness.state,
    conceptType: projection.concept.type,
    summary: projection.concept.summary,
    tags: projection.concept.tags,
    searchTerms: projection.concept.searchTerms,
    entities: projection.concept.entities,
    relationships: projection.concept.relationships,
    openQuestions: projection.concept.openQuestions,
    lifecycle: {
      ...projection.lifecycle,
      stale: projection.lifecycle.staleAfter !== null && now.valueOf() >= Date.parse(projection.lifecycle.staleAfter)
    },
    missingFields: projection.completeness.missingFields,
    provenance: {
      deterministicVersion: projection.provenance.deterministicVersion,
      fields: projection.provenance.fields,
      utility: projection.provenance.utility
    }
  })
