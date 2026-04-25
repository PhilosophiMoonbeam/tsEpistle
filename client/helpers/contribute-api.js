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

function normalizeContributor (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['id', 'source', 'name', 'joined']
  if (requiredStringFields.some(field => typeof row[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }

  const optionalNullableStringFields = ['website', 'twitter', 'avatar']
  if (optionalNullableStringFields.some(field => row[field] !== null && typeof row[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    source: row.source,
    name: row.name,
    joined: row.joined,
    website: row.website,
    twitter: row.twitter,
    avatar: row.avatar
  }
}

function normalizeContributorsPayload (payload, fallbackMessage) {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeContributor(row, fallbackMessage))
}

async function fetchContributors (fetchImpl, fallbackMessage = 'Contributors response is invalid') {
  const response = await fetchImpl('/_api/contribute/contributors', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeContributorsPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

module.exports = {
  fetchContributors
}
