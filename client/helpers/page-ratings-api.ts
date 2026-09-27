import { sameOriginJsonFetch } from './json-transport.ts'
import {
  PageRatingViewSchema,
  PageRatingVoteSchema,
  type PageRatingView,
  type PageRatingVote
} from '../../shared/page-ratings.ts'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  status?: number
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type RequestMethod = 'GET' | 'PUT' | 'DELETE'

type FetchImpl = (
  url: string,
  init: {
    method: RequestMethod
    credentials: 'same-origin'
    cache: 'no-store'
    headers: {
      Accept: 'application/json'
      'Content-Type'?: 'application/json'
    }
    body?: string
    signal?: AbortSignal
  }
) => Promise<JsonResponse>

export class PageRatingApiError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'PageRatingApiError'
    this.status = status
    this.code = code
  }
}

const validPageId = (pageId: number): void => {
  if (!Number.isSafeInteger(pageId) || pageId < 1 || pageId > 2_147_483_647) {
    throw new PageRatingApiError('Choose a valid page.', 400, 'INVALID_PAGE_ID')
  }
}


const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const readPayload = async (response: JsonResponse): Promise<unknown> => {
  const contentType = response.headers?.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

const pageRatingRequest = async (
  fetchImpl: FetchImpl,
  pageId: number,
  method: RequestMethod,
  fallbackMessage: string,
  options: { vote?: PageRatingVote; signal?: AbortSignal } = {}
): Promise<PageRatingView> => {
  validPageId(pageId)
  const vote = options.vote === undefined ? undefined : PageRatingVoteSchema.parse(options.vote)
  const url = `/_api/page-ratings/${encodeURIComponent(pageId)}`
  const response = await sameOriginJsonFetch(fetchImpl, url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(vote === undefined ? {} : { 'Content-Type': 'application/json' as const })
    },
    ...(vote === undefined ? {} : { body: JSON.stringify(vote) }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })
  const status = typeof response.status === 'number' && Number.isSafeInteger(response.status) && response.status > 0
    ? response.status
    : undefined
  const payload = await readPayload(response)
  if (!response.ok) {
    const errorPayload = record(payload)
    const message = typeof errorPayload?.error === 'string' && errorPayload.error.length > 0
      ? errorPayload.error
      : typeof errorPayload?.message === 'string' && errorPayload.message.length > 0
        ? errorPayload.message
        : fallbackMessage
    throw new PageRatingApiError(
      message,
      status,
      typeof errorPayload?.code === 'string' ? errorPayload.code : undefined
    )
  }

  const parsed = PageRatingViewSchema.safeParse(payload)
  if (!parsed.success) {
    throw new PageRatingApiError(fallbackMessage, status)
  }
  return parsed.data
}

export const fetchPageRating = (
  fetchImpl: FetchImpl,
  pageId: number,
  fallbackMessage = 'Page ratings could not be loaded.',
  signal?: AbortSignal
): Promise<PageRatingView> => pageRatingRequest(fetchImpl, pageId, 'GET', fallbackMessage, { signal })

export const putPageRating = (
  fetchImpl: FetchImpl,
  pageId: number,
  vote: PageRatingVote,
  fallbackMessage = 'Your rating could not be saved.'
): Promise<PageRatingView> => pageRatingRequest(fetchImpl, pageId, 'PUT', fallbackMessage, { vote })

export const removePageRating = (
  fetchImpl: FetchImpl,
  pageId: number,
  fallbackMessage = 'Your rating could not be removed.'
): Promise<PageRatingView> => pageRatingRequest(fetchImpl, pageId, 'DELETE', fallbackMessage)
