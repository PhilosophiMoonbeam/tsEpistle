import { LINKS_GRID_ICONS, parseContentExtensionEnvelope, type ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderLinksGridContentExtension = async (input: ContentExtensionEnvelope): Promise<string> => {
  const envelope = parseContentExtensionEnvelope(input)
  if (envelope.key !== 'links-grid') throw new TypeError('Links grid renderer received another content extension type.')
  const cards = envelope.props.cards
    .map(card => {
      const image =
        card.image === undefined
          ? ''
          : `<img class="content-extension-links-grid__image" src="${escapeHtml(card.image)}" alt="" loading="lazy" decoding="async">`
      const icon =
        card.icon === undefined
          ? ''
          : `<img class="content-extension-links-grid__icon" src="${LINKS_GRID_ICONS[card.icon]}" alt="" loading="lazy" decoding="async" width="32" height="32">`
      const description = card.description === undefined ? '' : `<span class="content-extension-links-grid__description">${escapeHtml(card.description)}</span>`
      const tags = card.tags?.length
        ? `<span class="content-extension-links-grid__tags">${card.tags.map(tag => `<span class="content-extension-links-grid__tag">${escapeHtml(tag)}</span>`).join(' ')}</span>`
        : ''
      return (
        `<li class="content-extension-links-grid__item">` +
        `<a class="content-extension-links-grid__link" href="${escapeHtml(card.url)}" aria-label="${escapeHtml(card.title)}">` +
        image +
        `<span class="content-extension-links-grid__body">` +
        icon +
        `<span class="content-extension-links-grid__title">${escapeHtml(card.title)}</span>` +
        description +
        tags +
        `</span>` +
        `</a>` +
        `</li>`
      )
    })
    .join('')
  return sanitizeContentExtensionFragment(
    `<section class="content-extension content-extension--links-grid" aria-label="Links grid">` +
      `<ul class="content-extension-links-grid__list" role="list">${cards}</ul>` +
      `</section>`
  )
}
