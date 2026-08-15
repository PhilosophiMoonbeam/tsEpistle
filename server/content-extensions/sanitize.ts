import { isSafeContentExtensionAssetPath } from '../../shared/content-extensions.ts'

import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'

const { JSDOM } = jsdomModule
const window = new JSDOM('').window
const sanitizer = createDOMPurify(window)
const document = window.document
if (!document) throw new TypeError('Content extension sanitizer document is unavailable.')
const validationTemplate = document.createElement('template')
const CLICKABLE_PROTOCOLS: Record<string, true> = { 'http:': true, 'https:': true, 'mailto:': true, 'tel:': true }
const ALLOWED_TAGS = new Set([
  'a',
  'figcaption',
  'figure',
  'img',
  'li',
  'p',
  'path',
  'section',
  'span',
  'svg',
  'title',
  'ul'
])
const ALLOWED_ATTRIBUTES = new Set([
  'alt',
  'aria-busy',
  'aria-label',
  'aria-live',
  'class',
  'd',
  'data-index-columns',
  'data-index-depth',
  'data-index-empty-label',
  'data-index-limit',
  'data-index-locale',
  'data-index-order',
  'data-index-path',
  'data-index-show-icons',
  'decoding',
  'fill',
  'height',
  'href',
  'loading',
  'rel',
  'role',
  'shape-rendering',
  'src',
  'stroke',
  'title',
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
  if (data.attrName === 'href' && !isSafeContentExtensionLink(data.attrValue) && !isSafeContentExtensionAssetPath(data.attrValue)) {
    data.keepAttr = false
  }
  if (data.attrName === 'src' && !isSafeContentExtensionAssetPath(data.attrValue)) data.keepAttr = false
})

export const sanitizeContentExtensionFragment = (fragment: string): string => {
  const sanitized = sanitizer.sanitize(fragment, {
    ADD_ATTR: ['aria-busy', 'aria-label', 'aria-live', 'role'],
    ALLOW_DATA_ATTR: true,
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['dialog', 'foreignObject', 'iframe', 'image', 'script', 'style', 'use']
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
