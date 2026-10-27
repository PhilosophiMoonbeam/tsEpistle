import { load } from 'cheerio'
import { visibleQueryTerms } from '../../shared/search-query.ts'

const renderedPlainText = (render: string): string => {
  const $ = load(render)
  $('script, style, template, noscript, [hidden], [aria-hidden="true"], a.toc-anchor').remove()
  $('p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, br, pre').before('\n').after('\n')
  return $.root().text().replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const queryMatch = (text: string, query: string): RegExpExecArray | null => {
  const terms = visibleQueryTerms(query).slice(0, 12)
  return terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'iu').exec(text) : null
}

/** Inline search passages never fall back to the opening text of a nonmatching body. */
export const matchingSearchExcerpt = (render: string, query: string): string | null => {
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
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
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
