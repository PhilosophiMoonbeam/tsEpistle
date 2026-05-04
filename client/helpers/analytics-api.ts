type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: Record<string, unknown>) => Promise<JsonResponse>

type AnalyticsConfigValue = Record<string, unknown> & {
  order?: number
}

type AnalyticsProviderConfig = {
  key: string
  value: AnalyticsConfigValue
}

type AnalyticsProvider = {
  isEnabled: boolean
  key: string
  title: string
  description: string
  isAvailable: boolean
  logo: string
  website: string
  config: AnalyticsProviderConfig[]
}

type AnalyticsSaveResponse = {
  message: string
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && (payload as { error: string }).error.length > 0) {
      throw new Error((payload as { error: string }).error)
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === 'string' && (payload as { message: string }).message.length > 0) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeProviderConfig (row: unknown, fallbackMessage: string): AnalyticsProviderConfig {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as { key?: unknown }).key !== 'string' || typeof (row as { value?: unknown }).value !== 'string') {
    throw new Error(fallbackMessage)
  }

  let value: unknown
  try {
    value = JSON.parse((row as { value: string }).value)
  } catch (err) {
    throw new Error(fallbackMessage)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(fallbackMessage)
  }

  return {
    key: (row as { key: string }).key,
    value: value as AnalyticsConfigValue
  }
}

function normalizeProvider (row: unknown, fallbackMessage: string): AnalyticsProvider {
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
    isAvailable: provider.isAvailable,
    logo: provider.logo as string,
    website: provider.website as string,
    config: provider.config.map(cfg => normalizeProviderConfig(cfg, fallbackMessage)).sort((a, b) => {
      const aOrder = Number.isFinite(a.value.order) ? a.value.order! : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.value.order) ? b.value.order! : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }
}

function normalizeProvidersPayload (payload: unknown, fallbackMessage: string): AnalyticsProvider[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeProvider(row, fallbackMessage))
}

export async function fetchAnalyticsProviders (fetchImpl: FetchImpl, fallbackMessage = 'Analytics providers response is invalid'): Promise<AnalyticsProvider[]> {
  const response = await fetchImpl('/_api/analytics/providers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeProvidersPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeAnalyticsSavePayload (payload: unknown, fallbackMessage: string): AnalyticsSaveResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function saveAnalyticsProviders (fetchImpl: FetchImpl, providers: unknown[], fallbackMessage = 'Analytics providers save response is invalid'): Promise<AnalyticsSaveResponse> {
  const response = await fetchImpl('/_api/analytics/providers', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ providers })
  })

  return normalizeAnalyticsSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
