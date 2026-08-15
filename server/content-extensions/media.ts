import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderMediaContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'media') throw new TypeError('Media renderer received another content extension type.')
  const src = escapeHtml(envelope.props.src)
  const title = escapeHtml(envelope.props.title ?? (envelope.props.kind === 'audio' ? 'Audio player' : 'Video player'))
  const poster = envelope.props.poster === undefined ? '' : ` poster="${escapeHtml(envelope.props.poster)}"`
  const player = envelope.props.kind === 'audio'
    ? `<audio class="content-extension-media__player" controls preload="metadata" aria-label="${title}" src="${src}"></audio>`
    : `<video class="content-extension-media__player" controls preload="metadata" playsinline aria-label="${title}" src="${src}"${poster}></video>`
  const caption = envelope.props.caption === undefined
    ? ''
    : `<figcaption class="content-extension-media__caption">${escapeHtml(envelope.props.caption)}</figcaption>`
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--media content-extension-media--${envelope.props.kind}">` +
      player + caption +
      `<p class="content-extension-media__fallback"><a href="${src}">${title} — open media file</a></p>` +
    `</figure>`
  )
}
