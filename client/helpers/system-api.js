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

function normalizeFlagsPayload (payload, fallbackMessage) {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.reduce((result, row) => {
    if (!row || typeof row.key !== 'string' || typeof row.value !== 'boolean') {
      throw new Error(fallbackMessage)
    }
    result[row.key] = row.value
    return result
  }, {})
}

function normalizeSystemSummaryPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['currentVersion', 'latestVersion']
  const requiredNumberFields = ['groupsTotal', 'pagesTotal', 'usersTotal', 'tagsTotal']

  if (requiredStringFields.some(field => typeof payload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (requiredNumberFields.some(field => !Number.isFinite(payload[field]))) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeSystemInfoPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = [
    'configFile',
    'currentVersion',
    'dbHost',
    'dbType',
    'dbVersion',
    'hostname',
    'latestVersion',
    'nodeVersion',
    'operatingSystem',
    'platform',
    'ramTotal',
    'workingDirectory'
  ]
  const requiredNumberFields = ['cpuCores']

  if (requiredStringFields.some(field => typeof payload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (requiredNumberFields.some(field => !Number.isFinite(payload[field]))) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.upgradeCapable !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.latestVersionReleaseDate !== 'string' && payload.latestVersionReleaseDate !== null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeSystemTelemetryPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.telemetry !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.telemetryClientId !== 'string' && payload.telemetryClientId !== null) {
    throw new Error(fallbackMessage)
  }

  return {
    telemetry: payload.telemetry,
    telemetryClientId: payload.telemetryClientId
  }
}

function normalizeSystemHostPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.host !== 'string') {
    throw new Error(fallbackMessage)
  }

  return {
    host: payload.host
  }
}

function normalizeSystemSslPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredNumberFields = ['httpPort', 'httpsPort']
  const nullableStringFields = ['sslDomain', 'sslExpirationDate', 'sslProvider', 'sslSubscriberEmail']

  if (requiredNumberFields.some(field => !Number.isFinite(payload[field]))) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.httpRedirection !== 'boolean' || typeof payload.sslStatus !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (nullableStringFields.some(field => typeof payload[field] !== 'string' && payload[field] !== null)) {
    throw new Error(fallbackMessage)
  }

  return {
    httpPort: payload.httpPort,
    httpRedirection: payload.httpRedirection,
    httpsPort: payload.httpsPort,
    sslDomain: payload.sslDomain,
    sslExpirationDate: payload.sslExpirationDate,
    sslProvider: payload.sslProvider,
    sslStatus: payload.sslStatus,
    sslSubscriberEmail: payload.sslSubscriberEmail
  }
}

function normalizeSystemExtension (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['key', 'title', 'description']
  if (requiredStringFields.some(field => typeof row[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof row.isInstalled !== 'boolean' || typeof row.isCompatible !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return {
    key: row.key,
    title: row.title,
    description: row.description,
    isInstalled: row.isInstalled,
    isCompatible: row.isCompatible
  }
}

function normalizeSystemExtensionsPayload (payload, fallbackMessage) {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeSystemExtension(row, fallbackMessage))
}

async function fetchSystemSummary (fetchImpl, fallbackMessage = 'System summary response is invalid') {
  const response = await fetchImpl('/_api/system/summary', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemSummaryPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemInfo (fetchImpl, fallbackMessage = 'System info response is invalid') {
  const response = await fetchImpl('/_api/system/info', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemInfoPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemTelemetry (fetchImpl, fallbackMessage = 'System telemetry response is invalid') {
  const response = await fetchImpl('/_api/system/telemetry', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemTelemetryPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemHost (fetchImpl, fallbackMessage = 'Site host response is invalid') {
  const response = await fetchImpl('/_api/system/host', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemHostPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemSsl (fetchImpl, fallbackMessage = 'SSL status response is invalid') {
  const response = await fetchImpl('/_api/system/ssl', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemSslPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemFlags (fetchImpl, fallbackMessage = 'System flags response is invalid') {
  const response = await fetchImpl('/_api/system/flags', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeFlagsPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemExtensions (fetchImpl, fallbackMessage = 'System extensions response is invalid') {
  const response = await fetchImpl('/_api/system/extensions', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemExtensionsPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function updateSystemFlags (fetchImpl, flags, fallbackMessage = 'System flags update failed') {
  const response = await fetchImpl('/_api/system/flags', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      flags: Object.keys(flags).map(key => ({ key, value: flags[key] }))
    })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!payload || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

module.exports = {
  fetchSystemSummary,
  fetchSystemInfo,
  fetchSystemTelemetry,
  fetchSystemHost,
  fetchSystemSsl,
  fetchSystemFlags,
  fetchSystemExtensions,
  updateSystemFlags
}
