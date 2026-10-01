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

export type LocaleRow = {
  availability: number
  code: string
  installDate?: string
  isInstalled: boolean
  isRTL: boolean
  name: string
  nativeName: string
  updatedAt?: string
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

function normalizeLocaleRow(row: unknown, fallbackMessage: string): LocaleRow {
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

export async function fetchLocales(fetchImpl: FetchImpl, fallbackMessage = 'Locales response is invalid'): Promise<LocaleRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/locales', {
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
