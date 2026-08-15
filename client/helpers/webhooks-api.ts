import { isRecord } from './type-guards'

type FetchImpl = typeof window.fetch

export interface AdminWebhook {
  id: string
  name: string
  url: string
  events: string[]
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookDelivery {
  id: string
  eventId: string
  eventType: string
  eventVersion: number
  jobId: string
  state: string
  attempts: number
  maxAttempts: number
  statusCode: number | null
  responseSnippet: string | null
  lastError: string | null
  createdAt: string
  deliveredAt: string | null
}

const jsonRequest = async (fetchImpl: FetchImpl, path: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetchImpl(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers
    }
  })
  if (response.status === 204) return null
  const payload: unknown = await response.json()
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'Webhook request failed')
  }
  return payload
}

const webhook = (value: unknown): AdminWebhook => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    typeof value.url !== 'string' || !Array.isArray(value.events) ||
    !value.events.every(event => typeof event === 'string') || typeof value.isEnabled !== 'boolean') {
    throw new Error('Webhook response is invalid')
  }
  return value as unknown as AdminWebhook
}

export const fetchWebhooks = async (fetchImpl: FetchImpl): Promise<AdminWebhook[]> => {
  const payload = await jsonRequest(fetchImpl, '/_api/webhooks')
  if (!Array.isArray(payload)) throw new Error('Webhook response is invalid')
  return payload.map(webhook)
}

export const createWebhook = async (fetchImpl: FetchImpl, input: Omit<AdminWebhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ id: string, secret: string }> => {
  const payload = await jsonRequest(fetchImpl, '/_api/webhooks', { method: 'POST', body: JSON.stringify(input) })
  if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.secret !== 'string') throw new Error('Webhook creation response is invalid')
  return { id: payload.id, secret: payload.secret }
}

export const updateWebhook = async (fetchImpl: FetchImpl, id: string, input: Pick<AdminWebhook, 'name' | 'url' | 'events' | 'isEnabled'>): Promise<void> => {
  await jsonRequest(fetchImpl, `/_api/webhooks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export const deleteWebhook = async (fetchImpl: FetchImpl, id: string): Promise<void> => {
  await jsonRequest(fetchImpl, `/_api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const rotateWebhookSecret = async (fetchImpl: FetchImpl, id: string): Promise<string> => {
  const payload = await jsonRequest(fetchImpl, `/_api/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST' })
  if (!isRecord(payload) || typeof payload.secret !== 'string') throw new Error('Webhook secret response is invalid')
  return payload.secret
}

export const fetchWebhookDeliveries = async (fetchImpl: FetchImpl, id: string): Promise<WebhookDelivery[]> => {
  const payload = await jsonRequest(fetchImpl, `/_api/webhooks/${encodeURIComponent(id)}/deliveries`)
  if (!Array.isArray(payload)) throw new Error('Webhook deliveries response is invalid')
  return payload as WebhookDelivery[]
}

export const changeWebhookDelivery = async (fetchImpl: FetchImpl, id: string, action: 'retry' | 'cancel'): Promise<void> => {
  await jsonRequest(fetchImpl, `/_api/webhooks/deliveries/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
}
