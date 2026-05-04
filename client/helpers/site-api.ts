type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json?: () => Promise<unknown>
}

type FetchImpl = (url: string, init: {
  method?: 'PUT'
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

async function parseJsonResponse (response: JsonResponse | null | undefined, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''
  let payload: unknown = null

  if (response && contentType.includes('application/json') && typeof response.json === 'function') {
    payload = await response.json()
  }

  if (!response || !response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as { error?: unknown }).error) {
      throw new Error(String((payload as { error: unknown }).error))
    }
    throw new Error(fallbackMessage)
  }

  return payload
}

function assertPlainObject (payload: unknown, fallbackMessage: string): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
}

export async function fetchSiteConfig (fetchImpl: FetchImpl, fallbackMessage = 'Site configuration fetch failed'): Promise<Record<string, unknown>> {
  const response = await fetchImpl('/_api/site/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  assertPlainObject(payload, fallbackMessage)
  return payload
}

export async function saveSiteConfig (fetchImpl: FetchImpl, config: Record<string, unknown>, fallbackMessage = 'Site configuration update failed'): Promise<MessageResponse & Record<string, unknown>> {
  const response = await fetchImpl('/_api/site/config', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload as MessageResponse & Record<string, unknown>
}
