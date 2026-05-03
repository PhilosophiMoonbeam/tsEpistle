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

function normalizeMailConfigPayload (payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = ['senderName', 'senderEmail', 'host', 'name', 'user', 'pass', 'dkimDomainName', 'dkimKeySelector', 'dkimPrivateKey']
  if (requiredStringFields.some(field => typeof payload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (!Number.isInteger(payload.port) || ['secure', 'verifySSL', 'useDKIM'].some(field => typeof payload[field] !== 'boolean')) {
    throw new Error(fallbackMessage)
  }

  return {
    senderName: payload.senderName,
    senderEmail: payload.senderEmail,
    host: payload.host,
    port: payload.port,
    name: payload.name,
    secure: payload.secure,
    verifySSL: payload.verifySSL,
    user: payload.user,
    pass: payload.pass,
    useDKIM: payload.useDKIM,
    dkimDomainName: payload.dkimDomainName,
    dkimKeySelector: payload.dkimKeySelector,
    dkimPrivateKey: payload.dkimPrivateKey
  }
}

async function fetchMailConfig (fetchImpl, fallbackMessage = 'Mail configuration response is invalid') {
  const response = await fetchImpl('/_api/mail/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeMailConfigPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function saveMailConfig (fetchImpl, config, fallbackMessage = 'Mail configuration update failed') {
  const response = await fetchImpl('/_api/mail/config', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  })

  return normalizeMailActionPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
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
  fetchMailConfig,
  saveMailConfig,
  sendMailTest
}
