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

function normalizeThemeConfigPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['theme', 'iconset', 'tocPosition', 'injectCSS', 'injectHead', 'injectBody']
  if (requiredStringFields.some(field => typeof payload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.darkMode !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return {
    theme: payload.theme,
    iconset: payload.iconset,
    darkMode: payload.darkMode,
    tocPosition: payload.tocPosition,
    injectCSS: payload.injectCSS,
    injectHead: payload.injectHead,
    injectBody: payload.injectBody
  }
}

async function fetchThemeConfig (fetchImpl, fallbackMessage = 'Theme config response is invalid') {
  const response = await fetchImpl('/_api/theming/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeThemeConfigPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

module.exports = {
  fetchThemeConfig
}
