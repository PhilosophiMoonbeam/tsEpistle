type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, init: {
  method?: string
  credentials: 'same-origin'
  headers: {
    Accept: 'application/json'
    'Content-Type'?: 'application/json'
  }
  body?: string
}) => Promise<JsonResponse>

type MessageResponse = {
  message: string
}

type RecentPageRow = {
  id: number
  locale: string
  path: string
  title: string
  updatedAt: string
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && ((payload as { error: string }).error).length > 0) {
      throw new Error((payload as { error: string }).error)
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === 'string' && ((payload as { message: string }).message).length > 0) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeRecentPageRow (row: unknown, fallbackMessage: string): RecentPageRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const pageRow = row as Partial<RecentPageRow>
  if (!Number.isInteger(pageRow.id) || typeof pageRow.locale !== 'string' || pageRow.locale.length < 1 || typeof pageRow.path !== 'string' || typeof pageRow.title !== 'string' || typeof pageRow.updatedAt !== 'string' || pageRow.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: pageRow.id,
    locale: pageRow.locale,
    path: pageRow.path,
    title: pageRow.title,
    updatedAt: pageRow.updatedAt
  }
}

export async function fetchRecentPages (fetchImpl: FetchImpl, fallbackMessage = 'Recent pages response is invalid'): Promise<RecentPageRow[]> {
  const response = await fetchImpl('/_api/pages/recent', {
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


export async function updatePageTag (fetchImpl: FetchImpl, id: number, tag: string, title: string, fallbackMessage = 'Tag update failed'): Promise<MessageResponse> {
  const response = await fetchImpl(`/_api/pages/tags/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tag, title })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}
