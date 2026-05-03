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

function normalizeSearchEngineConfig (row, fallbackMessage) {
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

function normalizeSearchEngine (row, fallbackMessage) {
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
    config: row.config.map(cfg => normalizeSearchEngineConfig(cfg, fallbackMessage)).sort((a, b) => {
      const aOrder = Number.isFinite(a.value.order) ? a.value.order : Number.MAX_SAFE_INTEGER
      const bOrder = Number.isFinite(b.value.order) ? b.value.order : Number.MAX_SAFE_INTEGER
      return aOrder - bOrder
    })
  }
}

function normalizeSearchEnginesPayload (payload, fallbackMessage) {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeSearchEngine(row, fallbackMessage))
}

async function fetchSearchEngines (fetchImpl, fallbackMessage = 'Search engines response is invalid') {
  const response = await fetchImpl('/_api/search/engines', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSearchEnginesPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeSearchSavePayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: payload.message
  }
}

async function saveSearchEngines (fetchImpl, engines, fallbackMessage = 'Search engines save response is invalid') {
  const response = await fetchImpl('/_api/search/engines', {
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

async function rebuildSearchIndex (fetchImpl, fallbackMessage = 'Search index rebuild failed') {
  const response = await fetchImpl('/_api/search/rebuild-index', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return parseJsonResponse(response, fallbackMessage)
}

module.exports = {
  fetchSearchEngines,
  rebuildSearchIndex,
  saveSearchEngines
}
