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

function normalizeGroupOption (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.isSystem !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return row
}

function normalizeGroupListRow (row, fallbackMessage) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.isSystem !== 'boolean' || !Number.isInteger(row.userCount)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.createdAt !== 'string' || row.createdAt.length < 1 || typeof row.updatedAt !== 'string' || row.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return row
}

async function fetchGroupOptions (fetchImpl, fallbackMessage = 'Groups response is invalid') {
  const response = await fetchImpl('/_api/groups', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeGroupOption(row, fallbackMessage))
}

async function fetchGroupsList (fetchImpl, fallbackMessage = 'Groups list response is invalid') {
  const response = await fetchImpl('/_api/groups/list', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeGroupListRow(row, fallbackMessage))
}

module.exports = {
  fetchGroupOptions,
  fetchGroupsList
}
