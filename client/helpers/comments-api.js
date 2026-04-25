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

function normalizeCommentProviderConfig (row, fallbackMessage) {
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

function normalizeCommentProvider (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['key', 'title', 'description', 'logo', 'website']
  if (requiredStringFields.some(field => typeof row[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof row.isEnabled !== 'boolean' || typeof row.isAvailable !== 'boolean' || !Array.isArray(row.config)) {
    throw new Error(fallbackMessage)
  }

  return {
    isEnabled: row.isEnabled,
    key: row.key,
    title: row.title,
    description: row.description,
    logo: row.logo,
    website: row.website,
    isAvailable: row.isAvailable,
    config: row.config.map(cfg => normalizeCommentProviderConfig(cfg, fallbackMessage)).sort((a, b) => {
      const aOrder = Number.isFinite(a.value.order) ? a.value.order : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.value.order) ? b.value.order : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }
}

function normalizeCommentProvidersPayload (payload, fallbackMessage) {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeCommentProvider(row, fallbackMessage))
}

async function fetchCommentProviders (fetchImpl, fallbackMessage = 'Comment providers response is invalid') {
  const response = await fetchImpl('/_api/comments/providers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeCommentProvidersPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

module.exports = {
  fetchCommentProviders
}
