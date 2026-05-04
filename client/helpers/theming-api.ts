type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, init: {
  method?: 'POST'
  credentials: 'same-origin'
  headers: {
    Accept: 'application/json'
    'Content-Type'?: 'application/json'
  }
  body?: string
}) => Promise<JsonResponse>

type ThemeConfig = {
  theme: string
  iconset: string
  darkMode: boolean
  tocPosition: string
  injectCSS: string
  injectHead: string
  injectBody: string
}

type ThemeSaveResponse = {
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

function normalizeThemeConfigPayload (payload: unknown, fallbackMessage: string): ThemeConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const themePayload = payload as Partial<ThemeConfig>
  const requiredStringFields: Array<keyof Omit<ThemeConfig, 'darkMode'>> = ['theme', 'iconset', 'tocPosition', 'injectCSS', 'injectHead', 'injectBody']
  if (requiredStringFields.some(field => typeof themePayload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof themePayload.darkMode !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return {
    theme: themePayload.theme!,
    iconset: themePayload.iconset!,
    darkMode: themePayload.darkMode,
    tocPosition: themePayload.tocPosition!,
    injectCSS: themePayload.injectCSS!,
    injectHead: themePayload.injectHead!,
    injectBody: themePayload.injectBody!
  }
}

function normalizeThemeSavePayload (payload: unknown, fallbackMessage: string): ThemeSaveResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
  if (typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length === 0) {
    throw new Error(fallbackMessage)
  }
  return {
    message: (payload as { message: string }).message
  }
}

export async function fetchThemeConfig (fetchImpl: FetchImpl, fallbackMessage = 'Theme config response is invalid'): Promise<ThemeConfig> {
  const response = await fetchImpl('/_api/theming/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeThemeConfigPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function saveThemeConfig (fetchImpl: FetchImpl, payload: ThemeConfig, fallbackMessage = 'Theme config update failed'): Promise<ThemeSaveResponse> {
  const response = await fetchImpl('/_api/theming/config', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  return normalizeThemeSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
