import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options?: RequestInit) => Promise<JsonResponse>

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

type CommentSaveResponse = {
  message: string
}

export type CommentRow = {
  id: number
  render: string
  authorName: string
  createdAt: string
  updatedAt: string
}

type CommentDetails = {
  id: number
  content: string
}

type CommentCreateInput = {
  pageId: number
  replyTo: number
  content: string
  guestName: string
  guestEmail: string
}

function normalizePositiveInteger(value: unknown, fallbackMessage: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(fallbackMessage)
  return value
}

function normalizeCommentRow(payload: unknown, fallbackMessage: string): CommentRow {
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  if (
    typeof payload.render !== 'string' ||
    typeof payload.authorName !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    id: normalizePositiveInteger(payload.id, fallbackMessage),
    render: payload.render,
    authorName: payload.authorName,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  }
}

function normalizeMessage(payload: unknown, fallbackMessage: string): CommentSaveResponse {
  if (!isRecord(payload) || typeof payload.message !== 'string') throw new Error(fallbackMessage)
  return { message: payload.message }
}

async function sendJson(fetchImpl: FetchImpl, path: string, method: string, body: unknown, fallbackMessage: string): Promise<unknown> {
  const response = await sameOriginJsonFetch(fetchImpl, path, {
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

async function parseJsonResponse(response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof (payload as { error?: unknown }).error === 'string' &&
      (payload as { error: string }).error.length > 0
    ) {
      throw new Error((payload as { error: string }).error)
    }
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof (payload as { message?: unknown }).message === 'string' &&
      (payload as { message: string }).message.length > 0
    ) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
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
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/comments/providers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeCommentProvidersPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
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
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/comments/providers', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ providers })
  })

  return normalizeCommentSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function fetchComments(fetchImpl: FetchImpl, pageId: number, fallbackMessage = 'Comments response is invalid'): Promise<CommentRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/comments?pageId=${encodeURIComponent(pageId)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizeCommentRow(row, fallbackMessage))
}

export async function createComment(fetchImpl: FetchImpl, input: CommentCreateInput, fallbackMessage = 'Comment creation failed'): Promise<{ id: number }> {
  const payload = await sendJson(fetchImpl, '/_api/comments', 'POST', input, fallbackMessage)
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  return { id: normalizePositiveInteger(payload.id, fallbackMessage) }
}

export async function fetchComment(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Comment response is invalid'): Promise<CommentDetails> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/comments/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.content !== 'string') throw new Error(fallbackMessage)
  return { id: normalizePositiveInteger(payload.id, fallbackMessage), content: payload.content }
}

export async function updateComment(fetchImpl: FetchImpl, id: number, content: string, fallbackMessage = 'Comment update failed'): Promise<{ render: string }> {
  const payload = await sendJson(fetchImpl, `/_api/comments/${encodeURIComponent(id)}`, 'PATCH', { content }, fallbackMessage)
  if (!isRecord(payload) || typeof payload.render !== 'string') throw new Error(fallbackMessage)
  return { render: payload.render }
}

export async function deleteComment(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Comment deletion failed'): Promise<CommentSaveResponse> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/comments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  return normalizeMessage(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
