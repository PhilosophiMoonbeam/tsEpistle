import {
  OfflineHtmlFragmentV1Schema,
  OfflinePageSnapshotV1Schema,
  OFFLINE_CONTENT_TYPE,
  OFFLINE_HTML_SANITIZER_VERSION,
  type OfflinePageSnapshotV1
} from '../../shared/offline.ts'

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const MAX_RENDER_NODES = 10_000

const ALLOWED_ELEMENTS: Record<string, true> = {
  p: true,
  br: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  ul: true,
  ol: true,
  li: true,
  blockquote: true,
  pre: true,
  code: true,
  strong: true,
  em: true,
  del: true,
  s: true,
  mark: true,
  hr: true,
  dl: true,
  dt: true,
  dd: true,
  table: true,
  thead: true,
  tbody: true,
  tr: true,
  th: true,
  td: true,
  a: true
}

// These nodes are dropped with their descendants. They can execute, load, or
// establish DOM-clobbering behavior when moved out of the inert template.
const BLOCKED_ELEMENTS: Record<string, true> = {
  script: true,
  style: true,
  link: true,
  meta: true,
  base: true,
  iframe: true,
  frame: true,
  frameset: true,
  object: true,
  embed: true,
  applet: true,
  form: true,
  input: true,
  textarea: true,
  select: true,
  option: true,
  optgroup: true,
  button: true,
  fieldset: true,
  legend: true,
  output: true,
  video: true,
  audio: true,
  source: true,
  track: true,
  img: true,
  picture: true,
  canvas: true,
  svg: true,
  math: true,
  template: true,
  slot: true,
  portal: true,
  dialog: true,
  details: true,
  marquee: true,
  object3d: true
}

export type OfflineRenderErrorCode = 'invalid-record' | 'integrity' | 'unsafe-fragment' | 'unavailable'

export class OfflineRenderError extends Error {
  readonly code: OfflineRenderErrorCode
  readonly cause: unknown

  constructor(code: OfflineRenderErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'OfflineRenderError'
    this.code = code
    this.cause = cause
  }
}

export type OfflineRenderAudit = {
  nodeCount: number
  linkCount: number
}

const renderedNavigationListeners = new WeakMap<HTMLElement, (event: Event) => void>()

const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

const canonicalIntegrityPayload = (snapshot: OfflinePageSnapshotV1): string =>
  JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    pageId: snapshot.pageId,
    locale: snapshot.locale,
    path: snapshot.path,
    canonicalPath: snapshot.canonicalPath,
    title: snapshot.title,
    description: snapshot.description,
    sourceRevision: snapshot.sourceRevision,
    capturedAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
    content: {
      representation: snapshot.content.representation,
      sanitizerVersion: snapshot.content.sanitizerVersion,
      html: snapshot.content.html
    },
    searchText: snapshot.searchText,
    contentType: snapshot.contentType
  })

const equalIntegrity = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

export const offlineSnapshotIntegrity = async (snapshot: OfflinePageSnapshotV1): Promise<string> => {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.subtle) throw new OfflineRenderError('unavailable', 'This browser cannot verify offline page integrity.')
  try {
    const encoded = new TextEncoder().encode(`tsepistle/offline-snapshot-v1\u0000${canonicalIntegrityPayload(snapshot)}`)
    const digest = await cryptoApi.subtle.digest('SHA-256', encoded)
    return bytesToHex(new Uint8Array(digest))
  } catch (error) {
    throw new OfflineRenderError('unavailable', 'Offline page integrity could not be verified.', error)
  }
}

const validateSnapshot = (value: unknown): OfflinePageSnapshotV1 => {
  const parsed = OfflinePageSnapshotV1Schema.safeParse(value)
  if (!parsed.success) throw new OfflineRenderError('invalid-record', 'The selected offline page record is invalid.')
  if (parsed.data.contentType !== OFFLINE_CONTENT_TYPE) throw new OfflineRenderError('invalid-record', 'The selected offline page content type is invalid.')
  if (parsed.data.content.sanitizerVersion !== OFFLINE_HTML_SANITIZER_VERSION)
    throw new OfflineRenderError('unsafe-fragment', 'This offline page uses an unsupported sanitizer version.')
  const fragment = OfflineHtmlFragmentV1Schema.safeParse(parsed.data.content)
  if (!fragment.success) throw new OfflineRenderError('unsafe-fragment', 'The selected offline page fragment is invalid.')
  if (!/^[a-f0-9]{64}$/u.test(parsed.data.integrity)) throw new OfflineRenderError('integrity', 'The selected offline page integrity marker is invalid.')
  return parsed.data
}

const safeHref = (value: string): string | null => {
  const candidate = value.trim()
  if (
    !candidate ||
    candidate !== value ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    [...candidate].some(character => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
    })
  )
    return null
  try {
    const base = typeof window !== 'undefined' && window.location?.href ? window.location.href : 'https://offline.invalid/'
    const url = new URL(candidate, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
    if (url.username || url.password) return null
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const pathname = url.pathname.toLowerCase()
      if (
        url.origin === new URL(base).origin &&
        (pathname === '/_api' ||
          pathname.startsWith('/_api/') ||
          pathname === '/api' ||
          pathname.startsWith('/api/') ||
          pathname === '/_private' ||
          pathname.startsWith('/_private/') ||
          pathname === '/uploads' ||
          pathname.startsWith('/uploads/'))
      )
        return null
    }
    // Preserve relative links so an offline page remains rooted at this origin.
    if (!/^[a-z][a-z\d+.-]*:/iu.test(candidate)) return candidate
    return url.href
  } catch {
    return null
  }
}

type CopyContext = {
  nodeCount: number
  linkCount: number
}

const copyChildren = (source: Node, context: CopyContext): Node[] => {
  const copied: Node[] = []
  for (const child of source.childNodes) copied.push(...copyNode(child, context))
  return copied
}

const copyNode = (source: Node, context: CopyContext): Node[] => {
  if (source.nodeType === Node.TEXT_NODE) {
    context.nodeCount += 1
    if (context.nodeCount > MAX_RENDER_NODES) throw new OfflineRenderError('unsafe-fragment', 'The offline page contains too many nodes.')
    return [document.createTextNode(source.nodeValue ?? '')]
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return []
  const element = source as Element
  const tagName = element.localName.toLowerCase()
  if (element.namespaceURI !== XHTML_NAMESPACE || BLOCKED_ELEMENTS[tagName]) return []
  if (!ALLOWED_ELEMENTS[tagName]) return copyChildren(element, context)

  context.nodeCount += 1
  if (context.nodeCount > MAX_RENDER_NODES) throw new OfflineRenderError('unsafe-fragment', 'The offline page contains too many nodes.')
  const target = document.createElement(tagName)
  if (tagName === 'a') {
    const href = element.getAttribute('href')
    const validHref = href === null ? null : safeHref(href)
    if (validHref !== null) {
      target.setAttribute('href', validHref)
      context.linkCount += 1
    }
  }
  for (const child of copyChildren(element, context)) target.appendChild(child)
  return [target]
}

const installSafeNavigation = (target: HTMLElement): void => {
  const previous = renderedNavigationListeners.get(target)
  if (previous) target.removeEventListener('click', previous)
  const listener = (event: Event): void => {
    if (event.defaultPrevented || typeof window === 'undefined') return
    const source = event.target
    if (!(source instanceof Element)) return
    const anchor = source.closest('a')
    if (!(anchor instanceof HTMLAnchorElement) || !target.contains(anchor)) return
    const href = anchor.getAttribute('href')
    const validHref = href === null ? null : safeHref(href)
    if (validHref === null) {
      event.preventDefault()
      return
    }
    const mouse = event as MouseEvent
    if (mouse.button !== 0 || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey) return
    event.preventDefault()
    window.location.assign(validHref)
  }
  renderedNavigationListeners.set(target, listener)
  target.addEventListener('click', listener)
}

/**
 * Verify and insert one guest snapshot's already-sanitized fragment. This is
 * the only helper allowed to move offline HTML into the live document.
 */
export const renderOfflineHtmlFragment = async (target: HTMLElement, value: unknown): Promise<OfflineRenderAudit> => {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement))
    throw new OfflineRenderError('invalid-record', 'The offline content target is unavailable.')
  const snapshot = validateSnapshot(value)
  const expectedIntegrity = await offlineSnapshotIntegrity(snapshot)
  if (!equalIntegrity(expectedIntegrity, snapshot.integrity)) throw new OfflineRenderError('integrity', 'The offline page integrity check failed.')

  const template = document.createElement('template')
  // This is the sole controlled HTML sink. The parsed nodes never enter the
  // live document; copyNode below creates a strict passive allowlist tree.
  template.innerHTML = snapshot.content.html
  const context: CopyContext = { nodeCount: 0, linkCount: 0 }
  const fragment = document.createDocumentFragment()
  for (const child of copyChildren(template.content, context)) fragment.appendChild(child)
  target.replaceChildren(fragment)
  installSafeNavigation(target)
  return { nodeCount: context.nodeCount, linkCount: context.linkCount }
}
