import { createHash } from 'node:crypto'
import { LocaleCodeSchema, MAX_LOCALE_FILE_BYTES } from '../../shared/locale-policy.ts'
import { LocaleCatalogResponseSchema, parseLocaleStrings, type LocaleStrings } from '../helpers/locale-package.ts'
const MAX_RESPONSE_BYTES = MAX_LOCALE_FILE_BYTES
const MAX_LOCALE_KEYS = 30_000
const MAX_LOCALE_KEY_LENGTH = 500
const MAX_LOCALE_VALUE_LENGTH = 100_000
const failFile = (): never => {
  throw new Error('Choose a nonempty flat JSON language file with valid translation keys and string values.')
}
const readJsonString = (source: string, offset: { value: number }): string => {
  const start = offset.value
  if (source[offset.value] !== '"') return failFile()
  offset.value++
  while (offset.value < source.length) {
    const character = source[offset.value]!
    if (character === '\\') {
      offset.value += 2
      continue
    }
    if (character === '"') {
      offset.value++
      try {
        const value: unknown = JSON.parse(source.slice(start, offset.value))
        if (typeof value === 'string') return value
      } catch {
        return failFile()
      }
      return failFile()
    }
    if (character.charCodeAt(0) < 0x20) return failFile()
    offset.value++
  }
  return failFile()
}
export interface ParsedLocaleFile {
  digest: string
  strings: LocaleStrings
  normalized: string
}
/** Parse a bounded flat translation file without losing duplicate JSON properties. */
export const parseLocaleFileBytes = (bytes: Uint8Array): ParsedLocaleFile => {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_LOCALE_FILE_BYTES) return failFile()
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failFile()
  }
  const offset = { value: 0 }
  const whitespace = () => {
    while (
      source[offset.value] === ' ' ||
      source[offset.value] === '\t' ||
      source[offset.value] === '\r' ||
      source[offset.value] === '\n'
    )
      offset.value++
  }
  whitespace()
  if (source[offset.value++] !== '{') return failFile()
  const rows: Array<{ key: string; value: string }> = [],
    keys = new Set<string>()
  let closed = false
  whitespace()
  if (source[offset.value] === '}') return failFile()
  while (offset.value < source.length) {
    whitespace()
    const key = readJsonString(source, offset)
    if (!key || key.includes('::') || keys.has(key) || key.length > MAX_LOCALE_KEY_LENGTH) return failFile()
    keys.add(key)
    whitespace()
    if (source[offset.value++] !== ':') return failFile()
    whitespace()
    const value = readJsonString(source, offset)
    if (value.length > MAX_LOCALE_VALUE_LENGTH) return failFile()
    rows.push({ key, value })
    if (rows.length > MAX_LOCALE_KEYS) return failFile()
    whitespace()
    const delimiter = source[offset.value++]
    if (delimiter === '}') {
      closed = true
      break
    }
    if (delimiter !== ',') return failFile()
    whitespace()
    if (source[offset.value] === '}') return failFile()
  }
  whitespace()
  if (!closed || offset.value !== source.length) return failFile()
  let strings: LocaleStrings
  try {
    strings = parseLocaleStrings({ data: { localization: { strings: rows } } })
  } catch {
    return failFile()
  }
  return { digest: createHash('sha256').update(bytes).digest('hex'), strings, normalized: JSON.stringify(strings) }
}
export const requestLocaleSource = async (
  endpoint: string,
  query: string,
  variables: Record<string, string> | undefined,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> => {
  const deadline = AbortSignal.timeout(20_000)
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) })
  })
  if (!response.ok) throw new Error('The language source returned an unsuccessful response.')
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body)
    throw new Error('The language source response is too large or empty.')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      deadline.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('The language source response exceeds the size limit.')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
}
export const fetchLocaleCatalog = async (endpoint: string, signal?: AbortSignal, fetchImpl?: typeof fetch) =>
  LocaleCatalogResponseSchema.parse(
    await requestLocaleSource(
      endpoint,
      '{ localization { locales { availability code name nativeName isRTL createdAt updatedAt } } }',
      undefined,
      signal,
      fetchImpl
    )
  ).data.localization.locales
export const fetchLocaleStrings = async (endpoint: string, code: string, signal?: AbortSignal, fetchImpl?: typeof fetch) =>
  parseLocaleStrings(
    await requestLocaleSource(
      endpoint,
      'query ($code: String!) { localization { strings(code: $code) { key value } } }',
      { code: LocaleCodeSchema.parse(code) },
      signal,
      fetchImpl
    )
  )
