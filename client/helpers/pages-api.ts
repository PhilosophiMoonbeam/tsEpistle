import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'
import { parseCollaborationSession, type CollaborationSession } from '../../shared/collaboration'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  status?: number
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (
  url: string,
  init: {
    method?: string
    credentials: 'same-origin'
    headers: {
      Accept: 'application/json'
      'Content-Type'?: 'application/json'
    }
    body?: string
  }
) => Promise<JsonResponse>

type MessageResponse = {
  message: string
}
export type OkfAuthorityState = 'valid' | 'missing' | 'invalid'

export type OkfActorEvent = {
  by: string
  at?: string
  [key: string]: unknown
}

export type OkfSource = {
  resource: string
  id?: string
  title?: string
  [key: string]: unknown
}

export type OkfMetadata = {
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
  [key: string]: unknown
}

export type OkfTrustSummary = {
  trustTier: 'unverified' | 'machine-confirmed' | 'human-reviewed'
  verification: 'unverified' | 'current' | 'outdated'
  status: 'draft' | 'stable' | 'deprecated'
  stale: boolean
  generatedAt: string | null
  verifiedAt: string | null
}

export type KnowledgeProjectionView = {
  schemaVersion: 1
  sourceRevision: string
  state: 'complete' | 'partial'
  conceptType: string | null
  summary: string
  tags: string[]
  entities: Array<{ name: string; type: string }>
  relationships: Array<{ subject: string; predicate: string; object: string }>
  openQuestions: string[]
  lifecycle: {
    status: 'draft' | 'stable' | 'deprecated'
    trustTier: 'unverified' | 'machine-confirmed' | 'human-reviewed'
    verification: 'unverified' | 'current' | 'outdated'
    stale: boolean
    generatedAt: string
    verifiedAt: string | null
    staleAfter: string | null
  }
  missingFields: Array<'concept.type' | 'concept.summary' | 'concept.tags' | 'concept.entities' | 'concept.relationships' | 'concept.openQuestions'>
  provenance: {
    deterministicVersion: 'wiki-knowledge-v1'
    fields?: Array<{ field: string; source: 'page' | 'metadata' | 'deterministic' | 'utility'; evidence: string }>
    utility: {
      profileVersionId: string
      model: string
      inputSha256: string
      outputSha256: string
      generatedAt: string
    } | null
  }
}

export type PageOkfView = {
  authority: {
    state: OkfAuthorityState
    metadata: OkfMetadata | null
    trust: OkfTrustSummary | null
  }
  projection: {
    state: 'current' | 'pending'
    value: KnowledgeProjectionView | null
  }
}

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u
const MAX_OKF_TREE_DEPTH = 20
const MAX_OKF_TREE_NODES = 5_000
const DANGEROUS_OKF_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed: Record<string, true> = Object.fromEntries(keys.map(key => [key, true]))
  return Object.keys(value).every(key => allowed[key] === true)
}
const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}
const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
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
const boundedJsonTree = (root: unknown): boolean => {
  let nodes = 0
  const visit = (value: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > MAX_OKF_TREE_NODES || depth > MAX_OKF_TREE_DEPTH) return false
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(entry => visit(entry, depth + 1))
    if (!isRecord(value)) return false
    return Object.entries(value).every(([key, entry]) => !DANGEROUS_OKF_KEYS.has(key) && visit(entry, depth + 1))
  }
  return visit(root, 0)
}
const nonEmptyBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum
const normalizeActor = (value: unknown): OkfActorEvent | null => {
  if (!isRecord(value) || !nonEmptyBoundedString(value.by, 255)) return null
  if (value.at !== undefined && (!nonEmptyBoundedString(value.at, 64) || !isIsoDate(value.at))) return null
  return { ...value } as OkfActorEvent
}
const okfMetadataValidationMessage = (value: unknown): string | null => {
  if (!isRecord(value)) return 'Metadata must be an object.'
  if (!boundedJsonTree(value)) return 'Extension values must be finite JSON within the supported size limits.'
  if (!nonEmptyBoundedString(value.type, 128)) return 'Type is required and must be at most 128 characters.'
  if (value.title !== undefined && !nonEmptyBoundedString(value.title, 255)) return 'Title must be between 1 and 255 characters.'
  if (value.description !== undefined && !nonEmptyBoundedString(value.description, 2_000)) return 'Description must be between 1 and 2,000 characters.'
  if (value.resource !== undefined && !nonEmptyBoundedString(value.resource, 4_096)) return 'Resource must be between 1 and 4,096 characters.'
  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some(tag => !nonEmptyBoundedString(tag, 255)))
  ) return 'Tags must contain at most 100 non-empty values of at most 255 characters each.'
  if (value.status !== undefined && value.status !== 'draft' && value.status !== 'stable' && value.status !== 'deprecated') return 'Status must be draft, stable, or deprecated.'
  if (value.generated !== undefined && normalizeActor(value.generated) === null) return 'Generated must identify an actor and may include a valid ISO-8601 timestamp.'
  if (value.verified !== undefined) {
    const events = Array.isArray(value.verified) ? value.verified : [value.verified]
    if (events.length < 1 || events.length > 100 || events.some(event => normalizeActor(event) === null)) return 'Verified must contain between 1 and 100 valid actor events.'
  }
  if (value.stale_after !== undefined && (!nonEmptyBoundedString(value.stale_after, 64) || !isIsoDate(value.stale_after))) return 'Stale after must be a valid ISO-8601 timestamp.'
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > 100) return 'Sources must contain at most 100 entries.'
    for (const [index, source] of value.sources.entries()) {
      if (!isRecord(source)) return `Source ${index + 1} must be an object.`
      const { resource, id, title } = source
      if (!nonEmptyBoundedString(resource, 4_096)) return `Source ${index + 1} resource is required and must be at most 4,096 characters.`
      if (id !== undefined && !nonEmptyBoundedString(id, 255)) return `Source ${index + 1} ID must be between 1 and 255 characters.`
      if (title !== undefined && !nonEmptyBoundedString(title, 512)) return `Source ${index + 1} title must be between 1 and 512 characters.`
    }
  }
  return null
}
const normalizeOkfMetadata = (value: unknown): OkfMetadata | null => {
  if (okfMetadataValidationMessage(value) !== null) return null
  return { ...(value as Record<string, unknown>) } as OkfMetadata
}
const normalizeTrust = (value: unknown): OkfTrustSummary | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['trustTier', 'verification', 'status', 'stale', 'generatedAt', 'verifiedAt'])) return null
  if (
    (value.trustTier !== 'unverified' && value.trustTier !== 'machine-confirmed' && value.trustTier !== 'human-reviewed') ||
    (value.verification !== 'unverified' && value.verification !== 'current' && value.verification !== 'outdated') ||
    (value.status !== 'draft' && value.status !== 'stable' && value.status !== 'deprecated') ||
    typeof value.stale !== 'boolean' ||
    (value.generatedAt !== null && !isIsoDate(value.generatedAt)) ||
    (value.verifiedAt !== null && !isIsoDate(value.verifiedAt))
  ) return null
  return value as OkfTrustSummary
}
const normalizeProjection = (value: unknown): KnowledgeProjectionView | null => {
  if (
    !isRecord(value) ||
    !boundedJsonTree(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'sourceRevision', 'state', 'conceptType', 'summary', 'tags', 'entities', 'relationships', 'openQuestions', 'lifecycle', 'missingFields', 'provenance']) ||
    value.schemaVersion !== 1 ||
    !nonEmptyBoundedString(value.sourceRevision, 64) ||
    !/^[1-9][0-9]*$/u.test(value.sourceRevision) ||
    (value.state !== 'complete' && value.state !== 'partial') ||
    (value.conceptType !== null && !nonEmptyBoundedString(value.conceptType, 128)) ||
    typeof value.summary !== 'string' ||
    value.summary.length > 2_000 ||
    !Array.isArray(value.tags) ||
    value.tags.length > 100 ||
    value.tags.some(tag => !nonEmptyBoundedString(tag, 255)) ||
    !Array.isArray(value.entities) ||
    value.entities.length > 20 ||
    value.entities.some(entity => !isRecord(entity) || !hasOnlyKeys(entity, ['name', 'type']) || !nonEmptyBoundedString(entity.name, 255) || !nonEmptyBoundedString(entity.type, 128)) ||
    !Array.isArray(value.relationships) ||
    value.relationships.length > 20 ||
    value.relationships.some(relationship => !isRecord(relationship) || !hasOnlyKeys(relationship, ['subject', 'predicate', 'object']) || !nonEmptyBoundedString(relationship.subject, 255) || !nonEmptyBoundedString(relationship.predicate, 128) || !nonEmptyBoundedString(relationship.object, 1_024)) ||
    !Array.isArray(value.openQuestions) ||
    value.openQuestions.length > 20 ||
    value.openQuestions.some(question => !nonEmptyBoundedString(question, 1_000)) ||
    !isRecord(value.lifecycle) ||
    !hasOnlyKeys(value.lifecycle, ['status', 'trustTier', 'verification', 'stale', 'generatedAt', 'verifiedAt', 'staleAfter']) ||
    (value.lifecycle.status !== 'draft' && value.lifecycle.status !== 'stable' && value.lifecycle.status !== 'deprecated') ||
    (value.lifecycle.trustTier !== 'unverified' && value.lifecycle.trustTier !== 'machine-confirmed' && value.lifecycle.trustTier !== 'human-reviewed') ||
    (value.lifecycle.verification !== 'unverified' && value.lifecycle.verification !== 'current' && value.lifecycle.verification !== 'outdated') ||
    typeof value.lifecycle.stale !== 'boolean' ||
    !isIsoDate(value.lifecycle.generatedAt) ||
    (value.lifecycle.verifiedAt !== null && !isIsoDate(value.lifecycle.verifiedAt)) ||
    (value.lifecycle.staleAfter !== null && !isIsoDate(value.lifecycle.staleAfter)) ||
    !Array.isArray(value.missingFields) ||
    value.missingFields.length > 6 ||
    value.missingFields.some(field => !['concept.type', 'concept.summary', 'concept.tags', 'concept.entities', 'concept.relationships', 'concept.openQuestions'].includes(field)) ||
    !isRecord(value.provenance) ||
    !hasOnlyKeys(value.provenance, ['deterministicVersion', 'fields', 'utility']) ||
    value.provenance.deterministicVersion !== 'wiki-knowledge-v1'
  ) return null
  const fields = value.provenance.fields
  if (
    fields !== undefined &&
    (!Array.isArray(fields) || fields.length > 100 || fields.some(field => !isRecord(field) || !hasOnlyKeys(field, ['field', 'source', 'evidence']) || !nonEmptyBoundedString(field.field, 128) || typeof field.source !== 'string' || !['page', 'metadata', 'deterministic', 'utility'].includes(field.source) || !nonEmptyBoundedString(field.evidence, 1_024)))
  ) return null
  const utility = value.provenance.utility
  if (utility !== null && (!isRecord(utility) || !hasOnlyKeys(utility, ['profileVersionId', 'model', 'inputSha256', 'outputSha256', 'generatedAt']) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(utility.profileVersionId)) || !nonEmptyBoundedString(utility.model, 255) || !/^[a-f0-9]{64}$/u.test(String(utility.inputSha256)) || !/^[a-f0-9]{64}$/u.test(String(utility.outputSha256)) || !isIsoDate(utility.generatedAt))) return null
  return value as KnowledgeProjectionView
}
const normalizePageOkf = (value: unknown, sourceRevision: string, fallbackMessage: string): PageOkfView => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['authority', 'projection']) || !isRecord(value.authority) || !hasOnlyKeys(value.authority, ['state', 'metadata', 'trust'])) throw new Error(fallbackMessage)
  const state = value.authority.state
  if (state !== 'valid' && state !== 'missing' && state !== 'invalid') throw new Error(fallbackMessage)
  const metadata = value.authority.metadata === null ? null : normalizeOkfMetadata(value.authority.metadata)
  const trust = value.authority.trust === null ? null : normalizeTrust(value.authority.trust)
  if (value.authority.metadata !== null && metadata === null || value.authority.trust !== null && trust === null) throw new Error(fallbackMessage)
  if (state !== 'valid' && (metadata !== null || trust !== null)) throw new Error(fallbackMessage)
  if (state === 'valid' && (metadata === null || trust === null)) throw new Error(fallbackMessage)
  if (!isRecord(value.projection) || !hasOnlyKeys(value.projection, ['state', 'value']) || (value.projection.state !== 'current' && value.projection.state !== 'pending')) throw new Error(fallbackMessage)
  const projection = value.projection.value === null ? null : normalizeProjection(value.projection.value)
  if (value.projection.value !== null && projection === null) throw new Error(fallbackMessage)
  if (value.projection.state === 'pending' && projection !== null) throw new Error(fallbackMessage)
  if (value.projection.state === 'current' && (projection === null || projection.sourceRevision !== sourceRevision)) throw new Error(fallbackMessage)
  return { authority: { state, metadata, trust }, projection: { state: value.projection.state, value: projection } }
}
const defaultPageOkf = (): PageOkfView => ({
  authority: { state: 'invalid', metadata: null, trust: null },
  projection: { state: 'pending', value: null }
})



export type PageDetails = {
  id: number
  locale: string
  path: string
  hash: string
  title: string | null
  description: string | null
  visibility: 'public' | 'private'
  ownerId: number | null
  isPublished: boolean
  publishStartDate: string | null
  publishEndDate: string | null
  contentType: string
  createdAt: string
  updatedAt: string
  sourceRevision: string
  editor: string
  authorId: number
  authorName: string
  authorEmail: string
  creatorId: number
  creatorName: string
  creatorEmail: string
  okf: PageOkfView
}

export type PageLinkRow = {
  id: number
  path: string
  title: string
  links: string[]
}

export type PageLocaleRelation = {
  id: number
  locale: string
  path: string
  title: string
  visibility: 'public' | 'private'
}

export type PageListRow = {
  id: number
  locale: string
  path: string
  title: string | null
  description: string | null
  isPublished: boolean
  visibility: 'public' | 'private'
  ownerId: number | null
  contentType: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

export type RecentPageRow = {
  id: number
  locale: string
  path: string
  title: string
  updatedAt: string
  visibility: 'public' | 'private'
}

export type PageTagRow = {
  id: number
  tag: string
  title: string | null
  createdAt: string
  updatedAt: string
}

async function parseJsonResponse(response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    let message = fallbackMessage
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const error = (payload as { error?: unknown }).error
      const detail = (payload as { message?: unknown }).message
      if (typeof error === 'string' && error.length > 0) message = error
      else if (typeof detail === 'string' && detail.length > 0) message = detail
    }
    throw Object.assign(new Error(message), { status: response.status })
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizePageTagRow(row: unknown, fallbackMessage: string): PageTagRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const tagRow = row as Partial<PageTagRow>
  if (
    !Number.isInteger(tagRow.id) ||
    typeof tagRow.tag !== 'string' ||
    (tagRow.title !== null && typeof tagRow.title !== 'string') ||
    typeof tagRow.createdAt !== 'string' ||
    tagRow.createdAt.length < 1 ||
    typeof tagRow.updatedAt !== 'string' ||
    tagRow.updatedAt.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: tagRow.id!,
    tag: tagRow.tag,
    title: tagRow.title,
    createdAt: tagRow.createdAt,
    updatedAt: tagRow.updatedAt
  }
}

function normalizePageDetails(row: unknown, fallbackMessage: string): PageDetails {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const page = row as Partial<PageDetails>
  const ownerId = page.ownerId
  const sourceRevision: unknown = page.sourceRevision
  const normalizedSourceRevision = String(sourceRevision)
  const validOwner = ownerId === null || (typeof ownerId === 'number' && Number.isSafeInteger(ownerId))
  if (
    !Number.isInteger(page.id) ||
    typeof page.locale !== 'string' ||
    page.locale.length < 1 ||
    typeof page.path !== 'string' ||
    typeof page.hash !== 'string' ||
    (page.title !== null && typeof page.title !== 'string') ||
    (page.description !== null && typeof page.description !== 'string') ||
    (page.visibility !== 'public' && page.visibility !== 'private') ||
    !validOwner ||
    typeof page.isPublished !== 'boolean' ||
    (page.publishStartDate !== null && typeof page.publishStartDate !== 'string') ||
    (page.publishEndDate !== null && typeof page.publishEndDate !== 'string') ||
    typeof page.contentType !== 'string' ||
    typeof page.createdAt !== 'string' ||
    page.createdAt.length < 1 ||
    typeof page.updatedAt !== 'string' ||
    page.updatedAt.length < 1 ||
    (typeof sourceRevision !== 'string' && typeof sourceRevision !== 'number') ||
    !/^[1-9][0-9]*$/u.test(normalizedSourceRevision) ||
    typeof page.editor !== 'string' ||
    !Number.isInteger(page.authorId) ||
    typeof page.authorName !== 'string' ||
    typeof page.authorEmail !== 'string' ||
    !Number.isInteger(page.creatorId) ||
    typeof page.creatorName !== 'string' ||
    typeof page.creatorEmail !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  const okf = (row as Record<string, unknown>).okf === undefined || (row as Record<string, unknown>).okf === null
    ? defaultPageOkf()
    : normalizePageOkf((row as Record<string, unknown>).okf, normalizedSourceRevision, fallbackMessage)

  return {
    id: page.id!,
    locale: page.locale,
    path: page.path,
    hash: page.hash,
    title: page.title,
    description: page.description,
    visibility: page.visibility,
    ownerId,
    isPublished: page.isPublished,
    publishStartDate: page.publishStartDate,
    publishEndDate: page.publishEndDate,
    contentType: page.contentType,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    sourceRevision: normalizedSourceRevision,
    editor: page.editor,
    authorId: page.authorId!,
    authorName: page.authorName,
    authorEmail: page.authorEmail,
    creatorId: page.creatorId!,
    creatorName: page.creatorName,
    creatorEmail: page.creatorEmail,
    okf
  }
}
const EDITABLE_OKF_EXCLUDED_KEYS: Record<string, true> = {
  title: true,
  description: true,
  tags: true,
  generated: true,
  verified: true,
  restored_from: true,
  'x-wiki': true
}
export class OkfMetadataValidationError extends Error {
  constructor (detail: string) {
    super(`Fix the Knowledge / OKF metadata before saving: ${detail}`)
    this.name = 'OkfMetadataValidationError'
  }
}
export type OkfMetadataPayloadValidation =
  | { valid: true; payload: Record<string, unknown> | undefined }
  | { valid: false; error: OkfMetadataValidationError }
export function validateOkfMetadataPayload(value: unknown): OkfMetadataPayloadValidation {
  if (value === null || value === undefined) return { valid: true, payload: undefined }
  const detail = okfMetadataValidationMessage(value)
  if (detail !== null) return { valid: false, error: new OkfMetadataValidationError(detail) }
  const editable: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (EDITABLE_OKF_EXCLUDED_KEYS[key] === true) continue
    editable[key] = entry
  }
  return { valid: true, payload: editable }
}
export function buildOkfMetadataPayload(value: unknown): Record<string, unknown> | undefined {
  const result = validateOkfMetadataPayload(value)
  if (!result.valid) throw result.error
  return result.payload
}


function normalizePageLinkRow(row: unknown, fallbackMessage: string): PageLinkRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<PageLinkRow>
  if (
    !Number.isInteger(pageRow.id) ||
    typeof pageRow.path !== 'string' ||
    pageRow.path.length < 1 ||
    typeof pageRow.title !== 'string' ||
    !Array.isArray(pageRow.links) ||
    pageRow.links.some(link => typeof link !== 'string')
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id!,
    path: pageRow.path,
    title: pageRow.title,
    links: pageRow.links
  }
}

function normalizePageLocaleRelation(row: unknown, fallbackMessage: string): PageLocaleRelation {
  if (
    !isRecord(row) ||
    typeof row.id !== 'number' ||
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.locale !== 'string' ||
    row.locale.length < 1 ||
    typeof row.path !== 'string' ||
    typeof row.title !== 'string' ||
    (row.visibility !== 'public' && row.visibility !== 'private')
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    id: row.id,
    locale: row.locale,
    path: row.path,
    title: row.title,
    visibility: row.visibility
  }
}

function normalizePageListRow(row: unknown, fallbackMessage: string): PageListRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<PageListRow>
  const ownerId = pageRow.ownerId
  const validOwner = ownerId === null || (typeof ownerId === 'number' && Number.isSafeInteger(ownerId))
  if (
    !Number.isInteger(pageRow.id) ||
    typeof pageRow.locale !== 'string' ||
    pageRow.locale.length < 1 ||
    typeof pageRow.path !== 'string' ||
    (pageRow.title !== null && typeof pageRow.title !== 'string') ||
    (pageRow.description !== null && typeof pageRow.description !== 'string') ||
    typeof pageRow.isPublished !== 'boolean' ||
    (pageRow.visibility !== 'public' && pageRow.visibility !== 'private') ||
    !validOwner ||
    typeof pageRow.contentType !== 'string' ||
    typeof pageRow.createdAt !== 'string' ||
    pageRow.createdAt.length < 1 ||
    typeof pageRow.updatedAt !== 'string' ||
    pageRow.updatedAt.length < 1 ||
    !Array.isArray(pageRow.tags) ||
    pageRow.tags.some(tag => typeof tag !== 'string')
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id!,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    description: pageRow.description,
    isPublished: pageRow.isPublished,
    visibility: pageRow.visibility,
    ownerId,
    contentType: pageRow.contentType,
    createdAt: pageRow.createdAt,
    updatedAt: pageRow.updatedAt,
    tags: pageRow.tags
  }
}

function normalizeRecentPageRow(row: unknown, fallbackMessage: string): RecentPageRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<RecentPageRow>
  if (
    !Number.isInteger(pageRow.id) ||
    typeof pageRow.locale !== 'string' ||
    pageRow.locale.length < 1 ||
    typeof pageRow.path !== 'string' ||
    typeof pageRow.title !== 'string' ||
    typeof pageRow.updatedAt !== 'string' ||
    pageRow.updatedAt.length < 1 ||
    (pageRow.visibility !== 'public' && pageRow.visibility !== 'private')
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id!,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    updatedAt: pageRow.updatedAt,
    visibility: pageRow.visibility
  }
}

export async function fetchPageLinks(fetchImpl: FetchImpl, locale: string, fallbackMessage = 'Page links response is invalid'): Promise<PageLinkRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/links?locale=${encodeURIComponent(locale)}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizePageLinkRow(row, fallbackMessage))
}

export async function fetchPage(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Page response is invalid'): Promise<PageDetails> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizePageDetails(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function fetchPageList(fetchImpl: FetchImpl, fallbackMessage = 'Page list response is invalid'): Promise<PageListRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/pages', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizePageListRow(row, fallbackMessage))
}

export async function fetchPageTags(fetchImpl: FetchImpl, fallbackMessage = 'Page tags response is invalid'): Promise<PageTagRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/pages/tags', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizePageTagRow(row, fallbackMessage))
}

export async function fetchRecentPages(fetchImpl: FetchImpl, fallbackMessage = 'Recent pages response is invalid'): Promise<RecentPageRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/pages/recent', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeRecentPageRow(row, fallbackMessage))
}
export async function fetchCollaborationSession(
  fetchImpl: FetchImpl,
  pageId: number,
  expectedUpdatedAt: string,
  fallbackMessage = 'Live collaboration could not start'
): Promise<CollaborationSession> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(pageId)}/collaboration/session`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expectedUpdatedAt })
  })
  return parseCollaborationSession(await parseJsonResponse(response, fallbackMessage))
}

export async function updatePageTag(
  fetchImpl: FetchImpl,
  id: number,
  tag: string,
  title: string | null,
  fallbackMessage = 'Tag update failed'
): Promise<MessageResponse> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/tags/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tag, title })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as { message?: unknown }).message !== 'string' ||
    (payload as { message: string }).message.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function deletePageTag(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Tag delete failed'): Promise<MessageResponse> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/tags/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as { message?: unknown }).message !== 'string' ||
    (payload as { message: string }).message.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function deletePage(
  fetchImpl: FetchImpl,
  id: number,
  expectedSourceRevision: string,
  fallbackMessage = 'Page delete failed'
): Promise<MessageResponse> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expectedSourceRevision })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as { message?: unknown }).message !== 'string' ||
    (payload as { message: string }).message.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

type PageWriteInput = {
  content: string
  description: string
  editor: string
  visibility: 'public' | 'private'
  isPublished: boolean
  locale: string
  path: string
  publishEndDate: string
  publishStartDate: string
  scriptCss: string
  scriptJs: string
  tags: string[]
  title: string
  okfMetadata?: Record<string, unknown>
}

export type PageConflictLatest = {
  updatedAt: string
  authorName: string
  content: string
  locale: string
  path: string
  title: string
  description: string
}

export type PageTreeRow = {
  id: number
  path: string
  title: string
  isFolder: boolean
  pageId: number | null
  parent: number
  locale: string
  visibility: 'public' | 'private'
  ownerId: number | null
  canEdit?: boolean
}

export type PageSearchMatchField = 'title' | 'tag' | 'path' | 'description' | 'content' | 'graph'

export type PageSearchRow = {
  id: string | number
  title: string
  description: string
  path: string
  locale: string
  visibility: 'public' | 'private'
  tags: string[]
  score: number
  matchedFields: PageSearchMatchField[]
}

export type PageSearchResult = {
  results: PageSearchRow[]
  suggestions: string[]
  totalHits: number
}

async function sendJson(fetchImpl: FetchImpl, url: string, method: string, body: unknown, fallbackMessage: string): Promise<unknown> {
  const response = await sameOriginJsonFetch(fetchImpl, url, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return parseJsonResponse(response, fallbackMessage)
}

type WrittenPage = {
  id: number
  updatedAt: string
  sourceRevision: string
}

function normalizeWrittenPage(payload: unknown, fallbackMessage: string, requireId: boolean): WrittenPage {
  if (!isRecord(payload) || !isRecord(payload.page) || typeof payload.page.updatedAt !== 'string') throw new Error(fallbackMessage)
  const sourceRevision = payload.page.sourceRevision
  if ((typeof sourceRevision !== 'string' || sourceRevision.length < 1) && typeof sourceRevision !== 'number') throw new Error(fallbackMessage)
  const id = payload.page.id
  if (requireId && (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)) throw new Error(fallbackMessage)
  return { id: typeof id === 'number' ? id : 0, updatedAt: payload.page.updatedAt, sourceRevision: String(sourceRevision) }
}
function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number'
}

export async function createPage(fetchImpl: FetchImpl, input: PageWriteInput, fallbackMessage = 'Page creation failed'): Promise<WrittenPage> {
  return normalizeWrittenPage(await sendJson(fetchImpl, '/_api/pages', 'POST', input, fallbackMessage), fallbackMessage, true)
}

export async function updatePage(
  fetchImpl: FetchImpl,
  id: number,
  input: PageWriteInput,
  expectedSourceRevision: string,
  fallbackMessage = 'Page update failed'
): Promise<WrittenPage> {
  if (!/^[1-9][0-9]*$/u.test(expectedSourceRevision)) throw new Error(fallbackMessage)
  return normalizeWrittenPage(
    await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}`, 'PUT', { ...input, expectedSourceRevision }, fallbackMessage),
    fallbackMessage,
    false
  )
}

export async function changePageVisibility(
  fetchImpl: FetchImpl,
  id: number,
  visibility: 'public' | 'private',
  expectedSourceRevision: string,
  confirmPublication = false,
  fallbackMessage = 'Page visibility update failed'
): Promise<WrittenPage> {
  return normalizeWrittenPage(
    await sendJson(
      fetchImpl,
      `/_api/pages/${encodeURIComponent(id)}/visibility`,
      'PATCH',
      { visibility, confirmPublication, expectedSourceRevision },
      fallbackMessage
    ),
    fallbackMessage,
    true
  )
}

export async function convertPage(
  fetchImpl: FetchImpl,
  id: number,
  editor: string,
  expectedSourceRevision: string,
  fallbackMessage = 'Page conversion failed'
): Promise<void> {
  await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/convert`, 'POST', { editor, expectedSourceRevision }, fallbackMessage)
}

export async function movePage(
  fetchImpl: FetchImpl,
  id: number,
  destinationLocale: string,
  destinationPath: string,
  expectedSourceRevision: string,
  fallbackMessage = 'Page move failed'
): Promise<void> {
  await sendJson(
    fetchImpl,
    `/_api/pages/${encodeURIComponent(id)}/move`,
    'POST',
    { destinationLocale, destinationPath, expectedSourceRevision },
    fallbackMessage
  )
}

export async function fetchPageLocaleRelations(
  fetchImpl: FetchImpl,
  pageId: number,
  fallbackMessage = 'Page translations response is invalid'
): Promise<PageLocaleRelation[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(pageId)}/locale-relations`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizePageLocaleRelation(row, fallbackMessage))
}

export async function linkPageLocaleRelation(
  fetchImpl: FetchImpl,
  pageId: number,
  relatedPageId: number,
  fallbackMessage = 'Page translation link failed'
): Promise<PageLocaleRelation[]> {
  const payload = await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(pageId)}/locale-relations`, 'POST', { relatedPageId }, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizePageLocaleRelation(row, fallbackMessage))
}

export async function unlinkPageLocaleRelation(
  fetchImpl: FetchImpl,
  pageId: number,
  relatedPageId: number,
  fallbackMessage = 'Page translation unlink failed'
): Promise<PageLocaleRelation[]> {
  const payload = await sendJson(
    fetchImpl,
    `/_api/pages/${encodeURIComponent(pageId)}/locale-relations/${encodeURIComponent(relatedPageId)}`,
    'DELETE',
    {},
    fallbackMessage
  )
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizePageLocaleRelation(row, fallbackMessage))
}

export async function checkPageConflict(
  fetchImpl: FetchImpl,
  id: number,
  checkoutDate: string,
  fallbackMessage = 'Page conflict check failed'
): Promise<boolean> {
  const payload = await sendJson(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/conflicts/check`, 'POST', { checkoutDate }, fallbackMessage)
  if (!isRecord(payload) || typeof payload.conflict !== 'boolean') throw new Error(fallbackMessage)
  return payload.conflict
}

export async function fetchPageConflictLatest(
  fetchImpl: FetchImpl,
  id: number,
  fallbackMessage = 'Latest page version fetch failed'
): Promise<PageConflictLatest> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(id)}/conflict-latest`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (
    !isRecord(payload) ||
    typeof payload.updatedAt !== 'string' ||
    typeof payload.authorName !== 'string' ||
    typeof payload.content !== 'string' ||
    typeof payload.locale !== 'string' ||
    typeof payload.path !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.description !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    updatedAt: payload.updatedAt,
    authorName: payload.authorName,
    content: payload.content,
    locale: payload.locale,
    path: payload.path,
    title: payload.title,
    description: payload.description
  }
}

export async function fetchPageTree(
  fetchImpl: FetchImpl,
  options: { locale: string; parent?: number; path?: string; mode?: 'ALL' | 'FOLDERS' | 'PAGES'; includeAncestors?: boolean },
  fallbackMessage = 'Page tree response is invalid'
): Promise<PageTreeRow[]> {
  const params = new URLSearchParams({ locale: options.locale, mode: options.mode || 'ALL' })
  if (options.parent !== undefined) params.set('parent', String(options.parent))
  if (options.path) params.set('path', options.path)
  if (options.includeAncestors) params.set('includeAncestors', 'true')
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/tree?${params.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => {
    if (!isRecord(row)) throw new Error(fallbackMessage)
    const pageId = row.pageId
    if (!isNullableNumber(pageId)) throw new Error(fallbackMessage)
    const ownerId = row.ownerId
    if (
      !isNullableNumber(ownerId) ||
      (row.visibility !== 'public' && row.visibility !== 'private') ||
      typeof row.id !== 'number' ||
      typeof row.path !== 'string' ||
      typeof row.title !== 'string' ||
      typeof row.isFolder !== 'boolean' ||
      typeof row.parent !== 'number' ||
      typeof row.locale !== 'string' ||
      typeof row.canEdit !== 'boolean'
    ) {
      throw new Error(fallbackMessage)
    }
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      isFolder: row.isFolder,
      pageId,
      parent: row.parent,
      locale: row.locale,
      visibility: row.visibility,
      ownerId,
      canEdit: row.canEdit
    }
  })
}

export async function searchPages(
  fetchImpl: FetchImpl,
  query: string,
  options: { locale?: string; path?: string } = {},
  fallbackMessage = 'Page search response is invalid'
): Promise<PageSearchResult> {
  const params = new URLSearchParams({ query })
  if (options.locale) params.set('locale', options.locale)
  if (options.path) params.set('path', options.path)
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/search?${params.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || !Array.isArray(payload.results) || !Array.isArray(payload.suggestions) || typeof payload.totalHits !== 'number')
    throw new Error(fallbackMessage)
  const results = payload.results.map(row => {
    if (
      !isRecord(row) ||
      (typeof row.id !== 'string' && typeof row.id !== 'number') ||
      typeof row.title !== 'string' ||
      typeof row.description !== 'string' ||
      typeof row.path !== 'string' ||
      typeof row.locale !== 'string' ||
      (row.visibility !== 'public' && row.visibility !== 'private') ||
      !Array.isArray(row.tags) ||
      row.tags.some(tag => typeof tag !== 'string') ||
      typeof row.score !== 'number' ||
      !Number.isFinite(row.score) ||
      !Array.isArray(row.matchedFields) ||
      row.matchedFields.some(field => !['title', 'tag', 'path', 'description', 'content', 'graph'].includes(String(field)))
    ) {
      throw new Error(fallbackMessage)
    }
    const visibility: 'public' | 'private' = row.visibility
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      path: row.path,
      locale: row.locale,
      visibility,
      tags: row.tags as string[],
      score: row.score,
      matchedFields: row.matchedFields as PageSearchMatchField[]
    }
  })
  if (payload.suggestions.some(suggestion => typeof suggestion !== 'string')) throw new Error(fallbackMessage)
  return { results, suggestions: payload.suggestions, totalHits: payload.totalHits }
}

export async function searchPageTags(fetchImpl: FetchImpl, query: string, fallbackMessage = 'Tag search response is invalid'): Promise<string[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/tags/search?query=${encodeURIComponent(query)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload) || payload.some(tag => typeof tag !== 'string')) throw new Error(fallbackMessage)
  return payload
}

export type PageHistoryTrailItem = {
  versionId: number
  authorId: number
  authorName: string
  actionType: string
  valueBefore: string | null
  valueAfter: string | null
  versionDate: string
}

export type PageVersion = Record<string, unknown> & {
  versionId: number
  content: string
  contentType: string
  title: string
  description: string
  editor: string
  locale: string
  path: string
  tags: string[]
  versionDate: string
  visibility: 'public' | 'private'
}

export async function fetchPages(
  fetchImpl: FetchImpl,
  options: { creatorId?: number; authorId?: number; locale?: string; tags?: string[] } = {},
  fallbackMessage = 'Page list response is invalid'
): Promise<PageListRow[]> {
  const params = new URLSearchParams()
  if (options.creatorId) params.set('creatorId', String(options.creatorId))
  if (options.authorId) params.set('authorId', String(options.authorId))
  if (options.locale) params.set('locale', options.locale)
  if (options.tags && options.tags.length > 0) params.set('tags', options.tags.join(','))
  const suffix = params.toString()
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages${suffix ? `?${suffix}` : ''}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizePageListRow(row, fallbackMessage))
}

export async function fetchPageHistory(
  fetchImpl: FetchImpl,
  id: number,
  offsetPage: number,
  offsetSize: number,
  fallbackMessage = 'Page history fetch failed'
): Promise<{ trail: PageHistoryTrailItem[]; total: number }> {
  const response = await sameOriginJsonFetch(
    fetchImpl,
    `/_api/pages/${encodeURIComponent(id)}/history?offsetPage=${encodeURIComponent(offsetPage)}&offsetSize=${encodeURIComponent(offsetSize)}`,
    {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }
  )
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || !Array.isArray(payload.trail) || typeof payload.total !== 'number') throw new Error(fallbackMessage)
  const trail = payload.trail.map(row => {
    if (
      !isRecord(row) ||
      !Number.isInteger(row.versionId) ||
      !Number.isInteger(row.authorId) ||
      typeof row.authorName !== 'string' ||
      typeof row.actionType !== 'string' ||
      (row.valueBefore !== null && typeof row.valueBefore !== 'string') ||
      (row.valueAfter !== null && typeof row.valueAfter !== 'string') ||
      typeof row.versionDate !== 'string'
    )
      throw new Error(fallbackMessage)
    return row as PageHistoryTrailItem
  })
  return { trail, total: payload.total }
}

export async function fetchPageVersion(
  fetchImpl: FetchImpl,
  pageId: number,
  versionId: number,
  fallbackMessage = 'Page version fetch failed'
): Promise<PageVersion> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(pageId)}/history/${encodeURIComponent(versionId)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (
    !isRecord(payload) ||
    !Number.isInteger(payload.versionId) ||
    typeof payload.content !== 'string' ||
    typeof payload.contentType !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.description !== 'string' ||
    typeof payload.editor !== 'string' ||
    typeof payload.locale !== 'string' ||
    typeof payload.path !== 'string' ||
    !Array.isArray(payload.tags) ||
    payload.tags.some(tag => typeof tag !== 'string') ||
    typeof payload.versionDate !== 'string' ||
    (payload.visibility !== 'public' && payload.visibility !== 'private')
  )
    throw new Error(fallbackMessage)
  return payload as PageVersion
}

export async function restorePageVersion(
  fetchImpl: FetchImpl,
  pageId: number,
  versionId: number,
  expectedSourceRevision: string,
  fallbackMessage = 'Page restore failed'
): Promise<void> {
  await sendJson(
    fetchImpl,
    `/_api/pages/${encodeURIComponent(pageId)}/history/${encodeURIComponent(versionId)}/restore`,
    'POST',
    { expectedSourceRevision },
    fallbackMessage
  )
}
