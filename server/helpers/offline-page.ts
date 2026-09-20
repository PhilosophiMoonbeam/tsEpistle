import { createHash } from 'node:crypto'
import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'
import {
  OFFLINE_CONTENT_TYPE,
  OFFLINE_HTML_SANITIZER_VERSION,
  OFFLINE_RECORD_BYTES_LIMIT,
  type OfflinePageSnapshotV1,
  OfflinePageSnapshotV1Schema
} from '../../shared/offline.ts'
import type { PageRuleAuthority } from './group-access.ts'
import { canReadPage, type PagePrincipal, type PageVisibilityRecord, pageAuthorizationContext, pageRoute } from './page-access.ts'

const { JSDOM } = jsdomModule
const domWindow = new JSDOM('').window
const domPurify = createDOMPurify(domWindow)

const ALLOWED_TAGS = [
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'strong',
  'em',
  'del',
  's',
  'mark',
  'hr',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a'
] as const
const ALLOWED_TAG_SET = new Set<string>(ALLOWED_TAGS)
const PASSIVE_WRAPPER_TAGS = new Set(['html', 'body', 'div', 'span', 'section', 'article', 'main', 'header', 'footer', 'figure', 'figcaption', 'aside'])
const TEXT_PROJECTED_TAGS = new Set(['img', 'details', 'summary'])
const ACTIVE_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'img',
  'image',
  'picture',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'svg',
  'math',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'link',
  'base',
  'meta',
  'portal',
  'applet',
  'details',
  'summary',
  'dialog',
  'marquee',
  'map',
  'area'
])
const ACTIVE_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'poster',
  'background',
  'cite',
  'action',
  'formaction',
  'xlink:href',
  'srcdoc',
  'style',
  'form',
  'is',
  'ping'
])
const DOM_CLOBBERING_ATTRIBUTES = new Set(['id', 'name', 'slot'])

export const OFFLINE_PAGE_INELIGIBLE_CODE = 'OFFLINE_PAGE_INELIGIBLE' as const
export class OfflinePageProjectionError extends Error {
  readonly status = 404
  readonly code = OFFLINE_PAGE_INELIGIBLE_CODE

  constructor(message = 'This page is not available for offline use.') {
    super(message)
    this.name = 'OfflinePageProjectionError'
  }
}

/**
 * Authority loading and projection configuration are server failures, not
 * candidate eligibility decisions. Controllers must leave this error on their
 * normal 5xx path rather than exposing an eligibility response.
 */
export class OfflinePageAuthorityError extends Error {
  readonly code = 'OFFLINE_PAGE_AUTHORITY_UNAVAILABLE'

  constructor(message = 'Offline page authority is unavailable') {
    super(message)
    this.name = 'OfflinePageAuthorityError'
  }
}

/**
 * The configured site origin and the page's canonical route are the only
 * base coordinates permitted for resolving passive document links.
 */
export interface OfflinePageLinkProjection {
  readonly canonicalOrigin: string
  readonly canonicalPath: string
}

export interface OfflinePageSource extends Record<string, unknown> {
  id: number
  path: string
  localeCode: string
  title: string
  description?: string | null
  visibility: 'public' | 'private'
  ownerId: number | null
  tags: unknown
  isPublished: boolean | number
  publishStartDate?: string | Date | null
  publishEndDate?: string | Date | null
  contentType: string
  editorKey: string
  render: string
  sourceRevision: string | number | bigint
  renderedSourceRevision?: string | number | bigint | null
  extra?: unknown
}

export interface OfflinePageSnapshotInput extends OfflinePageLinkProjection {
  page: unknown
  requester: PagePrincipal
  authority: PageRuleAuthority
  audience: 'public' | 'private'
  capturedAt?: Date
}

const invalid = (message: string): never => {
  throw new OfflinePageProjectionError(message)
}
const offlinePageVisibility = (value: unknown): 'public' | 'private' => {
  if (value === 'public' || value === 'private') return value
  return invalid('The page identity is invalid')
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const createTemplate = (): HTMLTemplateElement => {
  const document = domWindow.document
  if (!document) throw new TypeError('Offline snapshot document is unavailable')
  return document.createElement('template')
}

const normalizedBoolean = (value: unknown): boolean | null => {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return null
}

const parseDate = (value: unknown, label: string): Date | null => {
  if (value === undefined || value === null || value === '') return null
  const date = value instanceof Date ? new Date(value.valueOf()) : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.valueOf())) invalid(`${label} is invalid`)
  return date
}

const canonicalSourceRevision = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') invalid('The page source revision is invalid')
  const revision = String(value)
  if (!/^[1-9][0-9]*$/u.test(revision) || revision.length > 512) invalid('The page source revision is invalid')
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) invalid('The page source revision is invalid')
  return revision
}

export const canonicalOfflineOrigin = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || value !== value.trim()) throw new TypeError('Offline page origin is invalid')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Offline page origin is invalid')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new TypeError('Offline page origin is invalid')
  return parsed.origin
}

interface ResolvedOfflinePageLinkProjection {
  readonly origin: string
  readonly pageUrl: URL
}

const resolveLinkProjection = (projection: OfflinePageLinkProjection): ResolvedOfflinePageLinkProjection => {
  const origin = canonicalOfflineOrigin(projection.canonicalOrigin)
  const route = projection.canonicalPath
  if (
    typeof route !== 'string' ||
    route.length === 0 ||
    route.length > 2048 ||
    route !== route.trim() ||
    !route.startsWith('/') ||
    route.includes('\\') ||
    [...route].some(character => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
  )
    throw new TypeError('Offline page route is invalid')
  let pageUrl: URL
  try {
    pageUrl = new URL(route, `${origin}/`)
  } catch {
    throw new TypeError('Offline page route is invalid')
  }
  if (pageUrl.origin !== origin || pageUrl.pathname !== route || pageUrl.search || pageUrl.hash) throw new TypeError('Offline page route is invalid')
  return { origin, pageUrl }
}

const RESERVED_SAME_ORIGIN_PATH_PATTERNS = [
  /^\/(?:_api|api|graphql|mcp)(?:\/|$)/iu,
  /^\/(?:login|logout|register|auth|session|unlock|_unlock|verify|login-reset)(?:\/|$)/iu,
  /^\/(?:u|upload|uploads|setup|admin|a|p|_admin|_private|_userav)(?:\/|$)/iu,
  /^\/(?:d|e|h|s|i|t)(?:\/|$)/iu,
  /^\/(?:_offline|sw\.js|sw-tombstone\.js|manifest(?:\.webmanifest|\.json)?|robots\.txt|health|healthz|metrics)(?:\/|$)/iu,
  /^\/_assets(?:\/|$)/iu
] as const

const decodedPath = (pathname: string): string | null => {
  let current = pathname
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return null
    }
    if (decoded === current) return current
    current = decoded
  }
  return current
}

const reservedSameOriginPath = (pathname: string): boolean => {
  const decoded = decodedPath(pathname)
  if (decoded === null) return true
  if (
    decoded.includes('\\') ||
    [...decoded].some(character => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
  )
    return true
  const normalized = decoded.replace(/\/+/gu, '/')
  return RESERVED_SAME_ORIGIN_PATH_PATTERNS.some(pattern => pattern.test(normalized))
}

const canonicalAnchorUrl = (value: string, projection: ResolvedOfflinePageLinkProjection): string | null => {
  const hasControlCharacter = [...value].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
  if (value.length === 0 || value !== value.trim() || hasControlCharacter || value.includes('\\') || value.startsWith('//')) return null
  let url: URL
  try {
    url = new URL(value, projection.pageUrl)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
  const sameDocumentFragment =
    url.hash.length > 1 && url.origin === projection.origin && url.pathname === projection.pageUrl.pathname && url.search === projection.pageUrl.search
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === projection.origin &&
    reservedSameOriginPath(url.pathname) &&
    !sameDocumentFragment
  )
    return null
  return url.href
}

const textOnlyAnchorHref = (value: string): boolean => value === '' || /^tel:/iu.test(value)

const hasUnsafeProjectionMarkup = (fragment: string, projection: ResolvedOfflinePageLinkProjection): boolean => {
  const template = createTemplate()
  template.innerHTML = fragment
  for (const element of template.content.querySelectorAll('*')) {
    const tagName = element.tagName.toLowerCase()
    if (ACTIVE_TAGS.has(tagName) && !TEXT_PROJECTED_TAGS.has(tagName)) return true
    if (!ALLOWED_TAG_SET.has(tagName) && !PASSIVE_WRAPPER_TAGS.has(tagName) && !TEXT_PROJECTED_TAGS.has(tagName)) return true
    if (tagName === 'a') {
      const href = element.getAttribute('href')
      if (href !== null && !textOnlyAnchorHref(href) && canonicalAnchorUrl(href, projection) === null) return true
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      // Markdown table alignment is presentation only; the sanitizer drops it.
      const passiveTableAlignment =
        name === 'style' && (tagName === 'th' || tagName === 'td') && /^\s*text-align\s*:\s*(?:left|center|right)\s*;?\s*$/iu.test(attribute.value)
      if (passiveTableAlignment) continue
      if (name.startsWith('on') || name.startsWith('data-') || (ACTIVE_ATTRIBUTES.has(name) && !(tagName === 'img' && name === 'src'))) return true
      if (name === 'aria-hidden' || name === 'hidden') return true
      if (
        name === 'class' &&
        /extension|tabset|transclusion|transcluded|include|(?:^|[\s_-])(?:tabs?|spoiler|media|diagram|youtube|kroki|plantuml|pdf)(?:$|[\s_-])/iu.test(
          attribute.value
        )
      )
        return true
      if (name === 'href' && tagName !== 'a') return true
      if (DOM_CLOBBERING_ATTRIBUTES.has(name)) continue
    }
  }
  return false
}

export const sanitizeOfflineHtmlFragment = (fragment: string, projection: OfflinePageLinkProjection): string => {
  if (typeof fragment !== 'string' || fragment.length > OFFLINE_RECORD_BYTES_LIMIT) invalid('The page contains unsupported active content')
  const resolvedProjection = resolveLinkProjection(projection)
  if (hasUnsafeProjectionMarkup(fragment, resolvedProjection)) invalid('The page contains unsupported active content')
  const sourceTemplate = createTemplate()
  sourceTemplate.innerHTML = fragment
  // Preserve passive document text without retaining image requests or interactive
  // disclosure behavior. Validate the original subtree above before flattening it.
  for (const element of sourceTemplate.content.querySelectorAll('img')) {
    element.replaceWith(sourceTemplate.ownerDocument.createTextNode(element.getAttribute('alt') ?? ''))
  }
  for (const element of sourceTemplate.content.querySelectorAll('details, summary')) {
    const replacement = sourceTemplate.ownerDocument.createElement(element.tagName.toLowerCase() === 'summary' ? 'p' : 'div')
    replacement.append(...element.childNodes)
    element.replaceWith(replacement)
  }
  for (const element of sourceTemplate.content.querySelectorAll('a')) {
    const href = element.getAttribute('href')
    if (href === null) continue
    if (textOnlyAnchorHref(href)) {
      element.removeAttribute('href')
      continue
    }
    const canonical = canonicalAnchorUrl(href, resolvedProjection) ?? invalid('The page contains an unsafe link')
    element.setAttribute('href', canonical)
  }
  const sanitized = String(
    domPurify.sanitize(sourceTemplate.innerHTML, {
      ALLOWED_TAGS: [...ALLOWED_TAGS],
      ALLOWED_ATTR: ['href'],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      FORBID_ATTR: ['style'],
      RETURN_TRUSTED_TYPE: false
    })
  )
  const template = createTemplate()
  template.innerHTML = sanitized
  for (const element of template.content.querySelectorAll('*')) {
    const tagName = element.tagName.toLowerCase()
    if (!ALLOWED_TAG_SET.has(tagName)) invalid('The page projection contains an unsupported element')
    for (const attribute of element.attributes) {
      if (attribute.name.toLowerCase() !== 'href' || tagName !== 'a') invalid('The page projection contains an unsupported attribute')
      const canonical = canonicalAnchorUrl(attribute.value, resolvedProjection) ?? invalid('The page projection contains an unsafe link')
      element.setAttribute('href', canonical)
    }
  }
  return template.innerHTML
}

const normalizedExtra = (value: unknown): Record<string, unknown> | null => {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return null
    }
  }
  if (!isRecord(value)) return null
  for (const key of ['js', 'css']) {
    if (Object.hasOwn(value, key) && value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || value[key].trim().length > 0))
      return null
  }
  return value
}

const integrityFor = (snapshot: Omit<OfflinePageSnapshotV1, 'integrity'>): string =>
  createHash('sha256')
    .update(`tsepistle/offline-snapshot-v1\u0000${JSON.stringify(snapshot)}`, 'utf8')
    .digest('hex')

export const buildOfflinePageSnapshot = (input: OfflinePageSnapshotInput): OfflinePageSnapshotV1 => {
  const authority = input.authority
  if (
    !isRecord(input.page) ||
    !input.requester ||
    !isRecord(authority) ||
    authority.requester !== input.requester ||
    (input.audience !== 'public' && input.audience !== 'private') ||
    !Array.isArray(authority.permissions) ||
    !authority.permissions.every(permission => typeof permission === 'string') ||
    !Array.isArray(authority.groups) ||
    !isRecord(authority.tagAliases)
  )
    throw new OfflinePageAuthorityError()
  const page = input.page as Partial<OfflinePageSource> & Record<string, unknown>
  const ownerId = page.ownerId
  let pageOwnerId: number | null = null
  if (ownerId === null) pageOwnerId = null
  else if (typeof ownerId === 'number' && Number.isSafeInteger(ownerId) && ownerId > 0) pageOwnerId = ownerId
  else invalid('The page identity is invalid')

  const pageIdValue = page.id
  const pathValue = page.path
  const localeCodeValue = page.localeCode
  const tags = page.tags
  const pageId =
    typeof pageIdValue === 'number' && Number.isSafeInteger(pageIdValue) && pageIdValue >= 1 ? pageIdValue : invalid('The page identity is invalid')
  const path = typeof pathValue === 'string' && pathValue.length >= 1 && pathValue.length <= 2048 ? pathValue : invalid('The page identity is invalid')
  const localeCode =
    typeof localeCodeValue === 'string' && localeCodeValue.length >= 2 && localeCodeValue.length <= 35
      ? localeCodeValue
      : invalid('The page identity is invalid')
  if (!Array.isArray(tags)) invalid('The page identity is invalid')
  const sourceRevision = canonicalSourceRevision(page.sourceRevision)
  const renderedSourceRevision =
    page.renderedSourceRevision === undefined || page.renderedSourceRevision === null ? null : canonicalSourceRevision(page.renderedSourceRevision)
  if (renderedSourceRevision === null || renderedSourceRevision !== sourceRevision) invalid('The page render is not current for its source revision')
  const visibility = offlinePageVisibility(page.visibility)
  if (input.audience === 'public' && visibility !== 'public') invalid('The page is not publicly readable')
  const canonicalPath = pageRoute({ visibility, localeCode, path })
  if (input.canonicalPath !== canonicalPath) throw new TypeError('Offline page route is invalid')
  const linkProjection: OfflinePageLinkProjection = { canonicalOrigin: input.canonicalOrigin, canonicalPath }
  resolveLinkProjection(linkProjection)

  const titleValue = page.title
  const descriptionValue = page.description
  const title = typeof titleValue === 'string' && titleValue.length <= 4096 ? titleValue : invalid('The page metadata is invalid')
  const description =
    descriptionValue === undefined || descriptionValue === null
      ? ''
      : typeof descriptionValue === 'string' && descriptionValue.length <= 16_384
        ? descriptionValue
        : invalid('The page metadata is invalid')
  const renderValue = page.render
  const editorKey = page.editorKey
  const contentType = page.contentType
  const render = typeof renderValue === 'string' ? renderValue : invalid('The page has no rendered projection')

  const accessPage: PageVisibilityRecord = { path, locale: localeCode, localeCode, visibility, ownerId: pageOwnerId, tags }
  if (pageAuthorizationContext(accessPage) === null || !canReadPage(input.requester, accessPage, input.authority))
    invalid(input.audience === 'public' ? 'The page is not publicly readable' : 'The page is not readable')
  const capturedAt =
    input.capturedAt === undefined
      ? new Date()
      : input.capturedAt instanceof Date
        ? new Date(input.capturedAt.valueOf())
        : invalid('The capture time is invalid')
  const publicationStart = parseDate(page.publishStartDate, 'Publication start')
  const publicationEnd = parseDate(page.publishEndDate, 'Publication end')
  if (publicationStart && publicationEnd && publicationStart.valueOf() > publicationEnd.valueOf()) invalid('The publication window is invalid')
  if (
    normalizedBoolean(page.isPublished) !== true ||
    (publicationStart !== null && publicationStart.valueOf() > capturedAt.valueOf()) ||
    (publicationEnd !== null && publicationEnd.valueOf() < capturedAt.valueOf())
  )
    invalid('The page is not currently published')
  if (editorKey !== 'markdown' && editorKey !== 'visual-markdown' && editorKey !== 'asciidoc') invalid('The page editor is not supported offline')
  if ((editorKey === 'markdown' || editorKey === 'visual-markdown') && contentType !== 'markdown') invalid('The page content type is not supported offline')
  if (editorKey === 'asciidoc' && contentType !== 'asciidoc') invalid('The page content type is not supported offline')
  if (normalizedExtra(page.extra) === null) invalid('The page contains unsupported custom content')
  const html = sanitizeOfflineHtmlFragment(render, linkProjection)
  const contentTemplate = createTemplate()
  contentTemplate.innerHTML = html
  const searchText = (contentTemplate.content.textContent ?? '').replace(/\s+/gu, ' ').trim()
  if (Buffer.byteLength(html, 'utf8') > OFFLINE_RECORD_BYTES_LIMIT || Buffer.byteLength(searchText, 'utf8') > OFFLINE_RECORD_BYTES_LIMIT)
    invalid('The page projection exceeds the offline size limit')
  const snapshotWithoutIntegrity: Omit<OfflinePageSnapshotV1, 'integrity'> = {
    schemaVersion: 1,
    pageId,
    locale: localeCode,
    path,
    canonicalPath,
    title,
    description: typeof description === 'string' ? description : '',
    sourceRevision,
    capturedAt: capturedAt.toISOString(),
    expiresAt: publicationEnd?.toISOString() ?? null,
    content: { representation: OFFLINE_CONTENT_TYPE, sanitizerVersion: OFFLINE_HTML_SANITIZER_VERSION, html },
    searchText,
    contentType: OFFLINE_CONTENT_TYPE
  }
  const result: OfflinePageSnapshotV1 = { ...snapshotWithoutIntegrity, integrity: integrityFor(snapshotWithoutIntegrity) }
  const parsed = OfflinePageSnapshotV1Schema.safeParse(result)
  if (parsed.success) {
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > OFFLINE_RECORD_BYTES_LIMIT) invalid('The page projection exceeds the offline size limit')
    return parsed.data
  }
  return invalid('The page projection is invalid')
}
