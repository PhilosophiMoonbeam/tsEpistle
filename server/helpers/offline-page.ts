import { createHash } from 'node:crypto'
import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'
import {
  OFFLINE_CONTENT_TYPE,
  OFFLINE_HTML_SANITIZER_VERSION,
  OFFLINE_RECORD_BYTES_LIMIT,
  OfflinePageSnapshotV1Schema,
  type OfflinePageSnapshotV1
} from '../../shared/offline.ts'
import { canReadPage, pageAuthorizationContext, pageRoute, type PagePrincipal, type PageVisibilityRecord } from './page-access.ts'
import type { PageRuleAuthority } from './group-access.ts'

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
const SAME_ORIGIN_BASE = 'https://offline.invalid/'

export class OfflinePageProjectionError extends Error {
  readonly status = 404
  readonly code = 'OFFLINE_PAGE_INELIGIBLE'

  constructor(message = 'This page is not available for offline use.') {
    super(message)
    this.name = 'OfflinePageProjectionError'
  }
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
  extra?: unknown
}

export interface OfflinePageSnapshotInput {
  page: unknown
  guest: PagePrincipal
  authority: PageRuleAuthority
  capturedAt?: Date
}

const invalid = (message: string): never => {
  throw new OfflinePageProjectionError(message)
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

const safeAnchorUrl = (value: string): boolean => {
  const hasControlCharacter = [...value].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
  if (value.length === 0 || value !== value.trim() || hasControlCharacter || value.includes('\\') || value.startsWith('//')) return false
  let url: URL
  try {
    url = new URL(value, SAME_ORIGIN_BASE)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return false
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const isRelative = !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    if (isRelative && url.origin !== SAME_ORIGIN_BASE.slice(0, -1)) return false
    if (url.origin === SAME_ORIGIN_BASE.slice(0, -1)) {
      const pathname = url.pathname.toLowerCase()
      if (
        pathname === '/_api' ||
        pathname.startsWith('/_api/') ||
        pathname === '/api' ||
        pathname.startsWith('/api/') ||
        pathname === '/_private' ||
        pathname.startsWith('/_private/') ||
        pathname === '/uploads' ||
        pathname.startsWith('/uploads/')
      )
        return false
    }
  }
  return true
}

const hasUnsafeProjectionMarkup = (fragment: string): boolean => {
  const template = createTemplate()
  template.innerHTML = fragment
  for (const element of template.content.querySelectorAll('*')) {
    const tagName = element.tagName.toLowerCase()
    if (ACTIVE_TAGS.has(tagName)) return true
    if (!ALLOWED_TAG_SET.has(tagName) && !PASSIVE_WRAPPER_TAGS.has(tagName)) return true
    if (tagName === 'a') {
      const href = element.getAttribute('href')
      if (href !== null && !safeAnchorUrl(href)) return true
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name.startsWith('data-') || ACTIVE_ATTRIBUTES.has(name)) return true
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

export const sanitizeOfflineHtmlFragment = (fragment: string): string => {
  if (typeof fragment !== 'string' || fragment.length > OFFLINE_RECORD_BYTES_LIMIT || hasUnsafeProjectionMarkup(fragment))
    invalid('The page contains unsupported active content')
  const sanitized = String(
    domPurify.sanitize(fragment, {
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
      if (!safeAnchorUrl(attribute.value)) invalid('The page projection contains an unsafe link')
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
    !input.guest ||
    !isRecord(authority) ||
    authority.requester !== input.guest ||
    !Array.isArray(authority.permissions) ||
    !authority.permissions.every(permission => typeof permission === 'string') ||
    !Array.isArray(authority.groups) ||
    !isRecord(authority.tagAliases)
  )
    invalid('Offline page authority is unavailable')
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

  if (page.visibility !== 'public') invalid('The page is not publicly readable')
  const accessPage: PageVisibilityRecord = { path, locale: localeCode, localeCode, visibility: 'public', ownerId: pageOwnerId, tags }
  if (pageAuthorizationContext(accessPage) === null || !canReadPage(input.guest, accessPage, input.authority)) invalid('The page is not publicly readable')
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
  const html = sanitizeOfflineHtmlFragment(render)
  const contentTemplate = createTemplate()
  contentTemplate.innerHTML = html
  const searchText = (contentTemplate.content.textContent ?? '').replace(/\s+/gu, ' ').trim()
  if (Buffer.byteLength(html, 'utf8') > OFFLINE_RECORD_BYTES_LIMIT || Buffer.byteLength(searchText, 'utf8') > OFFLINE_RECORD_BYTES_LIMIT)
    invalid('The page projection exceeds the offline size limit')
  const sourceRevision = canonicalSourceRevision(page.sourceRevision)
  const snapshotWithoutIntegrity: Omit<OfflinePageSnapshotV1, 'integrity'> = {
    schemaVersion: 1,
    pageId,
    locale: localeCode,
    path,
    canonicalPath: pageRoute({ visibility: 'public', localeCode, path }),
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
