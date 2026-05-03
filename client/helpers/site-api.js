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

function assertPlainObject (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
}

async function fetchSiteConfig (fetchImpl, fallbackMessage = 'Site configuration fetch failed') {
  const response = await fetchImpl('/_api/site/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  assertPlainObject(payload, fallbackMessage)
  return payload
}

async function saveSiteConfig (fetchImpl, config, fallbackMessage = 'Site configuration update failed') {
  const response = await fetchImpl('/_api/site/config', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload.message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload
}

module.exports = {
  fetchSiteConfig,
  saveSiteConfig
}
