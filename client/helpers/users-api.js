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

function normalizeUserSearchRow (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.email !== 'string' || row.email.length < 1 || typeof row.providerKey !== 'string' || row.providerKey.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    providerKey: row.providerKey
  }
}

function normalizeLastLoginRow (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.lastLoginAt !== 'string' || row.lastLoginAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    lastLoginAt: row.lastLoginAt
  }
}

function normalizeUserGroupRow (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name
  }
}

function normalizeUserDetail (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = [
    'name',
    'email',
    'providerKey',
    'providerName',
    'location',
    'jobTitle',
    'timezone',
    'createdAt',
    'updatedAt'
  ]

  if (!Number.isInteger(payload.id) || requiredStringFields.some(field => typeof payload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (payload.providerId !== null && typeof payload.providerId !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.providerIs2FACapable !== 'boolean' || typeof payload.isSystem !== 'boolean' || typeof payload.isActive !== 'boolean' || typeof payload.isVerified !== 'boolean' || typeof payload.tfaIsActive !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (payload.lastLoginAt !== null && typeof payload.lastLoginAt !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(payload.groups)) {
    throw new Error(fallbackMessage)
  }

  return {
    id: payload.id,
    name: payload.name,
    email: payload.email,
    providerKey: payload.providerKey,
    providerName: payload.providerName,
    providerId: payload.providerId,
    providerIs2FACapable: payload.providerIs2FACapable,
    location: payload.location,
    jobTitle: payload.jobTitle,
    timezone: payload.timezone,
    isSystem: payload.isSystem,
    isActive: payload.isActive,
    isVerified: payload.isVerified,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    lastLoginAt: payload.lastLoginAt,
    tfaIsActive: payload.tfaIsActive,
    groups: payload.groups.map(row => normalizeUserGroupRow(row, fallbackMessage))
  }
}

function normalizePositiveIntegerId (id, fallbackMessage) {
  if (Number.isInteger(id) && id > 0) {
    return id
  }

  if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) {
    return Number.parseInt(id, 10)
  }

  throw new Error(fallbackMessage)
}

async function searchUsers (fetchImpl, query, fallbackMessage = 'User search response is invalid') {
  const normalizedQuery = typeof query === 'string' ? query.trim() : ''
  if (normalizedQuery.length < 2) {
    return []
  }

  const response = await fetchImpl(`/_api/users/search?query=${encodeURIComponent(normalizedQuery)}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeUserSearchRow(row, fallbackMessage))
}

async function fetchLastLogins (fetchImpl, fallbackMessage = 'Last logins response is invalid') {
  const response = await fetchImpl('/_api/users/last-logins', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeLastLoginRow(row, fallbackMessage))
}

async function fetchUserDetails (fetchImpl, id, fallbackMessage = 'User detail response is invalid') {
  const normalizedId = normalizePositiveIntegerId(id, fallbackMessage)
  const response = await fetchImpl(`/_api/users/${normalizedId}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeUserDetail(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

module.exports = {
  searchUsers,
  fetchLastLogins,
  fetchUserDetails
}
