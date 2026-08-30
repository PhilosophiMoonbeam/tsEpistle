import { sameOriginJsonFetch } from './json-transport.ts'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: Record<string, unknown>) => Promise<JsonResponse>

export type SearchEngineConfigValue = Record<string, unknown> & {
  order?: number
  type?: string
  enum?: string[]
  title?: string
  hint?: string
  multiline?: boolean
  value?: unknown
}

export type SearchEngineConfig = {
  key: string
  value: SearchEngineConfigValue
}

export type SearchEngine = {
  isEnabled: boolean
  key: string
  title: string
  description: string
  logo: string
  website: string
  isAvailable: boolean
  config: SearchEngineConfig[]
}

type SearchSaveResponse = {
  message: string
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

function normalizeSearchEngineConfig(row: unknown, fallbackMessage: string): SearchEngineConfig {
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
    value: value as SearchEngineConfigValue
  }
}

function normalizeSearchEngine(row: unknown, fallbackMessage: string): SearchEngine {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const engine = row as Record<string, unknown>
  const requiredStringFields = ['key', 'title', 'description', 'logo', 'website']
  if (requiredStringFields.some(field => typeof engine[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof engine.isEnabled !== 'boolean' || typeof engine.isAvailable !== 'boolean' || !Array.isArray(engine.config)) {
    throw new Error(fallbackMessage)
  }

  return {
    isEnabled: engine.isEnabled,
    key: engine.key as string,
    title: engine.title as string,
    description: engine.description as string,
    logo: engine.logo as string,
    website: engine.website as string,
    isAvailable: engine.isAvailable,
    config: engine.config
      .map(cfg => normalizeSearchEngineConfig(cfg, fallbackMessage))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.value.order) ? a.value.order! : Number.MAX_SAFE_INTEGER
        const bOrder = Number.isFinite(b.value.order) ? b.value.order! : Number.MAX_SAFE_INTEGER
        return aOrder - bOrder
      })
  }
}

function normalizeSearchEnginesPayload(payload: unknown, fallbackMessage: string): SearchEngine[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeSearchEngine(row, fallbackMessage))
}

export async function fetchSearchEngines(fetchImpl: FetchImpl, fallbackMessage = 'Search engines response is invalid'): Promise<SearchEngine[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/search/engines', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSearchEnginesPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeSearchSavePayload(payload: unknown, fallbackMessage: string): SearchSaveResponse {
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

export async function saveSearchEngines(
  fetchImpl: FetchImpl,
  engines: unknown[],
  fallbackMessage = 'Search engines save response is invalid'
): Promise<SearchSaveResponse> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/search/engines', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ engines })
  })

  return normalizeSearchSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function rebuildSearchIndex(fetchImpl: FetchImpl, fallbackMessage = 'Search index rebuild failed'): Promise<unknown> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/search/rebuild-index', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return parseJsonResponse(response, fallbackMessage)
}
