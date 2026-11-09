import { load } from 'cheerio'
import moment from 'moment-timezone'
import type { PageIndexItem } from '../operations/pages.ts'
import { isSafeContentExtensionLink } from '../content-extensions/sanitize.ts'
import { normalizeUserPresentationDefaults } from '../../shared/user-presentation.ts'

import { escapeHtml as escapeText } from '../content-extensions/html.ts'
const tags = new Set('p div span section article aside header footer h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote pre code strong em b i u s del ins sub sup br hr table thead tbody tfoot tr th td caption a figure figcaption details summary time'.split(' '))
const safeHref = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 32 || code === 92) return false
  }
  return !/%(?:0[0-9a-f]|1[0-9a-f]|5c)/iu.test(value) &&
    (value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//')) || isSafeContentExtensionLink(value))
}

/** A passive projection of the admitted stored render, never a source renderer or cache. */
export const projectPassivePage = async (input: {
  render: string
  sourceRevision: string | number | bigint
  locale: string
  presentation?: unknown
  listIndex(args: { path: string; locale: string; depth: number; limit: number; order: string }): Promise<PageIndexItem[]>
}): Promise<string> => {
  if (Buffer.byteLength(input.render, 'utf8') > 2 * 1024 * 1024) return '<p>Page content is too large for the passive reader.</p>'
  const $ = load(input.render, {}, false)
  if ($('*').length > 25000) return '<p>Page content is too large for the passive reader.</p>'
  $('script,style,iframe,object,embed,template,noscript,svg,math,form,input,button,select,textarea,link,meta,base,audio,video,source,img').remove()
  const indexes = $('.content-extension--index').toArray()
  let remaining = 400
  for (const [position, node] of indexes.entries()) {
    const section = $(node)
    const emptyLabel = section.attr('data-index-empty-label') || 'No pages are available in this section.'
    try {
      if (position >= 8 || remaining <= 0) throw new Error('Passive index budget exceeded')
      const path = section.attr('data-index-path') ?? ''
      const locale = section.attr('data-index-locale') ?? input.locale
      const depth = Number(section.attr('data-index-depth') ?? 0)
      const limit = Math.min(Number(section.attr('data-index-limit') ?? 50), remaining)
      const order = section.attr('data-index-order') ?? 'path'
      if (path.length > 512 || locale.length > 30 || !Number.isInteger(depth) || depth < 0 || depth > 5 || !Number.isInteger(limit) || limit < 1 || limit > 200 || !['path', 'title', 'updated'].includes(order)) throw new Error('Invalid index')
      remaining -= limit
      const items = await input.listIndex({ path, locale, depth, limit, order })
      const showUpdatedAt = section.attr('data-index-show-updated-at') === 'true'
      const presentation = normalizeUserPresentationDefaults(input.presentation)
      const rows = items.slice(0, limit).map(item => {
        if (!item.href.startsWith('/') || item.href.startsWith('//') || !safeHref(item.href)) throw new Error('Invalid index route')
        let updated = ''
        if (showUpdatedAt) {
          const date = moment.parseZone(item.updatedAt, moment.ISO_8601, true).locale(input.locale).tz(presentation.timezone)
          if (!date.isValid() || !/[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/u.test(item.updatedAt)) updated = '<span>Update time unavailable</span>'
          else {
            const dateFormat = presentation.dateFormat || date.localeData().longDateFormat('L')
            const timeFormat = presentation.timeFormat === '12h' ? 'h:mm A' : presentation.timeFormat === '24h' ? 'HH:mm' : date.localeData().longDateFormat('LT')
            updated = `<time datetime="${escapeText(date.toISOString())}">${escapeText(date.format(`${dateFormat} ${timeFormat}`))}</time>`
          }
        }
        return `<li><a href="${escapeText(item.href)}">${escapeText(item.title)}</a>${item.description ? `<p>${escapeText(item.description)}</p>` : ''}${updated}</li>`
      }).join('')
      section.html(rows ? `<ul>${rows}</ul>` : `<p>${escapeText(emptyLabel)}</p>`)
    } catch {
      section.html('<p>Page index is unavailable.</p>')
    }
  }
  $('*').each((_index, node) => {
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return
    const element = $(node)
    if (!tags.has(node.tagName)) { element.replaceWith(element.contents()); return }
    for (const name of Object.keys(node.attribs)) {
      const value = node.attribs[name] ?? ''
      if (name === 'href' && node.tagName === 'a' && safeHref(value)) continue
      if (name === 'datetime' && node.tagName === 'time') continue
      if (['colspan', 'rowspan'].includes(name) && /^(?:[1-9]|[1-9]\d|100)$/u.test(value)) continue
      element.removeAttr(name)
    }
  })
  return $.html()
}
