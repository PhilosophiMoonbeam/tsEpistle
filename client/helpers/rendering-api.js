async function parseJsonResponse (response, fallbackMessage) {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers.get('content-type') || '' : ''

  let payload = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload.error === 'string' && payload.error.length > 0) {
      throw new Error(payload.error)
    }
    if (payload && typeof payload.message === 'string' && payload.message.length > 0) {
      throw new Error(payload.message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeRendererConfig (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.key !== 'string' || typeof row.value !== 'string') {
    throw new Error(fallbackMessage)
  }

  let value
  try {
    value = JSON.parse(row.value)
  } catch (err) {
    throw new Error(fallbackMessage)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(fallbackMessage)
  }

  return {
    key: row.key,
    value
  }
}

function isNullableString (value) {
  return value === null || typeof value === 'string'
}

function normalizeRenderer (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['key', 'title']
  if (requiredStringFields.some(field => typeof row[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  const nullableStringFields = ['description', 'icon', 'dependsOn', 'input', 'output']
  if (nullableStringFields.some(field => !isNullableString(row[field]))) {
    throw new Error(fallbackMessage)
  }
  if (typeof row.isEnabled !== 'boolean' || !Array.isArray(row.config)) {
    throw new Error(fallbackMessage)
  }

  return {
    isEnabled: row.isEnabled,
    key: row.key,
    title: row.title,
    description: row.description,
    icon: row.icon,
    dependsOn: row.dependsOn,
    input: row.input,
    output: row.output,
    config: row.config.map(cfg => normalizeRendererConfig(cfg, fallbackMessage)).sort((a, b) => {
      const aOrder = Number.isFinite(a.value.order) ? a.value.order : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.value.order) ? b.value.order : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }
}

function normalizeRenderersPayload (payload, fallbackMessage) {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeRenderer(row, fallbackMessage))
}

async function fetchRenderingRenderers (fetchImpl, fallbackMessage = 'Rendering renderers response is invalid') {
  const response = await fetchImpl('/_api/rendering/renderers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeRenderersPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeRendererSavePayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string' || payload.message.length === 0) {
    throw new Error(fallbackMessage)
  }
  return {
    message: payload.message
  }
}

async function saveRenderingRenderers (fetchImpl, renderers, fallbackMessage = 'Rendering renderers update failed') {
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

module.exports = {
  fetchRenderingRenderers,
  saveRenderingRenderers
}
