type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: Record<string, unknown>) => Promise<JsonResponse>

type LocaleRow = {
  availability: number
  code: string
  isInstalled: boolean
  isRTL: boolean
  name: string
  nativeName: string
  [key: string]: unknown
}

type LocaleConfig = {
  locale: string
  autoUpdate: boolean
  namespacing: boolean
  namespaces: string[]
  [key: string]: unknown
}

type LocaleMessageResponse = {
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

function normalizeLocaleRow (row: unknown, fallbackMessage: string): LocaleRow {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const localeRow = row as Partial<LocaleRow>
  const requiredStringFields = ['code', 'name', 'nativeName'] as const
  if (requiredStringFields.some(field => typeof localeRow[field] !== 'string' || (localeRow[field] as string).length < 1)) {
    throw new Error(fallbackMessage)
  }

  if (typeof localeRow.isRTL !== 'boolean' || typeof localeRow.isInstalled !== 'boolean' || !Number.isFinite(localeRow.availability)) {
    throw new Error(fallbackMessage)
  }

  return row as LocaleRow
}

function normalizeLocaleConfig (payload: unknown, fallbackMessage: string): LocaleConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const config = payload as Partial<LocaleConfig>
  if (typeof config.locale !== 'string' || config.locale.length < 1) {
    throw new Error(fallbackMessage)
  }
  if (typeof config.autoUpdate !== 'boolean' || typeof config.namespacing !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(config.namespaces) || config.namespaces.some(ns => typeof ns !== 'string' || ns.length < 1)) {
    throw new Error(fallbackMessage)
  }

  return payload as LocaleConfig
}

export async function fetchLocales (fetchImpl: FetchImpl, fallbackMessage = 'Locales response is invalid'): Promise<LocaleRow[]> {
  const response = await fetchImpl('/_api/locales', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeLocaleRow(row, fallbackMessage))
}

export async function fetchLocaleConfig (fetchImpl: FetchImpl, fallbackMessage = 'Locale config response is invalid'): Promise<LocaleConfig> {
  const response = await fetchImpl('/_api/locales/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeLocaleConfig(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeLocaleSavePayload (payload: unknown, fallbackMessage: string): LocaleMessageResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function saveLocaleConfig (fetchImpl: FetchImpl, config: unknown, fallbackMessage = 'Locale settings update failed'): Promise<LocaleMessageResponse> {
  const response = await fetchImpl('/_api/locales/config', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  })

  return normalizeLocaleSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function downloadLocale (fetchImpl: FetchImpl, code: string, fallbackMessage = 'Locale download failed'): Promise<LocaleMessageResponse> {
  const response = await fetchImpl(`/_api/locales/${encodeURIComponent(code)}/download`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeLocaleSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
