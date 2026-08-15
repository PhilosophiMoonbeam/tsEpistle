import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'

const { JSDOM } = jsdomModule
const window = new JSDOM('').window
const sanitizer = createDOMPurify(window)
const document = window.document
if (!document) throw new TypeError('Content extension sanitizer document is unavailable.')
const validationTemplate = document.createElement('template')
const CLICKABLE_PROTOCOLS: Record<string, true> = { 'http:': true, 'https:': true, 'mailto:': true, 'tel:': true }
const ALLOWED_TAGS = new Set(['a', 'figcaption', 'figure', 'path', 'span', 'svg', 'title'])
const ALLOWED_ATTRIBUTES = new Set([
  'aria-label',
  'class',
  'd',
  'fill',
  'height',
  'href',
  'rel',
  'role',
  'shape-rendering',
  'stroke',
  'viewBox',
  'width',
  'xmlns'
])

export const isSafeContentExtensionLink = (value: string): boolean => {
  if (value !== value.trim()) return false
  try {
    const url = new URL(value)
    return CLICKABLE_PROTOCOLS[url.protocol] === true
  } catch {
    return false
  }
}

sanitizer.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'href' && !isSafeContentExtensionLink(data.attrValue)) data.keepAttr = false
})

export const sanitizeContentExtensionFragment = (fragment: string): string => {
  const sanitized = sanitizer.sanitize(fragment, {
    ADD_ATTR: ['aria-label', 'role'],
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['foreignObject', 'iframe', 'image', 'script', 'style', 'use']
  })
  validationTemplate.innerHTML = sanitized
  for (const element of validationTemplate.content.querySelectorAll('*')) {
    if (!ALLOWED_TAGS.has(element.tagName.toLowerCase())) {
      throw new TypeError(`Content extension renderer emitted forbidden element ${element.tagName}.`)
    }
    for (const attribute of element.attributes) {
      if (!ALLOWED_ATTRIBUTES.has(attribute.name)) {
        throw new TypeError(`Content extension renderer emitted forbidden attribute ${attribute.name}.`)
      }
    }
  }
  return validationTemplate.innerHTML
}
