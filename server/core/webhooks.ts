import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, type LookupFunction } from 'node:net'

const blockedAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4]
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6')

export interface ResolvedWebhookUrl {
  url: URL
  address: string
  family: 4 | 6
}

export interface WebhookDeliveryRequest {
  eventCreatedAt: Date
  deliveryId: string
  eventId: string
  eventType: string
  eventVersion: number
  payload: Record<string, unknown>
  secret: string
  target: ResolvedWebhookUrl
  timestamp?: Date
  timeoutMs?: number
  signal?: AbortSignal
}

export interface WebhookDeliveryResult {
  statusCode: number
  responseSnippet: string
}

export class WebhookDeliveryError extends Error {
  statusCode: number | null
  responseSnippet: string

  constructor(message: string, statusCode: number | null, responseSnippet = '') {
    super(message)
    this.name = 'WebhookDeliveryError'
    this.statusCode = statusCode
    this.responseSnippet = responseSnippet
  }
}

const encryptionKey = (sessionSecret: string): Buffer => scryptSync(sessionSecret, 'wiki-webhook-secret-v1', 32)

export const generateWebhookSecret = (): string => randomBytes(32).toString('base64url')

export const encryptWebhookSecret = (secret: string, sessionSecret: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(sessionSecret), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export const decryptWebhookSecret = (encrypted: string, sessionSecret: string): string => {
  const [version, encodedIv, encodedTag, encodedCiphertext] = encrypted.split('.')
  if (version !== 'v1' || !encodedIv || !encodedTag || encodedCiphertext === undefined) {
    throw new TypeError('Webhook secret ciphertext is invalid')
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(sessionSecret), Buffer.from(encodedIv, 'base64url'))
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8')
}

export const resolveWebhookUrl = async (value: string): Promise<ResolvedWebhookUrl> => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Webhook URL must be a valid absolute URL')
  }
  if (url.protocol !== 'https:') throw new TypeError('Webhook URL must use HTTPS')
  if (url.username || url.password) throw new TypeError('Webhook URL must not contain credentials')
  let addresses: LookupAddress[]
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true })
  } catch {
    throw new TypeError('Webhook URL hostname could not be resolved')
  }
  const selected = addresses.find(candidate =>
    !blockedAddresses.check(candidate.address, candidate.family === 4 ? 'ipv4' : 'ipv6')
  )
  if (!selected) throw new TypeError('Webhook URL must resolve to a public network address')
  if (selected.family !== 4 && selected.family !== 6) throw new TypeError('Webhook URL resolved to an unsupported address family')
  return { url, address: selected.address, family: selected.family }
}

export const webhookSignature = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

export const sendSignedWebhook = async (input: WebhookDeliveryRequest): Promise<WebhookDeliveryResult> => {
  input.signal?.throwIfAborted()
  const timestamp = (input.timestamp ?? new Date()).toISOString()
  const body = JSON.stringify({
    id: input.eventId,
    type: input.eventType,
    version: input.eventVersion,
    createdAt: input.eventCreatedAt.toISOString(),
    data: input.payload
  })
  const signature = webhookSignature(input.secret, timestamp, body)
  const { promise, reject, resolve } = Promise.withResolvers<WebhookDeliveryResult>()
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, input.target.address, input.target.family)
  }
  const abortController = new AbortController()
  const abortFromLease = (): void => abortController.abort(input.signal?.reason)
  let listeningForLeaseAbort = false
  if (input.signal?.aborted) {
    abortFromLease()
  } else if (input.signal) {
    input.signal.addEventListener('abort', abortFromLease, { once: true })
    listeningForLeaseAbort = true
  }
  const timeout = setTimeout(
    () => abortController.abort(new DOMException('Webhook delivery timed out', 'TimeoutError')),
    input.timeoutMs ?? 10_000
  )
  timeout.unref()

  try {
    const req = request(input.target.url, {
      method: 'POST',
      lookup: pinnedLookup,
      signal: abortController.signal,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'tsFranki-Webhook/1.0',
        'x-wiki-delivery': input.deliveryId,
        'x-wiki-event': input.eventType,
        'x-wiki-signature': signature,
        'x-wiki-timestamp': timestamp
      }
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        if (size >= 4_096) return
        const remaining = 4_096 - size
        const bounded = chunk.subarray(0, remaining)
        chunks.push(bounded)
        size += bounded.length
      })
      response.on('end', () => {
        const responseSnippet = Buffer.concat(chunks).toString('utf8')
        const statusCode = response.statusCode ?? 0
        if (statusCode >= 200 && statusCode < 300) resolve({ statusCode, responseSnippet })
        else reject(new WebhookDeliveryError(`Webhook returned HTTP ${statusCode}`, statusCode, responseSnippet))
      })
    })
    req.once('error', error => reject(new WebhookDeliveryError(error.message, null)))
    req.end(body)
    return await promise
  } finally {
    clearTimeout(timeout)
    if (listeningForLeaseAbort) input.signal?.removeEventListener('abort', abortFromLease)
  }
}
