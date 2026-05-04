type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: Record<string, unknown>) => Promise<JsonResponse>

type RendererConfigValue = Record<string, unknown> & {
  order?: number
}

type RendererConfig = {
  key: string
  value: RendererConfigValue
}

type Renderer = {
  isEnabled: boolean
  key: string
  title: string
  description: string | null
  icon: string | null
  dependsOn: string | null
  input: string | null
  output: string | null
  config: RendererConfig[]
}

type RendererSaveResponse = {
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

function normalizeRendererConfig (row: unknown, fallbackMessage: string): RendererConfig {
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
    value: value as RendererConfigValue
  }
}

function isNullableString (value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function normalizeRenderer (row: unknown, fallbackMessage: string): Renderer {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const renderer = row as Record<string, unknown>
  const requiredStringFields = ['key', 'title']
  if (requiredStringFields.some(field => typeof renderer[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  const nullableStringFields = ['description', 'icon', 'dependsOn', 'input', 'output']
  if (nullableStringFields.some(field => !isNullableString(renderer[field]))) {
    throw new Error(fallbackMessage)
  }
  if (typeof renderer.isEnabled !== 'boolean' || !Array.isArray(renderer.config)) {
    throw new Error(fallbackMessage)
  }

  return {
    isEnabled: renderer.isEnabled,
    key: renderer.key as string,
    title: renderer.title as string,
    description: renderer.description as string | null,
    icon: renderer.icon as string | null,
    dependsOn: renderer.dependsOn as string | null,
    input: renderer.input as string | null,
    output: renderer.output as string | null,
    config: renderer.config.map(cfg => normalizeRendererConfig(cfg, fallbackMessage)).sort((a, b) => {
      const aOrder = Number.isFinite(a.value.order) ? a.value.order! : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.value.order) ? b.value.order! : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }
}

function normalizeRenderersPayload (payload: unknown, fallbackMessage: string): Renderer[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeRenderer(row, fallbackMessage))
}

export async function fetchRenderingRenderers (fetchImpl: FetchImpl, fallbackMessage = 'Rendering renderers response is invalid'): Promise<Renderer[]> {
  const response = await fetchImpl('/_api/rendering/renderers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeRenderersPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeRendererSavePayload (payload: unknown, fallbackMessage: string): RendererSaveResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length === 0) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function saveRenderingRenderers (fetchImpl: FetchImpl, renderers: unknown[], fallbackMessage = 'Rendering renderers update failed'): Promise<RendererSaveResponse> {
  const response = await fetchImpl('/_api/rendering/renderers', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ renderers })
  })

  return normalizeRendererSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
