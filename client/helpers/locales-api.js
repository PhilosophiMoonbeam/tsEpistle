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

function normalizeLocaleRow (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['code', 'name', 'nativeName']
  if (requiredStringFields.some(field => typeof row[field] !== 'string' || row[field].length < 1)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.isRTL !== 'boolean' || typeof row.isInstalled !== 'boolean' || !Number.isFinite(row.availability)) {
    throw new Error(fallbackMessage)
  }

  return row
}

function normalizeLocaleConfig (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  if (typeof payload.locale !== 'string' || payload.locale.length < 1) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.autoUpdate !== 'boolean' || typeof payload.namespacing !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(payload.namespaces) || payload.namespaces.some(ns => typeof ns !== 'string' || ns.length < 1)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function fetchLocales (fetchImpl, fallbackMessage = 'Locales response is invalid') {
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

async function fetchLocaleConfig (fetchImpl, fallbackMessage = 'Locale config response is invalid') {
  const response = await fetchImpl('/_api/locales/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeLocaleConfig(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeLocaleSavePayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: payload.message
  }
}

async function saveLocaleConfig (fetchImpl, config, fallbackMessage = 'Locale settings update failed') {
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

module.exports = {
  fetchLocales,
  fetchLocaleConfig,
  saveLocaleConfig
}
