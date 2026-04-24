function getErrorMessage (payload, fallbackMessage) {
  if (payload && typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error
  }
  if (payload && typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message
  }
  return fallbackMessage
}

function isValidAuthResponse (payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }

  if (payload.mustChangePwd === true || payload.mustProvideTFA === true) {
    return typeof payload.continuationToken === 'string' && payload.continuationToken.length > 0
  }

  if (payload.mustSetupTFA === true) {
    return typeof payload.continuationToken === 'string' && payload.continuationToken.length > 0 && typeof payload.tfaQRImage === 'string' && payload.tfaQRImage.length > 0
  }

  return typeof payload.jwt === 'string' && payload.jwt.length > 0
}

async function parseJsonResponse (response, fallbackMessage) {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers.get('content-type') || '' : ''

  let payload = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, fallbackMessage))
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function fetchAuthStrategies (fetchImpl, fallbackMessage = 'Authentication strategies response is invalid') {
  const response = await fetchImpl('/_api/auth/strategies', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.slice().sort((left, right) => {
    const leftOrder = Number.isFinite(left.order) ? left.order : 0
    const rightOrder = Number.isFinite(right.order) ? right.order : 0
    return leftOrder - rightOrder
  })
}

async function fetchAdminAuthProviders (fetchImpl, fallbackMessage = 'Admin authentication providers response is invalid') {
  const response = await fetchImpl('/_api/auth/providers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.slice().sort((left, right) => {
    const leftOrder = Number.isFinite(left.order) ? left.order : 0
    const rightOrder = Number.isFinite(right.order) ? right.order : 0
    return leftOrder - rightOrder
  }).map(provider => {
    if (!provider || typeof provider.key !== 'string' || provider.key.length < 1 || typeof provider.displayName !== 'string' || provider.displayName.length < 1 || !Number.isFinite(provider.order) || typeof provider.isEnabled !== 'boolean') {
      throw new Error(fallbackMessage)
    }

    return provider
  })
}

function isValidAdminApiKeyShort (keyShort) {
  return /^\.\.\..{20}$/.test(keyShort) || keyShort === '...[redacted]'
}

function normalizeAdminApiKey (key, fallbackMessage) {
  if (!key || typeof key !== 'object' || Array.isArray(key) || !Number.isFinite(key.id) || typeof key.name !== 'string' || key.name.length < 1 || typeof key.keyShort !== 'string' || !isValidAdminApiKeyShort(key.keyShort) || typeof key.isRevoked !== 'boolean' || typeof key.expiration !== 'string' || key.expiration.length < 1 || typeof key.createdAt !== 'string' || key.createdAt.length < 1 || typeof key.updatedAt !== 'string' || key.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: key.id,
    name: key.name,
    keyShort: key.keyShort,
    isRevoked: key.isRevoked,
    expiration: key.expiration,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt
  }
}

async function fetchAdminApiBootstrap (fetchImpl, fallbackMessage = 'Admin API bootstrap response is invalid') {
  const response = await fetchImpl('/_api/auth/api', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.enabled !== 'boolean' || !Array.isArray(payload.keys)) {
    throw new Error(fallbackMessage)
  }

  return {
    enabled: payload.enabled,
    keys: payload.keys.map(key => normalizeAdminApiKey(key, fallbackMessage))
  }
}

async function postJson (fetchImpl, path, body, fallbackMessage) {
  const response = await fetchImpl(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  return parseJsonResponse(response, fallbackMessage)
}

async function submitAuthRequest (fetchImpl, path, body, fallbackMessage = 'Authentication request failed') {
  const payload = await postJson(fetchImpl, path, body, fallbackMessage)
  if (!isValidAuthResponse(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function submitStatusRequest (fetchImpl, path, body, fallbackMessage = 'Authentication request failed') {
  const payload = await postJson(fetchImpl, path, body, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

module.exports = {
  fetchAuthStrategies,
  fetchAdminAuthProviders,
  fetchAdminApiBootstrap,
  submitAuthRequest,
  submitStatusRequest
}
