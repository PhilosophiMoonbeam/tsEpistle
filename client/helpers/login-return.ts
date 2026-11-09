import { hasAsciiControlCharacters } from '../../shared/text-safety.ts'

/** Root-relative navigation only. Used on both sides of the login cookie boundary. */
export function safeLoginReturn (value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  // Only path bytes can alter navigation authority; query and fragment data stay inert.
  const boundary = value.search(/[?#]/u)
  const pathname = boundary < 0 ? value : value.slice(0, boundary)
  if (/\s/u.test(value) || hasAsciiControlCharacters(value) || pathname.includes('\\') || /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(pathname)) return null
  try {
    decodeURIComponent(value)
    const parsed = new URL(value, 'https://login-return.invalid')
    if (parsed.origin !== 'https://login-return.invalid' || parsed.pathname.startsWith('//')) return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}

export function resolveLoginReturn (cookie: unknown, fallback: unknown): string {
  const target = safeLoginReturn(cookie)
  return (target && target !== '/' ? target : safeLoginReturn(fallback)) ?? target ?? '/'
}
