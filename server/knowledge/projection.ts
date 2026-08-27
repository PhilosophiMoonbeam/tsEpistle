import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from '../helpers/canonical-json.ts'

export const KNOWLEDGE_SCHEMA_VERSION = 1 as const
export const KNOWLEDGE_DETERMINISTIC_VERSION = 'wiki-knowledge-v1' as const

const LifecycleStatusSchema = z.enum(['draft', 'stable', 'deprecated'])
const TrustTierSchema = z.enum(['unverified', 'machine-confirmed', 'human-reviewed'])
const VerificationSchema = z.enum(['unverified', 'current', 'outdated'])
const GapSchema = z.enum([
  'concept.type',
  'concept.summary',
  'concept.tags',
  'concept.entities',
  'concept.relationships',
  'concept.openQuestions'
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
  openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(20)
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
    id: z.string().min(1).max(1_100),
    type: z.string().min(1).max(128).nullable(),
    title: z.string().min(1).max(255),
    description: z.string().max(2_000),
    summary: z.string().max(2_000),
    tags: z.array(z.string().min(1).max(255)).max(100),
    sections: z.array(z.strictObject({
      id: z.string().min(1).max(255),
      title: z.string().min(1).max(512),
      level: z.number().int().min(1).max(6),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/)
    })).max(100),
    links: z.array(z.strictObject({
      label: z.string().max(512),
      target: z.string().min(1).max(4_096),
      kind: z.enum(['page', 'external']),
      line: z.number().int().positive()
    })).max(100),
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
    missingFields: z.array(GapSchema).max(6)
  }),
  provenance: z.strictObject({
    deterministicVersion: z.literal(KNOWLEDGE_DETERMINISTIC_VERSION),
    fields: z.array(FieldProvenanceSchema).max(100),
    utility: z.strictObject({
      profileVersionId: z.uuid(),
      model: z.string().min(1).max(255),
      inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      generatedAt: z.string().datetime()
    }).nullable()
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
  missingFields: z.array(GapSchema).max(6),
  provenance: z.strictObject({
    deterministicVersion: z.literal(KNOWLEDGE_DETERMINISTIC_VERSION),
    utility: z.strictObject({
      profileVersionId: z.uuid(),
      model: z.string().min(1).max(255),
      inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      generatedAt: z.string().datetime()
    }).nullable()
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
const clean = (value: string, maximum: number): string => [...value.replace(/\s+/gu, ' ').trim()].slice(0, maximum).join('')
const unique = (values: readonly string[], maximum: number): string[] => [...new Map(values.map(value => [value.toLocaleLowerCase(), value] as const)).values()].slice(0, maximum)
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
const validDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}
const actorEvents = (value: unknown): readonly Record<string, unknown>[] => {
  const values: readonly unknown[] = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return values.flatMap(item => {
    const parsed = record(item)
    return parsed === null ? [] : [parsed]
  })
}
const tagValues = (values: readonly string[]): string[] => unique(values.map(value => clean(value, 255)).filter(Boolean), 100)
const sourceSha256 = (input: KnowledgePageSource, sourceRevision: string): string => sha256(canonicalJson({
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
}))

const plainText = (content: string, contentType: string): string => {
  const withoutCode = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' ')
  if (contentType === 'markdown') {
    return clean(withoutCode
      .replace(/^ {0,3}#{1,6}\s+.*$/gmu, ' ')
      .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, '$1')
      .replace(/[*_`~>|-]/gu, ' '), 20_000)
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
  const normalized = value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/gu, '')
  return (normalized || fallback).slice(0, 255)
}

const sections = (content: string, contentType: string): KnowledgeProjection['concept']['sections'] => {
  if (contentType !== 'markdown') return []
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const headings: Array<{ index: number; level: number; title: string }> = []
  let fence: string | null = null
  for (let index = 0; index < lines.length && headings.length < 100; index += 1) {
    const line = lines[index]!
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    if (match) headings.push({ index, level: match[1]!.length, title: clean(match[2]!, 512) })
  }
  const occurrences = new Map<string, number>()
  return headings.map((heading, offset) => {
    const base = slug(heading.title, `section-${offset + 1}`)
    const occurrence = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, occurrence)
    let endIndex = (headings[offset + 1]?.index ?? lines.length) - 1
    while (endIndex > heading.index && lines[endIndex]?.trim() === '') endIndex -= 1
    return {
      id: occurrence === 1 ? base : `${base}-${occurrence}`.slice(0, 255),
      title: heading.title,
      level: heading.level,
      startLine: heading.index + 1,
      endLine: Math.max(heading.index + 1, endIndex + 1),
      sha256: sha256(lines.slice(heading.index, endIndex + 1).join('\n'))
    }
  })
}

const links = (content: string, contentType: string): KnowledgeProjection['concept']['links'] => {
  if (contentType !== 'markdown') return []
  const results: KnowledgeProjection['concept']['links'] = []
  const expression = /\[([^\]\n]*)\]\(\s*(<?)([^\s)>\n]+)>?(?:\s+['"][^'"\n]*['"])?\s*\)/gu
  for (const match of content.matchAll(expression)) {
    if (results.length >= 100) break
    const target = match[3]!
    if (target.startsWith('#') || /^(?:mailto|tel|data|javascript):/iu.test(target)) continue
    results.push({
      label: clean(match[1]!, 512),
      target: target.slice(0, 4_096),
      kind: /^https?:\/\//iu.test(target) ? 'external' : 'page',
      line: content.slice(0, match.index).split(/\r?\n/u).length
    })
  }
  return results
}

const metadataLifecycle = (metadataValue: unknown, input: KnowledgePageSource): KnowledgeProjection['lifecycle'] => {
  const metadata = record(metadataValue)
  const generated = record(metadata?.generated)
  const generatedAt = validDate(generated?.at) ?? new Date(input.updatedAt).toISOString()
  const verified = actorEvents(metadata?.verified)
  const verifiedDates = verified.flatMap(event => validDate(event.at) ?? []).sort()
  const verifiedAt = verifiedDates.at(-1) ?? null
  const trustTier = verified.length === 0 ? 'unverified' : verified.some(event => typeof event.by === 'string' && event.by.startsWith('human:')) ? 'human-reviewed' : 'machine-confirmed'
  return {
    status: LifecycleStatusSchema.safeParse(metadata?.status).data ?? 'stable',
    trustTier,
    verification: verified.length === 0 ? 'unverified' : verifiedAt === null || Date.parse(verifiedAt) < Date.parse(generatedAt) ? 'outdated' : 'current',
    generatedAt,
    verifiedAt,
    staleAfter: validDate(metadata?.stale_after)
  }
}

export const projectPageKnowledge = (input: KnowledgePageSource): KnowledgeProjection => {
  const sourceRevision = String(input.sourceRevision)
  if (!/^[1-9][0-9]*$/.test(sourceRevision)) throw new Error('Page knowledge source revision is invalid')
  const metadata = record(input.metadata)
  const type = typeof metadata?.type === 'string' ? clean(metadata.type, 128) || null : null
  const summary = deterministicSummary(input)
  const tags = tagValues(input.tags)
  const pageLinks = links(input.content, input.contentType)
  const sources = pageLinks.filter(link => link.kind === 'external').map(link => ({ resource: link.target, title: link.label || null }))
  const entities = unique(pageLinks.filter(link => link.kind === 'page').map(link => link.label || link.target), 20).map(name => ({ name, type: 'WikiPage' }))
  const relationships = pageLinks.filter(link => link.kind === 'page').slice(0, 20).map(link => ({ subject: input.title, predicate: 'linksTo', object: link.target }))
  const lifecycle = metadataLifecycle(metadata, input)
  const missingFields: KnowledgeGap[] = [
    ...(type === null ? ['concept.type' as const] : []),
    ...(summary === '' ? ['concept.summary' as const] : []),
    ...(tags.length === 0 ? ['concept.tags' as const] : []),
    ...(entities.length === 0 ? ['concept.entities' as const] : []),
    ...(relationships.length === 0 ? ['concept.relationships' as const] : []),
    ...(lifecycle.status === 'draft' ? ['concept.openQuestions' as const] : [])
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
      sections: sections(input.content, input.contentType),
      links: pageLinks,
      sources,
      entities,
      relationships,
      openQuestions: []
    },
    lifecycle,
    completeness: { state: missingFields.length === 0 ? 'complete' : 'partial', missingFields },
    provenance: {
      deterministicVersion: KNOWLEDGE_DETERMINISTIC_VERSION,
      fields: [
        { field: 'concept.title', source: 'page', evidence: 'pages.title' },
        { field: 'concept.description', source: 'page', evidence: 'pages.description' },
        { field: 'concept.summary', source: input.description?.trim() ? 'page' : 'deterministic', evidence: input.description?.trim() ? 'pages.description' : 'first source paragraph' },
        { field: 'concept.tags', source: 'page', evidence: 'pageTags' },
        { field: 'concept.type', source: type === null ? 'deterministic' : 'metadata', evidence: type === null ? 'missing' : 'pages.extra.okf.type' },
        { field: 'concept.sections', source: 'deterministic', evidence: 'Markdown heading spans and hashes' },
        { field: 'concept.links', source: 'deterministic', evidence: 'Markdown link destinations' },
        { field: 'lifecycle', source: metadata === null ? 'deterministic' : 'metadata', evidence: metadata === null ? 'page revision timestamps' : 'pages.extra.okf lifecycle fields' }
      ],
      utility: null
    }
  }
  return KnowledgeProjectionSchema.parse(projection)
}

const withoutGap = (gaps: readonly KnowledgeGap[], field: KnowledgeGap, filled: boolean): KnowledgeGap[] => filled ? gaps.filter(gap => gap !== field) : [...gaps]

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
  let remaining = [...projection.completeness.missingFields]
  remaining = withoutGap(remaining, 'concept.type', concept.type !== null)
  remaining = withoutGap(remaining, 'concept.summary', concept.summary.length > 0)
  remaining = withoutGap(remaining, 'concept.tags', concept.tags.length > 0)
  remaining = withoutGap(remaining, 'concept.entities', concept.entities.length > 0)
  remaining = withoutGap(remaining, 'concept.relationships', concept.relationships.length > 0)
  remaining = withoutGap(remaining, 'concept.openQuestions', concept.openQuestions.length > 0)
  return KnowledgeProjectionSchema.parse({
    ...projection,
    concept,
    completeness: { state: remaining.length === 0 ? 'complete' : 'partial', missingFields: remaining },
    provenance: { ...projection.provenance, fields, utility: provenance }
  })
}

export const knowledgeSearchText = (projection: KnowledgeProjection): string => clean([
  projection.concept.type ?? '',
  projection.concept.title,
  projection.concept.description,
  projection.concept.summary,
  ...projection.concept.tags,
  ...projection.concept.entities.flatMap(entity => [entity.name, entity.type]),
  ...projection.concept.relationships.flatMap(relationship => [relationship.subject, relationship.predicate, relationship.object]),
  ...projection.concept.openQuestions
].join(' ').toLocaleLowerCase(), 50_000)

export const knowledgeProjectionView = (projection: KnowledgeProjection, now = new Date()): KnowledgeProjectionView => KnowledgeProjectionViewSchema.parse({
  schemaVersion: projection.version,
  sourceRevision: projection.source.sourceRevision,
  state: projection.completeness.state,
  conceptType: projection.concept.type,
  summary: projection.concept.summary,
  tags: projection.concept.tags,
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
    utility: projection.provenance.utility
  }
})
