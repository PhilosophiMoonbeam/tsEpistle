import { sameOriginJsonFetch } from './json-transport.ts'
import {
  PageLinksReadyResponseSchema,
  PageLinksRefreshResponseSchema,
  type PageLinksDirection,
  type PageLinksReadyResponse,
  type PageLinksRefreshResponse
} from '../../shared/page-links.ts'

type JsonResponse = {
  ok: boolean
  status?: number
  headers?: {
    get: (name: string) => string | null
  }
  json: () => Promise<unknown>
}

type FetchImpl = (
  url: string,
  init: {
    credentials: 'same-origin'
    cache: 'no-store'
    headers: { Accept: 'application/json' }
    signal?: AbortSignal
  }
) => Promise<JsonResponse>

export class PageLinksApiError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'PageLinksApiError'
    this.status = status
    this.code = code
  }
}

export type PageLinksResponse = PageLinksReadyResponse | PageLinksRefreshResponse

const objectPayload = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const jsonPayload = async (response: JsonResponse): Promise<unknown> => {
  const contentType = response.headers?.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

export const fetchPageLinks = async (
  fetchImpl: FetchImpl,
  pageId: number,
  direction: PageLinksDirection,
  options: { cursor?: string; signal?: AbortSignal } = {},
  fallbackMessage = 'Page links could not be loaded.'
): Promise<PageLinksResponse> => {
  if (!Number.isSafeInteger(pageId) || pageId < 1 || pageId > 2_147_483_647) {
    throw new PageLinksApiError('Choose a valid page.', 400, 'INVALID_PAGE_ID')
  }
  if (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 8_192)) {
    throw new PageLinksApiError('The page-link continuation is invalid.', 400, 'INVALID_PAGE_LINK_CURSOR')
  }

  const query = new URLSearchParams({ direction })
  if (options.cursor !== undefined) query.set('cursor', options.cursor)
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/pages/${encodeURIComponent(pageId)}/links?${query.toString()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })
  const payload = await jsonPayload(response)
  const status = typeof response.status === 'number' && Number.isSafeInteger(response.status) && response.status > 0
    ? response.status
    : undefined

  if (status === 409) {
    const refreshed = PageLinksRefreshResponseSchema.safeParse(payload)
    if (!refreshed.success || refreshed.data.pageId !== pageId || refreshed.data.direction !== direction) {
      throw new PageLinksApiError(fallbackMessage, status)
    }
    return refreshed.data
  }

  if (!response.ok) {
    const errorPayload = objectPayload(payload)
    const message = typeof errorPayload?.error === 'string' && errorPayload.error.length > 0
      ? errorPayload.error
      : typeof errorPayload?.message === 'string' && errorPayload.message.length > 0
        ? errorPayload.message
        : fallbackMessage
    throw new PageLinksApiError(message, status, typeof errorPayload?.code === 'string' ? errorPayload.code : undefined)
  }

  const ready = PageLinksReadyResponseSchema.safeParse(payload)
  if (!ready.success || ready.data.pageId !== pageId || ready.data.direction !== direction) {
    throw new PageLinksApiError(fallbackMessage, status)
  }
  if (ready.data.hasMore !== (ready.data.nextCursor !== null)) {
    throw new PageLinksApiError('Page links returned an invalid continuation.', status, 'INVALID_PAGE_LINK_CURSOR')
  }
  return ready.data
}
