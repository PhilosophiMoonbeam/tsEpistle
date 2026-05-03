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

function normalizeMailActionPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: payload.message
  }
}

async function sendMailTest (fetchImpl, recipientEmail, fallbackMessage = 'Test email failed') {
  const response = await fetchImpl('/_api/mail/test', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ recipientEmail })
  })

  return normalizeMailActionPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

module.exports = {
  sendMailTest
}
