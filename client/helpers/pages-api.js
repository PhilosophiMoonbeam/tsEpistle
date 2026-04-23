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

function normalizeRecentPageRow (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.locale !== 'string' || row.locale.length < 1 || typeof row.path !== 'string' || typeof row.title !== 'string' || typeof row.updatedAt !== 'string' || row.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    locale: row.locale,
    path: row.path,
    title: row.title,
    updatedAt: row.updatedAt
  }
}

async function fetchRecentPages (fetchImpl, fallbackMessage = 'Recent pages response is invalid') {
  const response = await fetchImpl('/_api/pages/recent', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeRecentPageRow(row, fallbackMessage))
}

module.exports = {
  fetchRecentPages
}
