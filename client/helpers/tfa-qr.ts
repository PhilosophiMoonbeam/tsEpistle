import DOMPurify from 'dompurify'

export const sanitizeTfaQrImage = (svg: string): string => {
  const sanitized = DOMPurify.sanitize(svg, {
    ALLOWED_TAGS: ['svg', 'path'],
    ALLOWED_ATTR: ['xmlns', 'viewBox', 'd'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false
  })
  if (!sanitized) return ''

  const parsed = new DOMParser().parseFromString(sanitized, 'image/svg+xml')
  const root = parsed.documentElement
  const path = root.firstElementChild
  const viewBox = root.getAttribute('viewBox')?.match(/^0 0 ([1-9]\d*) ([1-9]\d*)$/)
  if (
    root.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    root.childNodes.length !== 1 ||
    path?.localName !== 'path' ||
    path.namespaceURI !== root.namespaceURI ||
    !path.getAttribute('d') ||
    !viewBox ||
    viewBox[1] !== viewBox[2]
  ) {
    return ''
  }

  return sanitized
}
