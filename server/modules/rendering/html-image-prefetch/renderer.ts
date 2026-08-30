import { hasValidDiagramPrefetchToken } from './trusted-diagram.ts'
import type { LookupFunction } from 'node:net'
import { request } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { resolveWebhookUrl, type ResolvedWebhookUrl } from '../../../core/webhooks.ts'
import { wiki } from '../../types.ts'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { Element } from 'domhandler'

const PREFETCH_ATTRIBUTE = 'data-diagram-prefetch'
const PREFETCH_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_CONCURRENCY = 4
const acceptedContentTypes: Readonly<Record<string, true>> = {
  'image/gif': true,
  'image/jpeg': true,
  'image/png': true,
  'image/svg+xml': true,
  'image/webp': true
}

const sameProviderOrigin = (url: URL, providerOrigin: string): void => {
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== providerOrigin) {
    throw new TypeError('Diagram image URL left its trusted provider origin')
  }
}

const waitForResolution = async <Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> => {
  signal.throwIfAborted()
  const { promise, resolve, reject } = Promise.withResolvers<Result>()
  const aborted = (): void => reject(signal.reason)
  signal.addEventListener('abort', aborted, { once: true })
  operation.then(resolve, reject)
  try {
    return await promise
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}

const requestImage = async (target: ResolvedWebhookUrl, signal: AbortSignal): Promise<IncomingMessage> => {
  signal.throwIfAborted()
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>()
  const failed = (error: Error): void => reject(error)
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, target.address, target.family)
  }
  const req = request(
    target.url,
    {
      method: 'GET',
      lookup: pinnedLookup,
      signal,
      headers: {
        accept: 'image/svg+xml,image/png,image/jpeg,image/gif,image/webp',
        'user-agent': 'tsFranki-Diagram-Prefetch/1.0'
      }
    },
    response => {
      req.removeListener('error', failed)
      resolve(response)
    }
  )
  req.once('error', failed)
  req.end()
  return await promise
}

const readImage = async (response: IncomingMessage): Promise<{ contentType: string; bytes: Buffer }> => {
  const contentType = (response.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (acceptedContentTypes[contentType] !== true) {
    response.resume()
    throw new TypeError('Diagram image response has an unsupported content type')
  }
  const contentLength = response.headers['content-length']
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_RESPONSE_BYTES) {
      response.destroy()
      throw new RangeError('Diagram image response exceeds the byte limit')
    }
  }

  const chunks: Buffer[] = []
  let byteLength = 0
  let settled = false
  const { promise, resolve, reject } = Promise.withResolvers<{ contentType: string; bytes: Buffer }>()
  const cleanup = (): void => {
    response.removeListener('data', received)
    response.removeListener('end', completed)
    response.removeListener('aborted', aborted)
    response.removeListener('error', failed)
  }
  const failed = (error: Error): void => {
    if (settled) return
    settled = true
    cleanup()
    reject(error)
  }
  const received = (chunk: Buffer | Uint8Array | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > MAX_RESPONSE_BYTES) {
      failed(new RangeError('Diagram image response exceeds the byte limit'))
      response.destroy()
      return
    }
    chunks.push(bytes)
  }
  const completed = (): void => {
    if (settled) return
    settled = true
    cleanup()
    resolve({ contentType, bytes: Buffer.concat(chunks, byteLength) })
  }
  const aborted = (): void => failed(new Error('Diagram image response was aborted'))
  response.on('data', received)
  response.once('end', completed)
  response.once('aborted', aborted)
  response.once('error', failed)
  return await promise
}

const fetchDiagramImage = async (source: string, signal: AbortSignal): Promise<{ contentType: string; bytes: Buffer }> => {
  const initialUrl = new URL(source)
  if (initialUrl.protocol !== 'https:' || initialUrl.username || initialUrl.password) {
    throw new TypeError('Diagram image URL must use a credential-free HTTPS origin')
  }
  const providerOrigin = initialUrl.origin
  let currentUrl = initialUrl

  for (let redirectCount = 0; ; redirectCount += 1) {
    sameProviderOrigin(currentUrl, providerOrigin)
    const target = await waitForResolution(resolveWebhookUrl(currentUrl.toString()), signal)
    sameProviderOrigin(target.url, providerOrigin)
    const response = await requestImage(target, signal)
    const statusCode = response.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const location = response.headers.location
      response.resume()
      if (!location || redirectCount >= MAX_REDIRECTS) {
        throw new Error('Diagram image response exceeded the redirect limit')
      }
      currentUrl = new URL(location, currentUrl)
      sameProviderOrigin(currentUrl, providerOrigin)
      continue
    }
    if (statusCode < 200 || statusCode >= 300) {
      response.resume()
      throw new Error(`Diagram image prefetch failed with HTTP ${statusCode}`)
    }
    return await readImage(response)
  }
}

const prefetch = async (element: Cheerio<Element>): Promise<void> => {
  const url = element.attr('src')
  const token = element.attr(PREFETCH_ATTRIBUTE)
  element.removeAttr(PREFETCH_ATTRIBUTE)
  if (typeof url !== 'string' || typeof token !== 'string' || !hasValidDiagramPrefetchToken(url, token)) return

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(new DOMException('Diagram image prefetch timed out', 'TimeoutError')), PREFETCH_TIMEOUT_MS)
  timeout.unref()
  try {
    const image = await fetchDiagramImage(url, abortController.signal)
    element.attr('src', `data:${image.contentType};base64,${image.bytes.toString('base64')}`)
  } catch (err: unknown) {
    wiki.logger.warn(`Failed to prefetch diagram image from ${url}`)
    wiki.logger.warn(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeout)
  }
}

const runBounded = async (elements: Element[], $: CheerioAPI): Promise<void> => {
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < elements.length) {
      const element = elements[nextIndex]
      nextIndex += 1
      if (element) await prefetch($(element))
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, elements.length) }, worker))
}

const plugin = {
  async init($: CheerioAPI): Promise<void> {
    await runBounded($(`img[${PREFETCH_ATTRIBUTE}]`).toArray(), $)
  }
}

export const imagePrefetchLimits = {
  concurrency: MAX_CONCURRENCY,
  responseBytes: MAX_RESPONSE_BYTES,
  redirects: MAX_REDIRECTS,
  timeoutMs: PREFETCH_TIMEOUT_MS
} as const

export default plugin
