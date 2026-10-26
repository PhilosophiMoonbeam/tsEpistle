import type { z } from 'zod'
import {
  PAGE_CREATION_OWNER_HEADER,
  PageCreationRequestIdSchema,
  PageCreationStatusSchema,
  PageCreationInventorySchema,
  type PageCreationStatus,
  type PageCreationInventory
} from '../../shared/page-creation.ts'
import { sameOriginJsonFetch, type BrowserFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'

export class PageCreationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const key = (value: string): string => encodeURIComponent(PageCreationRequestIdSchema.parse(value))
async function read<T>(fetchImpl: BrowserFetch, ownerId: number, path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('A current creation owner is required.')
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${path}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { Accept: 'application/json', [PAGE_CREATION_OWNER_HEADER]: String(ownerId) }
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new PageCreationApiError(response.status, 'INVALID_RESPONSE', 'Creation status could not be confirmed.')
  }
  if (!response.ok)
    throw new PageCreationApiError(
      response.status,
      isRecord(payload) && typeof payload.code === 'string' ? payload.code : 'REQUEST_FAILED',
      isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'Creation status could not be loaded.'
    )
  const result = schema.safeParse(payload)
  if (!result.success) throw new PageCreationApiError(response.status, 'INVALID_RESPONSE', 'Creation status response is invalid.')
  return result.data
}

export function readPageCreationStatus(fetchImpl: BrowserFetch, ownerId: number, requestId: string, signal?: AbortSignal): Promise<PageCreationStatus> {
  const normalized = PageCreationRequestIdSchema.parse(requestId)
  return read(fetchImpl, ownerId, `creation-requests/${key(normalized)}`, PageCreationStatusSchema, signal).then(result => {
    if (result.requestId !== normalized) throw new PageCreationApiError(200, 'INVALID_RESPONSE', 'Creation status did not match this request.')
    return result
  })
}
export function listLiveNoteCreations(
  fetchImpl: BrowserFetch,
  ownerId: number,
  noteId: string,
  cursor?: string | null,
  signal?: AbortSignal
): Promise<PageCreationInventory> {
  return read(fetchImpl, ownerId, `creation-origins/live-notes/${key(noteId)}${cursor ? `?cursor=${key(cursor)}` : ''}`, PageCreationInventorySchema, signal)
}
export function listAgentAnswerCreations(
  fetchImpl: BrowserFetch,
  ownerId: number,
  sessionId: string,
  messageId: string,
  cursor?: string | null,
  signal?: AbortSignal
): Promise<PageCreationInventory> {
  return read(
    fetchImpl,
    ownerId,
    `creation-origins/agent-answers/${key(sessionId)}/${key(messageId)}${cursor ? `?cursor=${key(cursor)}` : ''}`,
    PageCreationInventorySchema,
    signal
  )
}
