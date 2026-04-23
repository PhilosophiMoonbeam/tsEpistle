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

module.exports = {
  searchUsers
}
