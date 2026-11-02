import { load } from 'cheerio'
import { visibleQueryTerms } from '../../shared/search-query.ts'
import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'
import { wikiSourcePreviewLink, wikiSourcePreviewSanitizerPolicy } from '../../shared/wiki-source.ts'
import type { WikiSourcePreview } from '../../shared/wiki-source.ts'

const previewWindow = new jsdomModule.JSDOM('').window
const previewSanitizer = createDOMPurify(previewWindow)
const previewDocument = previewWindow.document
if (!previewDocument) throw new Error('Source preview requires a DOM document')

const renderedPlainText = (render: string): string => {
  const $ = load(render)
  $('script, style, template, noscript, [hidden], [aria-hidden="true"], a.toc-anchor').remove()
  $('p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, br, pre').before('\n').after('\n')
  return $.root()
    .text()
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const queryMatch = (text: string, query: string): RegExpExecArray | null => {
  const terms = visibleQueryTerms(query).slice(0, 12)
  return terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'iu').exec(text) : null
}

/** Inline search passages never fall back to the opening text of a nonmatching body. */
export const matchingSearchExcerpt = (render: string, query: string): { excerpt: string; excerptTruncated: boolean } | null => {
  const text = renderedPlainText(render).replace(/\s+/gu, ' ')
  const match = queryMatch(text, query)
  if (!match || match[0].length > 318) return null
  let start = Math.max(0, match.index - Math.min(80, 318 - match[0].length))
  if (start > 0) {
    const word = text.indexOf(' ', start)
    if (word >= start && word < match.index) start = word + 1
  }
  let end = Math.min(text.length, start + 318)
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start += 1
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1
  return {
    excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`,
    excerptTruncated: start > 0 || end < text.length
  }
}

/** Plain text only; callers must authorize the current page before invoking this helper. */
export const searchExcerpt = (render: string, query: string, limit = 2400): { excerpt: string; excerptTruncated: boolean } => {
  const text = renderedPlainText(render)
  const position = queryMatch(text, query)?.index
  let start = position === undefined ? 0 : Math.max(0, position - 160)
  if (start > 0) {
    const word = text.indexOf(' ', start)
    if (word >= start && word < start + 80) start = word + 1
  }
  const end = Math.min(text.length, start + Math.max(1, limit - 2))
  return { excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, excerptTruncated: start > 0 || end < text.length }
}

/** Authorized current-render projection only. Never affects the plain search producer. */
export const structuredSearchExcerpt = (render: string, query: string, pageHref: string): WikiSourcePreview['structuredExcerpt'] => {
  // Remove renderer-owned heading links before sanitization strips their class.
  const $ = load(render)
  $('a.toc-anchor').remove()
  const fragment = previewSanitizer.sanitize($.html(), { ...wikiSourcePreviewSanitizerPolicy, RETURN_DOM_FRAGMENT: true })
  fragment.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(node => {
    node.remove()
  })
  for (const element of fragment.querySelectorAll('*')) {
    element.removeAttribute('hidden')
    element.removeAttribute('aria-hidden')
    if ((element.getAttribute('title') ?? '').length > 512) element.removeAttribute('title')
    if (element.tagName === 'OL') {
      if (element.hasAttribute('start')) {
        if (/^[\t\n\f\r ]*[+-]?\d/u.test(element.getAttribute('start') ?? '')) element.setAttribute('start', String((element as HTMLOListElement).start))
        else element.removeAttribute('start')
      }
      if (element.hasAttribute('reversed')) element.setAttribute('reversed', '')
    } else {
      element.removeAttribute('start')
      element.removeAttribute('reversed')
    }
    if (element.tagName === 'LI' && /^[\t\n\f\r ]*[+-]?\d/u.test(element.getAttribute('value') ?? ''))
      element.setAttribute('value', String((element as HTMLLIElement).value))
    else element.removeAttribute('value')
    if (element.tagName === 'A') {
      const href = wikiSourcePreviewLink(element.getAttribute('href') ?? '', pageHref)
      if (href) element.setAttribute('href', href)
      else element.removeAttribute('href')
    } else element.removeAttribute('href')
    if (['TH', 'TD'].includes(element.tagName)) {
      const cell = element as HTMLTableCellElement
      if (cell.hasAttribute('colspan')) cell.setAttribute('colspan', String(cell.colSpan))
      if (cell.hasAttribute('rowspan')) {
        const row = cell.closest('tr')
        const rows = Array.from(row?.parentElement?.children ?? []).filter(child => child.tagName === 'TR')
        const remaining = row ? rows.length - rows.indexOf(row) : 1
        // HTML rowspan=0 reaches the end of its OWN row group. Larger positive
        // spans are likewise clipped by that boundary, never by a preview limit.
        const span = cell.rowSpan
        cell.setAttribute('rowspan', String(span === 0 ? remaining : Math.min(span, remaining)))
      }
    } else {
      element.removeAttribute('colspan')
      element.removeAttribute('rowspan')
      element.removeAttribute('headers')
      element.removeAttribute('scope')
    }
  }
  // Retain explicit complex-table associations without importing authored DOM ids.
  let headerId = 0
  for (const table of fragment.querySelectorAll('table')) {
    const ids = new Map<string, string>()
    for (const cell of table.querySelectorAll('th')) {
      const original = cell.getAttribute('id')
      const id = `source-preview-header-${headerId++}`
      if (original) ids.set(original, id)
      cell.setAttribute('id', id)
      const scope = cell.getAttribute('scope')?.toLowerCase() ?? ''
      if (['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) cell.setAttribute('scope', scope)
      else cell.removeAttribute('scope')
    }
    for (const cell of table.querySelectorAll('td, th')) {
      const headers = (cell.getAttribute('headers') ?? '')
        .split(/\s+/u)
        .map(id => ids.get(id))
        .filter(Boolean)
        .join(' ')
      if (headers) cell.setAttribute('headers', headers)
      else cell.removeAttribute('headers')
    }
  }
  fragment.querySelectorAll(':not(th)[id]').forEach(node => {
    node.removeAttribute('id')
  })

  const units: HTMLElement[] = []
  const collect = (parent: ParentNode): void => {
    let inline: HTMLElement | null = null
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 1 && /^(DIV|SECTION|ARTICLE|MAIN|FIGURE)$/u.test((node as Element).tagName)) {
        inline = null
        collect(node as Element)
      } else if (node.nodeType === 1 && /^(P|H[1-6]|UL|OL|DL|TABLE|BLOCKQUOTE|PRE|HR|FIGCAPTION)$/u.test((node as Element).tagName)) {
        inline = null
        units.push(node as HTMLElement)
      } else if ((node.textContent ?? '').trim() || (node as Element).tagName === 'BR') {
        if (!inline) {
          inline = previewDocument.createElement('p')
          units.push(inline)
        }
        inline.append(node.cloneNode(true))
      }
    }
  }
  collect(fragment)
  const fits = (element: HTMLElement): boolean =>
    element.outerHTML.length <= 24000 &&
    (element.textContent ?? '').length <= 6000 &&
    element.querySelectorAll('*').length <= 600 &&
    element.querySelectorAll('tr').length <= 40
  const selectedIndex = Math.max(
    0,
    units.findIndex(unit => queryMatch(unit.textContent ?? '', query))
  )
  let truncated = false
  const shrink = (original: HTMLElement): HTMLElement => {
    const element = original.cloneNode(true) as HTMLElement
    if (fits(element)) return element
    truncated = true
    if (element.tagName === 'TABLE' || element.tagName === 'UL' || element.tagName === 'OL' || element.tagName === 'DL') {
      const children =
        element.tagName === 'TABLE'
          ? Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element && !row.closest('thead'))
          : Array.from(element.children)
      // Rows connected by rowspan are indivisible; never shift a retained cell into another column.
      const groups: Element[][] = []
      for (let index = 0; index < children.length; ) {
        let end = index + 1
        for (let cursor = index; cursor < end && cursor < children.length; cursor++) {
          for (const cell of children[cursor]!.querySelectorAll('[rowspan]'))
            if (cell.closest('tr') === children[cursor] && cell.closest('table') === element)
              end = Math.min(children.length, Math.max(end, cursor + Number(cell.getAttribute('rowspan'))))
          if (element.tagName === 'DL' && children[cursor]?.tagName === 'DT') {
            while (end < children.length && children[end]?.tagName === 'DD') end++
          }
        }
        groups.push(children.slice(index, end))
        index = end
      }
      const ordinals = new Map<Element, number>()
      if (element.tagName === 'OL') {
        const items = children.filter(child => child.tagName === 'LI')
        const step = element.hasAttribute('reversed') ? -1 : 1
        let ordinal = element.hasAttribute('start') ? Number(element.getAttribute('start')) : step === -1 ? items.length : 1
        for (const item of items) {
          if (item.hasAttribute('value')) ordinal = Number(item.getAttribute('value'))
          ordinals.set(item, ordinal)
          ordinal += step
        }
      }
      const target = Math.max(
        0,
        groups.findIndex(group => group.some(child => queryMatch(child.textContent ?? '', query)))
      )
      let start = Math.max(0, target - 2)
      let end = Math.min(groups.length, target + 5)
      const candidate = (): HTMLElement => {
        const copy = element.cloneNode(true) as HTMLElement
        const retained = new Set(
          groups
            .slice(start, end)
            .flat()
            .map(child => children.indexOf(child))
        )
        const rows =
          element.tagName === 'TABLE'
            ? Array.from(copy.querySelectorAll('tr')).filter(row => row.closest('table') === copy && !row.closest('thead'))
            : Array.from(copy.children)
        rows.forEach((row, index) => {
          if (!retained.has(index)) row.remove()
        })
        if (copy.tagName === 'OL') {
          const first = groups
            .slice(start, end)
            .flat()
            .find(child => child.tagName === 'LI')
          const ordinal = first ? ordinals.get(first) : undefined
          // A reversed list's implicit start depends on its ORIGINAL item count,
          // even when only its suffix was omitted. Prefix resets also survive.
          if (ordinal !== undefined && ordinal >= -2147483648 && ordinal <= 2147483647) copy.setAttribute('start', String(ordinal))
          else copy.replaceChildren()
        }
        return copy
      }
      let copy = candidate()
      while (!fits(copy) && (start < target || end > target + 1)) {
        if (end > target + 1) end--
        else start++
        copy = candidate()
      }
      // An indivisible over-budget row/group is omitted, never cut across cells.
      if (!fits(copy)) copy.replaceChildren()
      return copy
    }
    if (element.querySelector('table, ul, ol, dl')) {
      const children = Array.from(element.children) as HTMLElement[]
      const selected = children.find(child => queryMatch(child.textContent ?? '', query)) ?? children[0]
      element.replaceChildren()
      if (selected) element.append(shrink(selected))
      if (!fits(element)) element.replaceChildren()
      return element
    }
    const text = element.textContent ?? ''
    const match = queryMatch(text, query)
    let start = Math.max(0, (match?.index ?? 0) - 160)
    let end = Math.min(text.length, start + 4600)
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start++
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
    const walker = previewDocument.createTreeWalker(element, previewWindow.NodeFilter.SHOW_TEXT)
    let offset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const length = node.data.length
      // Edit only text nodes, retaining every emphasis/link ancestor even when
      // both ends of the window fall inside the same inline element.
      node.data = node.data.slice(Math.max(0, start - offset), Math.max(0, end - offset))
      offset += length
    }
    for (const child of Array.from(element.querySelectorAll('*')).reverse())
      if (!child.textContent && !child.querySelector('br, hr') && !['BR', 'HR'].includes(child.tagName)) child.remove()
    // Extremely dense inline markup is also bounded; never ship an oversized DTO.
    if (!fits(element)) element.replaceChildren()
    return element
  }
  const selected = units[selectedIndex]
  const container = previewDocument.createElement('div')
  if (selected) container.append(shrink(selected))
  let start = selectedIndex
  let end = selectedIndex + 1
  // Add adjacent complete blocks, biased toward context after the matching passage.
  while (end < units.length) {
    const unit = units[end]!.cloneNode(true) as HTMLElement
    container.append(unit)
    if (!fits(container)) {
      unit.remove()
      break
    }
    end++
  }
  while (start > 0) {
    const unit = units[start - 1]!.cloneNode(true) as HTMLElement
    container.prepend(unit)
    if (!fits(container)) {
      unit.remove()
      break
    }
    start--
  }
  // Omitted over-budget content must not become a rendered empty shell.
  for (let index = container.children.length - 1; index >= 0; index--) {
    const block = container.children.item(index)!
    if (!block.textContent?.trim() && !block.matches('br, hr') && !block.querySelector('br, hr')) block.remove()
  }
  truncated ||= start > 0 || end < units.length
  // Drop references to headers omitted with an earlier row group.
  const retainedIds = new Set(Array.from(container.querySelectorAll('th[id]'), cell => cell.id))
  for (const cell of container.querySelectorAll('[headers]')) {
    const headers = (cell.getAttribute('headers') ?? '')
      .split(/\s+/u)
      .filter(id => retainedIds.has(id))
      .join(' ')
    if (headers) cell.setAttribute('headers', headers)
    else cell.removeAttribute('headers')
  }
  return { html: container.innerHTML, truncated }
}
