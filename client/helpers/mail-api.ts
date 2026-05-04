type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, init: {
  method?: 'POST'
  credentials: 'same-origin'
  headers: {
    Accept: 'application/json'
    'Content-Type'?: 'application/json'
  }
  body?: string
}) => Promise<JsonResponse>

type MailActionResponse = {
  message: string
}

type MailConfig = {
  senderName: string
  senderEmail: string
  host: string
  port: number
  name: string
  secure: boolean
  verifySSL: boolean
  user: string
  pass: string
  useDKIM: boolean
  dkimDomainName: string
  dkimKeySelector: string
  dkimPrivateKey: string
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && (payload as { error: string }).error.length > 0) {
      throw new Error((payload as { error: string }).error)
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === 'string' && (payload as { message: string }).message.length > 0) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeMailActionPayload (payload: unknown, fallbackMessage: string): MailActionResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

function normalizeMailConfigPayload (payload: unknown, fallbackMessage: string): MailConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  const mailPayload = payload as Partial<MailConfig>
  const requiredStringFields: Array<keyof Omit<MailConfig, 'port' | 'secure' | 'verifySSL' | 'useDKIM'>> = ['senderName', 'senderEmail', 'host', 'name', 'user', 'pass', 'dkimDomainName', 'dkimKeySelector', 'dkimPrivateKey']
  if (requiredStringFields.some(field => typeof mailPayload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (!Number.isInteger(mailPayload.port) || ['secure', 'verifySSL', 'useDKIM'].some(field => typeof (mailPayload as Record<string, unknown>)[field] !== 'boolean')) {
    throw new Error(fallbackMessage)
  }

  return {
    senderName: mailPayload.senderName!,
    senderEmail: mailPayload.senderEmail!,
    host: mailPayload.host!,
    port: mailPayload.port!,
    name: mailPayload.name!,
    secure: mailPayload.secure!,
    verifySSL: mailPayload.verifySSL!,
    user: mailPayload.user!,
    pass: mailPayload.pass!,
    useDKIM: mailPayload.useDKIM!,
    dkimDomainName: mailPayload.dkimDomainName!,
    dkimKeySelector: mailPayload.dkimKeySelector!,
    dkimPrivateKey: mailPayload.dkimPrivateKey!
  }
}

export async function fetchMailConfig (fetchImpl: FetchImpl, fallbackMessage = 'Mail configuration response is invalid'): Promise<MailConfig> {
  const response = await fetchImpl('/_api/mail/config', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeMailConfigPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function saveMailConfig (fetchImpl: FetchImpl, config: MailConfig, fallbackMessage = 'Mail configuration update failed'): Promise<MailActionResponse> {
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

export async function sendMailTest (fetchImpl: FetchImpl, recipientEmail: string, fallbackMessage = 'Test email failed'): Promise<MailActionResponse> {
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
