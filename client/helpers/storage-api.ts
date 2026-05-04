type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json?: () => Promise<unknown>
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
  [key: string]: unknown
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''
  let payload: unknown = null

  if (contentType.includes('application/json') && typeof response.json === 'function') {
    payload = await response.json()
  }

  if (!response || !response.ok) {
    const errorValue = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { error?: unknown }).error : null
    throw new Error(errorValue ? String(errorValue) : fallbackMessage)
  }

  return payload
}

export async function fetchStorageTargets (fetchImpl: FetchImpl, fallbackMessage = 'Storage targets failed'): Promise<unknown[]> {
  const response = await fetchImpl('/_api/storage/targets', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export async function fetchStorageStatus (fetchImpl: FetchImpl, fallbackMessage = 'Storage status failed'): Promise<unknown[]> {
  const response = await fetchImpl('/_api/storage/status', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export async function saveStorageTargets (fetchImpl: FetchImpl, targets: unknown[], fallbackMessage = 'Storage targets update failed'): Promise<MessageResponse> {
  const response = await fetchImpl('/_api/storage/targets', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ targets })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload as MessageResponse
}

export async function executeStorageAction (fetchImpl: FetchImpl, targetKey: string, handler: string, fallbackMessage = 'Storage action failed'): Promise<MessageResponse> {
  const response = await fetchImpl('/_api/storage/actions/execute', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ targetKey, handler })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload as MessageResponse
}
