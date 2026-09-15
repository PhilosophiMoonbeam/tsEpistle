import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  status?: number
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options?: RequestInit) => Promise<JsonResponse>

export type CommentOperation = 'read' | 'create' | 'update' | 'delete' | 'manage'
export type CommentOutcomeKind = 'auth' | 'permission' | 'not-found' | 'validation' | 'conflict' | 'rate-limit' | 'server' | 'transport' | 'transport-unknown'
export type CommentRequestOutcome = 'rejected' | 'unknown'

/**
 * All comment requests retain their HTTP status and classify whether a
 * mutation was authoritatively rejected or may have reached the server.
 * `transport-unknown` is reserved for an outcome that needs a read before a
 * caller can safely offer the same mutation again.
 */
export class CommentApiError extends Error {
  readonly status: number | null
  readonly kind: CommentOutcomeKind
  readonly outcome: CommentRequestOutcome
  readonly operation: CommentOperation
  readonly cause: unknown

  constructor(
    message: string,
    status: number | null,
    kind: CommentOutcomeKind,
    operation: CommentOperation,
    outcome: CommentRequestOutcome,
    cause?: unknown
  ) {
    super(message)
    this.name = 'CommentApiError'
    this.status = status
    this.kind = kind
    this.outcome = outcome
    this.operation = operation
    this.cause = cause
  }
}

export type CommentProviderConfigValue = Record<string, unknown> & {
  type?: string
  title?: string
  hint?: string | false
  enum?: unknown[] | false
  multiline?: boolean
  maxWidth?: number
  order?: number
  value?: string | number | boolean | null
}

export type CommentProviderConfig = {
  key: string
  value: CommentProviderConfigValue
}

export type CommentProvider = {
  isEnabled: boolean
  key: string
  title: string
  description: string
  logo: string
  website: string
  isAvailable: boolean
  config: CommentProviderConfig[]
}

export type CommentSaveResponse = {
  message: string
}

export type CommentRow = {
  id: number
  render: string
  /** The server's clear content is needed only to reconcile an uncertain create. */
  content?: string
  authorName: string
  replyTo: number
  authorHandle: string
  createdAt: string
  updatedAt: string
}

export type CommentDetails = {
  id: number
  content: string
}

export type CommentCreateInput = {
  pageId: number
  replyTo: number
  content: string
  guestName: string
  guestEmail: string
}
export type MentionCandidate = {
  id: number
  handle: string
  name: string
}

function normalizePositiveInteger(value: unknown, fallbackMessage: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(fallbackMessage)
  return value
}
function normalizeNonNegativeInteger(value: unknown, fallbackMessage: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(fallbackMessage)
  return value
}

function normalizeCommentRow(payload: unknown, fallbackMessage: string): CommentRow {
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  if (
    typeof payload.render !== 'string' ||
    typeof payload.authorName !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.authorHandle !== 'string' ||
    typeof payload.updatedAt !== 'string' ||
    ('content' in payload && typeof payload.content !== 'string')
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    id: normalizePositiveInteger(payload.id, fallbackMessage),
    render: payload.render,
    ...(typeof payload.content === 'string' ? { content: payload.content } : {}),
    replyTo: normalizeNonNegativeInteger(payload.replyTo, fallbackMessage),
    authorHandle: payload.authorHandle,
    authorName: payload.authorName,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  }
}

function normalizeMessage(payload: unknown, fallbackMessage: string): CommentSaveResponse {
  if (!isRecord(payload) || typeof payload.message !== 'string') throw new Error(fallbackMessage)
  return { message: payload.message }
}


const outcomeFor = (operation: CommentOperation): CommentRequestOutcome => operation === 'read' ? 'rejected' : 'unknown'

const statusKind = (status: number | null): CommentOutcomeKind => {
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 400 || status === 422) return 'validation'
  if (status === 429) return 'rate-limit'
  if (status !== null && status >= 500) return 'server'
  return 'server'
}

const invalidPayload = (fallbackMessage: string, operation: CommentOperation, cause?: unknown, status: number | null = null): CommentApiError =>
  new CommentApiError(fallbackMessage, status, 'server', operation, outcomeFor(operation), cause)

const normalizePayload = <T>(
  payload: unknown,
  fallbackMessage: string,
  operation: CommentOperation,
  normalize: () => T,
  status: number | null = null
): T => {
  try {
    return normalize()
  } catch (error) {
    if (error instanceof CommentApiError) throw error
    throw invalidPayload(fallbackMessage, operation, error, status)
  }
}

async function parseJsonResponse(response: JsonResponse, fallbackMessage: string, operation: CommentOperation): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''
  const status = typeof response.status === 'number' && Number.isSafeInteger(response.status) ? response.status : null

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json()
    } catch (error) {
      if (response.ok) throw invalidPayload(fallbackMessage, operation, error, status)
    }
  }

  if (!response.ok) {
    let message = fallbackMessage
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error.length > 0) message = payload.error
    else if (isRecord(payload) && typeof payload.message === 'string' && payload.message.length > 0) message = payload.message
    throw new CommentApiError(message, status, statusKind(status), operation, 'rejected')
  }

  if (payload === null || payload === undefined) throw invalidPayload(fallbackMessage, operation, undefined, status)
  return payload
}

async function requestJson<T>(
  operation: CommentOperation,
  fallbackMessage: string,
  request: () => Promise<JsonResponse>,
  normalize: (payload: unknown) => T
): Promise<T> {
  let payload: unknown
  let status: number | null = null
  try {
    const response = await request()
    status = typeof response.status === 'number' && Number.isSafeInteger(response.status) ? response.status : null
    payload = await parseJsonResponse(response, fallbackMessage, operation)
  } catch (error) {
    if (error instanceof CommentApiError) throw error
    const message = error instanceof Error && error.message.trim() ? error.message : fallbackMessage
    throw new CommentApiError(message, null, operation === 'read' ? 'transport' : 'transport-unknown', operation, outcomeFor(operation), error)
  }
  return normalizePayload(payload, fallbackMessage, operation, () => normalize(payload), status)
}

async function sendJson<T>(
  fetchImpl: FetchImpl,
  path: string,
  method: string,
  body: unknown,
  fallbackMessage: string,
  operation: CommentOperation,
  normalize: (payload: unknown) => T
): Promise<T> {
  return requestJson(
    operation,
    fallbackMessage,
    () => sameOriginJsonFetch(fetchImpl, path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }),
    normalize
  )
}

function normalizeCommentProviderConfig(row: unknown, fallbackMessage: string): CommentProviderConfig {
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    typeof (row as { key?: unknown }).key !== 'string' ||
    typeof (row as { value?: unknown }).value !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }

  let value: unknown
  try {
    value = JSON.parse((row as { value: string }).value)
  } catch (err) {
    throw new Error(fallbackMessage, { cause: err })
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(fallbackMessage)
  }

  return {
    key: (row as { key: string }).key,
    value: value as CommentProviderConfigValue
  }
}

function normalizeCommentProvider(row: unknown, fallbackMessage: string): CommentProvider {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const provider = row as Record<string, unknown>
  const requiredStringFields = ['key', 'title', 'description', 'logo', 'website']
  if (requiredStringFields.some(field => typeof provider[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof provider.isEnabled !== 'boolean' || typeof provider.isAvailable !== 'boolean' || !Array.isArray(provider.config)) {
    throw new Error(fallbackMessage)
  }

  return {
    isEnabled: provider.isEnabled,
    key: provider.key as string,
    title: provider.title as string,
    description: provider.description as string,
    logo: provider.logo as string,
    website: provider.website as string,
    isAvailable: provider.isAvailable,
    config: provider.config
      .map(cfg => normalizeCommentProviderConfig(cfg, fallbackMessage))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.value.order) ? a.value.order! : Number.MAX_SAFE_INTEGER
        const bOrder = Number.isFinite(b.value.order) ? b.value.order! : Number.MAX_SAFE_INTEGER
        return aOrder - bOrder
      })
  }
}

function normalizeCommentProvidersPayload(payload: unknown, fallbackMessage: string): CommentProvider[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeCommentProvider(row, fallbackMessage))
}

export async function fetchCommentProviders(fetchImpl: FetchImpl, fallbackMessage = 'Comment providers response is invalid'): Promise<CommentProvider[]> {
  return requestJson(
    'read',
    fallbackMessage,
    () => sameOriginJsonFetch(fetchImpl, '/_api/comments/providers', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    }),
    payload => normalizeCommentProvidersPayload(payload, fallbackMessage)
  )
}

function normalizeCommentSavePayload(payload: unknown, fallbackMessage: string): CommentSaveResponse {
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

export async function saveCommentProviders(
  fetchImpl: FetchImpl,
  providers: unknown[],
  fallbackMessage = 'Comment providers save response is invalid'
): Promise<CommentSaveResponse> {
  return sendJson(
    fetchImpl,
    '/_api/comments/providers',
    'POST',
    { providers },
    fallbackMessage,
    'manage',
    payload => normalizeCommentSavePayload(payload, fallbackMessage)
  )
}

export async function fetchComments(fetchImpl: FetchImpl, pageId: number, fallbackMessage = 'Comments response is invalid'): Promise<CommentRow[]> {
  return requestJson(
    'read',
    fallbackMessage,
    () => sameOriginJsonFetch(fetchImpl, `/_api/comments?pageId=${encodeURIComponent(pageId)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }),
    payload => {
      if (!Array.isArray(payload)) throw new Error(fallbackMessage)
      return payload.map(row => normalizeCommentRow(row, fallbackMessage))
    }
  )
}

export async function fetchMentionCandidates(fetchImpl: FetchImpl, pageId: number, query: string, fallbackMessage = 'Mention search response is invalid'): Promise<MentionCandidate[]> {
  return requestJson(
    'read',
    fallbackMessage,
    () => sameOriginJsonFetch(fetchImpl, `/_api/comments/mentions?pageId=${encodeURIComponent(pageId)}&q=${encodeURIComponent(query)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }),
    payload => {
      if (!Array.isArray(payload)) throw new Error(fallbackMessage)
      return payload.map(row => {
        if (!isRecord(row) || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.handle !== 'string' || !/^[a-z0-9_-]{3,32}$/.test(row.handle) || typeof row.name !== 'string' || !row.name) throw new Error(fallbackMessage)
        return { id: row.id, handle: row.handle, name: row.name }
      })
    }
  )
}

export async function createComment(fetchImpl: FetchImpl, input: CommentCreateInput, fallbackMessage = 'Comment creation failed'): Promise<{ id: number }> {
  return sendJson(
    fetchImpl,
    '/_api/comments',
    'POST',
    input,
    fallbackMessage,
    'create',
    payload => {
      if (!isRecord(payload)) throw new Error(fallbackMessage)
      return { id: normalizePositiveInteger(payload.id, fallbackMessage) }
    }
  )
}

export async function fetchComment(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Comment response is invalid'): Promise<CommentDetails> {
  return requestJson(
    'read',
    fallbackMessage,
    () => sameOriginJsonFetch(fetchImpl, `/_api/comments/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }),
    payload => {
      if (!isRecord(payload) || typeof payload.content !== 'string') throw new Error(fallbackMessage)
      return { id: normalizePositiveInteger(payload.id, fallbackMessage), content: payload.content }
    }
  )
}

export async function updateComment(fetchImpl: FetchImpl, id: number, content: string, fallbackMessage = 'Comment update failed'): Promise<{ render: string }> {
  return sendJson(
    fetchImpl,
    `/_api/comments/${encodeURIComponent(id)}`,
    'PATCH',
    { content },
    fallbackMessage,
    'update',
    payload => {
      if (!isRecord(payload) || typeof payload.render !== 'string') throw new Error(fallbackMessage)
      return { render: payload.render }
    }
  )
}

export async function deleteComment(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Comment deletion failed'): Promise<CommentSaveResponse> {
  return requestJson(
    'delete',
    fallbackMessage,
    () => sameOriginJsonFetch(fetchImpl, `/_api/comments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }),
    payload => normalizeMessage(payload, fallbackMessage)
  )
}

export async function fetchDiscussionAvailability(fetchImpl: FetchImpl, pageId: number): Promise<{ enabled: boolean; closed: boolean; canPost: boolean }> {
  return requestJson(
    'read',
    'Discussion availability could not be loaded.',
    () => sameOriginJsonFetch(fetchImpl, '/_api/comments/availability/' + pageId, { credentials: 'same-origin', headers: { Accept: 'application/json' } }),
    value => {
      if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.closed !== 'boolean' || typeof value.canPost !== 'boolean') throw new Error('Discussion availability response is invalid.')
      return { enabled: value.enabled, closed: value.closed, canPost: value.canPost }
    }
  )
}
