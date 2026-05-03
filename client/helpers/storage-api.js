async function parseJsonResponse (response, fallbackMessage) {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers.get('content-type') || '' : ''
  let payload = null

  if (contentType.includes('application/json') && typeof response.json === 'function') {
    payload = await response.json()
  }

  if (!response || !response.ok) {
    throw new Error((payload && payload.error) || fallbackMessage)
  }

  return payload
}

async function fetchStorageTargets (fetchImpl, fallbackMessage = 'Storage targets failed') {
  const response = await fetchImpl('/_api/storage/targets', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function fetchStorageStatus (fetchImpl, fallbackMessage = 'Storage status failed') {
  const response = await fetchImpl('/_api/storage/status', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function saveStorageTargets (fetchImpl, targets, fallbackMessage = 'Storage targets update failed') {
  const response = await fetchImpl('/_api/storage/targets', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ targets })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload.message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function executeStorageAction (fetchImpl, targetKey, handler, fallbackMessage = 'Storage action failed') {
  const response = await fetchImpl('/_api/storage/actions/execute', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ targetKey, handler })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload.message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload
}

module.exports = {
  executeStorageAction,
  fetchStorageStatus,
  fetchStorageTargets,
  saveStorageTargets
}
