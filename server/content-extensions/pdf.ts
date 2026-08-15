import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderPdfContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'pdf') throw new TypeError('PDF renderer received another content extension type.')
  const src = escapeHtml(envelope.props.src)
  const title = escapeHtml(envelope.props.title ?? 'PDF document')
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--pdf" aria-label="${title}" ` +
      `data-pdf-src="${src}" data-pdf-page="${envelope.props.page ?? 1}" data-pdf-height="${envelope.props.height ?? 720}" data-pdf-title="${title}">` +
      `<div class="content-extension-pdf__viewer" aria-live="polite"></div>` +
      `<figcaption class="content-extension-pdf__fallback">` +
        `<a href="${src}">${title} — open or download PDF</a>` +
      `</figcaption>` +
    `</figure>`
  )
}
