type JsonResponse = { ok: boolean, headers?: { get: (name: string) => string | null }, json: () => Promise<any> }
type FetchImpl = (url: string, init: any) => Promise<JsonResponse>

function getErrorMessage (payload: any, fallbackMessage: string): string {
  if (payload && typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error
  }
  if (payload && typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message
  }
  return fallbackMessage
}

function isValidAuthResponse (payload: any): boolean {
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

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<any> {
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

function parseConfigJson (value: string, fallbackMessage: string): any {
  try {
    return JSON.parse(value)
  } catch (err) {
    throw new Error(fallbackMessage)
  }
}

function normalizeAdminAuthStrategy (strategy: any, fallbackMessage: string): any {
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy) || typeof strategy.key !== 'string' || strategy.key.length < 1 || typeof strategy.isAvailable !== 'boolean' || !Array.isArray(strategy.props)) {
    throw new Error(fallbackMessage)
  }

  return {
    ...strategy,
    isDisabled: !strategy.isAvailable || strategy.key === 'local',
    props: strategy.props.map((cfg: any) => {
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.key !== 'string' || cfg.key.length < 1 || typeof cfg.value !== 'string') {
        throw new Error(fallbackMessage)
      }
      return {
        key: cfg.key,
        ...parseConfigJson(cfg.value, fallbackMessage)
      }
    }).sort((left: any, right: any) => {
      const leftOrder = Number.isFinite(left.order) ? left.order : 0
      const rightOrder = Number.isFinite(right.order) ? right.order : 0
      return leftOrder - rightOrder
    })
  }
}

function normalizeAdminActiveAuthStrategy (strategy: any, fallbackMessage: string): any {
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy) || typeof strategy.key !== 'string' || strategy.key.length < 1 || !strategy.strategy || typeof strategy.strategy !== 'object' || Array.isArray(strategy.strategy) || typeof strategy.strategy.key !== 'string' || !Array.isArray(strategy.config) || !Number.isFinite(strategy.order) || typeof strategy.isEnabled !== 'boolean' || typeof strategy.displayName !== 'string' || typeof strategy.selfRegistration !== 'boolean' || !Array.isArray(strategy.domainWhitelist) || !Array.isArray(strategy.autoEnrollGroups)) {
    throw new Error(fallbackMessage)
  }

  return {
    ...strategy,
    config: strategy.config.map((cfg: any) => {
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || typeof cfg.key !== 'string' || cfg.key.length < 1 || typeof cfg.value !== 'string') {
        throw new Error(fallbackMessage)
      }
      return {
        ...cfg,
        value: parseConfigJson(cfg.value, fallbackMessage)
      }
    }).sort((left: any, right: any) => {
      const leftOrder = Number.isFinite(left.value && left.value.order) ? left.value.order : 0
      const rightOrder = Number.isFinite(right.value && right.value.order) ? right.value.order : 0
      return leftOrder - rightOrder
    })
  }
}

export async function fetchAdminAuthStrategies (fetchImpl: FetchImpl, fallbackMessage = 'Authentication strategies response is invalid'): Promise<any[]> {
  const response = await fetchImpl('/_api/auth/admin/strategies', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(strategy => normalizeAdminAuthStrategy(strategy, fallbackMessage))
}

export async function fetchAdminAuthActiveStrategies (fetchImpl: FetchImpl, fallbackMessage = 'Active authentication strategies response is invalid'): Promise<any[]> {
  const response = await fetchImpl('/_api/auth/admin/active-strategies', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(strategy => normalizeAdminActiveAuthStrategy(strategy, fallbackMessage)).sort((left, right) => {
    const leftOrder = Number.isFinite(left.order) ? left.order : 0
    const rightOrder = Number.isFinite(right.order) ? right.order : 0
    return leftOrder - rightOrder
  })
}

export async function fetchAuthStrategies (fetchImpl: FetchImpl, fallbackMessage = 'Authentication strategies response is invalid'): Promise<any[]> {
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

export async function fetchAdminAuthProviders (fetchImpl: FetchImpl, fallbackMessage = 'Admin authentication providers response is invalid'): Promise<any[]> {
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

function isValidAdminApiKeyShort (keyShort: string): boolean {
  return /^\.\.\..{20}$/.test(keyShort) || keyShort === '...[redacted]'
}

function normalizeAdminApiKey (key: any, fallbackMessage: string): any {
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

export async function fetchAdminApiBootstrap (fetchImpl: FetchImpl, fallbackMessage = 'Admin API bootstrap response is invalid'): Promise<any> {
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

async function postJson (fetchImpl: FetchImpl, path: string, body: any, fallbackMessage: string): Promise<any> {
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

export async function submitAuthRequest (fetchImpl: FetchImpl, path: string, body: any, fallbackMessage = 'Authentication request failed'): Promise<any> {
  const payload = await postJson(fetchImpl, path, body, fallbackMessage)
  if (!isValidAuthResponse(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export async function submitStatusRequest (fetchImpl: FetchImpl, path: string, body: any, fallbackMessage = 'Authentication request failed'): Promise<any> {
  const payload = await postJson(fetchImpl, path, body, fallbackMessage)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export async function updateAdminAuthStrategies (fetchImpl: FetchImpl, strategies: any, fallbackMessage = 'Authentication strategies update failed'): Promise<any> {
  return submitStatusRequest(fetchImpl, '/_api/auth/strategies', { strategies }, fallbackMessage)
}

export async function setAdminApiState (fetchImpl: FetchImpl, enabled: boolean, fallbackMessage = 'API state update failed'): Promise<any> {
  return submitStatusRequest(fetchImpl, '/_api/auth/api/state', { enabled }, fallbackMessage)
}

export async function revokeAdminApiKey (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'API key revoke failed'): Promise<any> {
  return submitStatusRequest(fetchImpl, `/_api/auth/api/keys/${encodeURIComponent(id)}/revoke`, {}, fallbackMessage)
}

export async function createAdminApiKey (fetchImpl: FetchImpl, payload: any, fallbackMessage = 'API key creation failed'): Promise<any> {
  const responsePayload = await submitStatusRequest(fetchImpl, '/_api/auth/api/keys', {
    name: payload.name,
    expiration: payload.expiration,
    fullAccess: payload.fullAccess,
    group: payload.group
  }, fallbackMessage)

  if (typeof responsePayload.key !== 'string' || responsePayload.key.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    key: responsePayload.key,
    message: responsePayload.message
  }
}

export async function regenerateAuthCertificates (fetchImpl: FetchImpl, fallbackMessage = 'Certificate regeneration failed'): Promise<any> {
  return submitStatusRequest(fetchImpl, '/_api/auth/certificates/regenerate', {}, fallbackMessage)
}

export async function resetGuestUser (fetchImpl: FetchImpl, fallbackMessage = 'Guest user reset failed'): Promise<any> {
  return submitStatusRequest(fetchImpl, '/_api/auth/guest/reset', {}, fallbackMessage)
}

export async function registerAccount (fetchImpl: FetchImpl, input: { email: string, password: string, name: string }, fallbackMessage = 'Registration failed'): Promise<any> {
  return submitStatusRequest(fetchImpl, '/_api/auth/register', input, fallbackMessage)
}
