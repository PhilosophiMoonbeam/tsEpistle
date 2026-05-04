type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: Record<string, unknown>) => Promise<JsonResponse>

type LoggerConfigValue = Record<string, unknown> & {
  order?: number
}

type LoggerConfig = {
  key: string
  value: LoggerConfigValue
}

type Logger = {
  isEnabled: boolean
  key: string
  title: string
  description: string
  logo: string
  website: string
  level: string
  config: LoggerConfig[]
}

type LoggingSaveResponse = {
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

function normalizeLoggerConfig (row: unknown, fallbackMessage: string): LoggerConfig {
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
    value: value as LoggerConfigValue
  }
}

function normalizeLogger (row: unknown, fallbackMessage: string): Logger {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const logger = row as Record<string, unknown>
  const requiredStringFields = ['key', 'title', 'description', 'logo', 'website', 'level']
  if (requiredStringFields.some(field => typeof logger[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof logger.isEnabled !== 'boolean' || !Array.isArray(logger.config)) {
    throw new Error(fallbackMessage)
  }

  return {
    isEnabled: logger.isEnabled,
    key: logger.key as string,
    title: logger.title as string,
    description: logger.description as string,
    logo: logger.logo as string,
    website: logger.website as string,
    level: logger.level as string,
    config: logger.config.map(cfg => normalizeLoggerConfig(cfg, fallbackMessage)).sort((a, b) => {
      const aOrder = Number.isFinite(a.value.order) ? a.value.order! : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.value.order) ? b.value.order! : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }
}

function normalizeLoggersPayload (payload: unknown, fallbackMessage: string): Logger[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeLogger(row, fallbackMessage))
}

export async function fetchLoggingLoggers (fetchImpl: FetchImpl, fallbackMessage = 'Logging loggers response is invalid'): Promise<Logger[]> {
  const response = await fetchImpl('/_api/logging/loggers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeLoggersPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeLoggingSavePayload (payload: unknown, fallbackMessage: string): LoggingSaveResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function saveLoggingLoggers (fetchImpl: FetchImpl, loggers: unknown[], fallbackMessage = 'Logging loggers update failed'): Promise<LoggingSaveResponse> {
  const response = await fetchImpl('/_api/logging/loggers', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ loggers })
  })

  return normalizeLoggingSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
