import { z } from 'zod'

const TargetInput = z.string().min(1).max(4_096)
const containsControlOrBackslash = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (value[index] === '\\' || code <= 0x1f || code === 0x7f) return true
  }
  return false
}
const encodedPathOctet = /%[0-9a-f]{2}/i

export class BrowserTargetError extends Error {
  readonly code = 'INVALID_BROWSER_TARGET'
  constructor(message: string) { super(message); this.name = 'BrowserTargetError' }
}

export interface CanonicalBrowserTarget {
  readonly canonicalUrl: string
  readonly scheme: 'http:' | 'https:'
  readonly hostname: string
  readonly port: string
  readonly pathAndQuery: string
}

export const parseCanonicalBrowserTarget = (inputValue: unknown): CanonicalBrowserTarget => {
  const input = TargetInput.parse(inputValue)
  if (containsControlOrBackslash(input)) throw new BrowserTargetError('Browser target contains a forbidden character')
  let url: URL
  try { url = new URL(input) } catch { throw new BrowserTargetError('Browser target must be an absolute URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BrowserTargetError('Browser target scheme is not allowed')
  if (url.username || url.password) throw new BrowserTargetError('Browser target cannot contain credentials')
  if (url.hash) throw new BrowserTargetError('Browser target cannot contain a fragment')
  if (encodedPathOctet.test(url.pathname)) throw new BrowserTargetError('Browser target path cannot contain percent-encoded octets')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) throw new BrowserTargetError('Browser target host is required')
  url.hostname = host
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = ''
  const seenKeys = new Set<string>()
  for (const [key] of url.searchParams) {
    if (seenKeys.has(key)) throw new BrowserTargetError('Browser target query keys must be unique')
    seenKeys.add(key)
  }
  url.search = url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : ''
  const canonicalUrl = url.toString()
  if (input !== canonicalUrl) throw new BrowserTargetError('Browser target is not canonically serialized')
  return { canonicalUrl, scheme: url.protocol as 'http:' | 'https:', hostname: url.hostname, port: url.port, pathAndQuery: `${url.pathname}${url.search}` }
}
