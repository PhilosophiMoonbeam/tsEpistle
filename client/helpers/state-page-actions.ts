/** Shared actions for the not-found and unauthorized state pages. */

const hasSameOriginHistory = (): boolean => {
  if (window.history.length <= 1 || !document.referrer) return false
  try {
    return new URL(document.referrer, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

/** Go back only to a page on this site; otherwise open the fallback. */
export const goBackOrHome = (fallback = '/'): void => {
  if (hasSameOriginHistory()) {
    window.history.back()
    return
  }
  window.location.assign(fallback)
}

const SCOPE_PREFIXES = new Set(['_private'])

/**
 * Turns a missing page path into search words: drops the scope and locale
 * prefixes and joins the remaining segments, with - and _ read as spaces.
 */
export const searchQueryFromPath = (pathname: string, localeCodes: readonly string[] = []): string => {
  const locales = new Set(localeCodes.map(code => code.toLowerCase()))
  const segments = pathname.split('/').map(segment => segment.trim()).filter(Boolean)
  while (segments.length > 0 && SCOPE_PREFIXES.has(segments[0]!)) segments.shift()
  if (segments.length > 1 && locales.has(segments[0]!.toLowerCase())) segments.shift()
  return segments
    .map(segment => segment.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+.]+/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** Accepts only a same-origin editor route (`/e/...`); anything else gives ''. */
export const safeEditorHref = (value: unknown): string =>
  typeof value === 'string' && value.startsWith('/e/') && !/[\\\s]/.test(value) && !value.includes('//') ? value : ''
