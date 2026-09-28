export interface WikiLink {
  readonly raw: string
  readonly authoredTarget: string
  readonly targetPath: string
  readonly fragment: string | null
  readonly label: string | null
  readonly text: string
}

export interface WikiLinkContext {
  readonly locale: string
  readonly pagePath: string
  readonly namespaced: boolean
  readonly absoluteLinks?: boolean
}

export interface WikiLinkOptions {
  readonly enabled: boolean
  readonly context?: WikiLinkContext
}

export const WIKI_LINKS_DISABLED: WikiLinkOptions = Object.freeze({ enabled: false })

const VALID_LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

function hasControlCharacters (value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

const parseWikiLinkPrefix = (source: string): WikiLink | null => {
  const match = /^\[\[([^[\]\r\n]+)\]\]/u.exec(source)
  if (!match) return null

  const payload = match[1] ?? ''
  const separator = payload.indexOf('|')
  if (separator !== payload.lastIndexOf('|')) return null

  const authoredTarget = separator < 0 ? payload : payload.slice(0, separator)
  const label = separator < 0 ? null : payload.slice(separator + 1)
  if (label !== null && (!label.trim() || hasControlCharacters(label) || label.includes('[') || label.includes(']') || label.includes('|'))) return null

  const hash = authoredTarget.indexOf('#')
  if (hash !== authoredTarget.lastIndexOf('#')) return null
  const targetPath = hash < 0 ? authoredTarget : authoredTarget.slice(0, hash)
  const fragment = hash < 0 ? null : authoredTarget.slice(hash + 1)
  if (fragment !== null && (!fragment || hasControlCharacters(fragment) || /\s/u.test(fragment) || fragment.includes('#') || fragment.includes('[') || fragment.includes(']') || fragment.includes('|'))) return null
  if (!targetPath && fragment === null) return null
  if (targetPath && !normalizePagePath(targetPath)) return null

  const text = label ?? (targetPath || fragment || '')
  return {
    raw: match[0],
    authoredTarget,
    targetPath,
    fragment,
    label,
    text
  }
}

/** Parse a complete wikilink source string. Invalid and unsafe forms return null. */
export function parseWikiLink(source: string): WikiLink | null {
  const parsed = parseWikiLinkPrefix(source)
  return parsed?.raw === source ? parsed : null
}

/** Parse a wikilink at the start of an inline source, excluding ordinary Markdown link continuations. */
export function parseWikiLinkAt(source: string): WikiLink | null {
  const parsed = parseWikiLinkPrefix(source)
  if (!parsed) return null

  const continuation = source[parsed.raw.length]
  if (continuation === '(' || (continuation === '[' && source[parsed.raw.length + 1] !== '[')) return null
  return parsed
}

/** Preserve the exact authored spelling when the corresponding visual link is unchanged. */
export function serializeWikiLink(source: string | WikiLink): string | null {
  const parsed = typeof source === 'string' ? parseWikiLink(source) : parseWikiLink(source.raw)
  return parsed?.raw ?? null
}

function normalizePagePath(value: string): { readonly path: string; readonly absolute: boolean } | null {
  if (
    !value.trim() ||
    value.length > 1024 ||
    hasControlCharacters(value) ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('|') ||
    value.includes('\\')
  ) return null
  if (value.startsWith('//')) return null

  const absolute = value.startsWith('/')
  const withoutLeadingSlash = absolute ? value.slice(1) : value
  const withoutTrailingSlash = withoutLeadingSlash.endsWith('/') ? withoutLeadingSlash.slice(0, -1) : withoutLeadingSlash
  if (!withoutTrailingSlash || withoutTrailingSlash.includes('//')) return null

  const segments = withoutTrailingSlash.split('/')
  if (segments.some(segment =>
    !segment || !segment.trim() ||
    segment === '.' ||
    segment === '..' ||
    /\.{2,}/u.test(segment) ||
    segment.includes(':') ||
    segment.includes('?') ||
    segment.includes('#') ||
    segment.includes('|') ||
    segment.includes('[') ||
    segment.includes(']')
  )) return null
  try {
    for (const segment of segments) encodeURIComponent(segment)
  } catch {
    return null
  }
  return { path: segments.join('/'), absolute }
}

/** Escape page-path dots so html-core's literal-dot asset heuristic still treats the href as a page. */
function encodePagePath(path: string): string {
  return path.split('/').map(segment =>
    encodeURIComponent(segment).replace(/\./gu, '%2E')
  ).join('/')
}

/** Resolve a parsed local target to a same-origin route. No URL schemes or hosts are accepted. */
export function resolveWikiLinkHref(source: string | WikiLink, context?: WikiLinkContext): string | null {
  const parsed = typeof source === 'string' ? parseWikiLink(source) : parseWikiLink(source.raw)
  if (!parsed) return null

  let fragment = ''
  if (parsed.fragment !== null) {
    try {
      fragment = `#${encodeURIComponent(parsed.fragment)}`
    } catch {
      return null
    }
  }
  if (!parsed.targetPath) return fragment || null

  const target = normalizePagePath(parsed.targetPath)
  if (!target) return null

  if (!context) return null

  if (!VALID_LOCALE.test(context.locale)) return null
  const current = normalizePagePath(context.pagePath)
  if (!current || current.absolute) return null

  const routePath = target.absolute || context.absoluteLinks === true || current.path === 'home'
    ? target.path
    : `${current.path}/${target.path}`
  const encodedPath = encodePagePath(routePath)
  const localePrefix = context.namespaced ? `/${encodeURIComponent(context.locale)}` : ''
  return `${localePrefix}/${encodedPath}${fragment}`
}
