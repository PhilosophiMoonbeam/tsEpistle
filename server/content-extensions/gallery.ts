import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

export const renderGalleryContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'gallery') throw new TypeError('Gallery renderer received another content extension type.')
  const columns = envelope.props.columns ?? 3
  const fit = envelope.props.fit ?? 'cover'
  const aspectRatio = envelope.props.aspectRatio ?? 'square'
  const items = envelope.props.images.map(image => {
    const src = escapeHtml(image.src)
    const alt = escapeHtml(image.alt)
    const caption = image.caption === undefined
      ? ''
      : `<figcaption class="content-extension-gallery__caption">${escapeHtml(image.caption)}</figcaption>`
    return `<li class="content-extension-gallery__item">` +
      `<figure class="content-extension-gallery__figure">` +
        `<a class="content-extension-gallery__link" href="${src}" title="Enlarge image" aria-label="View ${alt} full size">` +
          `<img class="content-extension-gallery__image" src="${src}" alt="${alt}" loading="lazy" decoding="async">` +
        `</a>` + caption +
      `</figure>` +
    `</li>`
  }).join('')

  return sanitizeContentExtensionFragment(
    `<section class="content-extension content-extension--gallery content-extension-gallery--columns-${columns} content-extension-gallery--${fit} content-extension-gallery--${aspectRatio}" aria-label="Image gallery">` +
      `<ul class="content-extension-gallery__list" role="list">${items}</ul>` +
    `</section>`
  )
}
