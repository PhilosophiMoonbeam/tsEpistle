import { load } from 'cheerio'
import { visibleQueryTerms } from '../../shared/search-query.ts'

/** Plain text only; callers must authorize the current page before invoking this helper. */
export const searchExcerpt = (render: string, query: string, limit = 2400): { excerpt: string; excerptTruncated: boolean } => {
  const $ = load(render)
  $('script, style, template, noscript, [hidden], [aria-hidden="true"], a.toc-anchor').remove()
  $('p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, br, pre').before('\n').after('\n')
  const text = $.root().text().replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const terms = visibleQueryTerms(query).slice(0, 12)
  const pattern = terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'giu') : null
  const position = pattern?.exec(text)?.index
  let start = position === undefined ? 0 : Math.max(0, position - 160)
  if (start > 0) {
    const word = text.indexOf(' ', start)
    if (word >= start && word < start + 80) start = word + 1
  }
  const end = Math.min(text.length, start + Math.max(1, limit - 2))
  return { excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, excerptTruncated: start > 0 || end < text.length }
}
