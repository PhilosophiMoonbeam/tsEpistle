import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { isSafeContentExtensionLink, sanitizeContentExtensionFragment } from './sanitize.ts'
import { escapeHtml } from './html.ts'

const renderFactValue = (value: string | boolean): string => {
  if (typeof value === 'boolean') {
    return `<span class="content-extension-infobox__boolean content-extension-infobox__boolean--${value ? 'yes' : 'no'}" aria-label="${value ? 'Yes' : 'No'}">${value ? 'Yes' : 'No'}</span>`
  }
  const escaped = escapeHtml(value)
  return isSafeContentExtensionLink(value) && !value.includes(' ')
    ? `<a href="${escaped}" rel="noopener noreferrer">${escaped}</a>`
    : escaped
}

export const renderInfoboxContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'infobox') throw new TypeError('Infobox renderer received another content extension type.')
  const image = envelope.props.image === undefined
    ? ''
    : `<figure class="content-extension-infobox__figure">` +
        `<img class="content-extension-infobox__image" src="${escapeHtml(envelope.props.image)}" alt="${escapeHtml(envelope.props.imageAlt ?? '')}" loading="lazy" decoding="async">` +
        (envelope.props.caption === undefined ? '' : `<figcaption>${escapeHtml(envelope.props.caption)}</figcaption>`) +
      `</figure>`
  const facts = envelope.props.facts.map(fact =>
    `<dt>${escapeHtml(fact.label)}</dt><dd>${renderFactValue(fact.value)}</dd>`
  ).join('')
  return sanitizeContentExtensionFragment(
    `<aside class="content-extension content-extension--infobox" aria-label="${escapeHtml(envelope.props.title)}">` +
      `<div class="content-extension-infobox__title">${escapeHtml(envelope.props.title)}</div>` +
      image +
      `<dl class="content-extension-infobox__facts">${facts}</dl>` +
    `</aside>`
  )
}
