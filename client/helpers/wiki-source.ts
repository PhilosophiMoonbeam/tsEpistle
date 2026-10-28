import DOMPurify from 'dompurify'
import { WikiSourceSchema, WikiSourcePreviewSchema, wikiSourceHref, wikiSourcePreviewLink, wikiSourcePreviewSanitizerPolicy, type WikiSource, type WikiSourcePreview, type WikiSourceSelector } from '../../shared/wiki-source.ts'
import { createSearchHighlighter } from './search-highlight.ts'

export class WikiSourceLoadError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export const fetchWikiSourcePreview = async (selector: WikiSourceSelector, query: string, signal?: AbortSignal): Promise<WikiSourcePreview> => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(selector)) params.set(key, String(value))
  if (query.trim()) params.set('query', query.slice(0, 256))
  const response = await window.fetch(`/_api/pages/preview?${params}`, { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok) throw new WikiSourceLoadError(response.status, response.status === 403 ? 'Open this page to unlock it before previewing.' : response.status === 404 ? 'This source is no longer available to you.' : 'The source could not be loaded. Try again.')
  return WikiSourcePreviewSchema.parse(await response.json())
}

/** Agent/citation consumers deliberately receive only the canonical plain source. */
export const fetchWikiSource = async (selector: WikiSourceSelector, query: string, signal?: AbortSignal): Promise<WikiSource> =>
  WikiSourceSchema.parse(await fetchWikiSourcePreview(selector, query, signal))

export const renderWikiSourcePreview = (source: WikiSourcePreview, query: string, idPrefix: string, tableLabel: string): { html: string; matched: boolean } => {
  // Sanitize before any authored content enters even an inert browser DOM.
  const fragment = DOMPurify.sanitize(source.structuredExcerpt.html, { ...wikiSourcePreviewSanitizerPolicy, RETURN_DOM_FRAGMENT: true })
  fragment.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(node => node.remove())
  const ids = new Map<string, string>()
  for (const header of fragment.querySelectorAll('th[id]')) {
    const original = header.id
    const id = `${idPrefix}-header-${ids.size}`
    ids.set(original, id)
    header.id = id
  }
  for (const element of fragment.querySelectorAll('*')) {
    element.removeAttribute('hidden')
    element.removeAttribute('aria-hidden')
    if (element.tagName !== 'TH') element.removeAttribute('id')
    if (element.tagName === 'A') {
      const href = wikiSourcePreviewLink(element.getAttribute('href') ?? '', wikiSourceHref(source))
      if (href) {
        element.setAttribute('href', href)
        element.setAttribute('target', '_blank')
        element.setAttribute('rel', 'noopener noreferrer')
      } else element.removeAttribute('href')
    } else element.removeAttribute('href')
    const headers = (element.getAttribute('headers') ?? '').split(/\s+/u).map(id => ids.get(id)).filter(Boolean).join(' ')
    if (headers) element.setAttribute('headers', headers)
    else element.removeAttribute('headers')
  }
  const highlight = createSearchHighlighter(query)
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
  const groups = new Map<Node, Text[]>()
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    // Inline emphasis may split a phrase, but table cells and prose blocks never share a match.
    const block = node.parentElement?.closest('p, li, dt, dd, th, td, caption, pre, h1, h2, h3, h4, h5, h6, blockquote') ?? fragment
    const nodes = groups.get(block)
    if (nodes) nodes.push(node)
    else groups.set(block, [node])
  }
  let matched = false
  for (const nodes of groups.values()) {
    const parts = highlight(nodes.map(node => node.data).join(''))
    const ranges: { start: number; end: number }[] = []
    let offset = 0
    for (const part of parts) {
      if (part.matched) ranges.push({ start: offset, end: offset + part.text.length })
      offset += part.text.length
    }
    if (!ranges.length) continue
    matched = true
    offset = 0
    for (const node of nodes) {
      const replacement = document.createDocumentFragment()
      const length = node.data.length
      let cursor = 0
      for (const range of ranges) {
        const start = Math.max(0, range.start - offset)
        const end = Math.min(length, range.end - offset)
        if (end <= start) continue
        replacement.append(document.createTextNode(node.data.slice(cursor, start)))
        const mark = document.createElement('mark')
        mark.textContent = node.data.slice(start, end)
        replacement.append(mark)
        cursor = end
      }
      replacement.append(document.createTextNode(node.data.slice(cursor)))
      node.replaceWith(replacement)
      offset += length
    }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const scroller = document.createElement('div')
    scroller.className = 'wiki-source-preview__table-scroll'
    scroller.tabIndex = 0
    scroller.setAttribute('role', 'region')
    scroller.setAttribute('aria-label', tableLabel)
    table.before(scroller)
    scroller.append(table)
  }
  const container = document.createElement('div')
  container.append(fragment)
  return { html: container.textContent?.trim() ? container.innerHTML : '', matched }
}
