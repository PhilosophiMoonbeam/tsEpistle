import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderYoutubeContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'youtube') throw new TypeError('YouTube renderer received another content extension type.')
  const id = escapeHtml(envelope.props.videoId)
  const title = escapeHtml(envelope.props.title ?? 'YouTube video')
  const start = envelope.props.start ?? 0
  const fallbackUrl = `https://www.youtube.com/watch?v=${id}${start > 0 ? `&amp;t=${start}s` : ''}`
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--youtube" aria-label="${title}" ` +
      `data-youtube-id="${id}" data-youtube-start="${start}" data-youtube-controls="${envelope.props.controls === false ? 'false' : 'true'}" data-youtube-title="${title}">` +
      `<div class="content-extension-remote__consent">` +
        `<p>Loading this player connects to YouTube. No request is made until you continue.</p>` +
        `<button class="content-extension-remote__load" type="button">Load YouTube player</button>` +
      `</div>` +
      `<figcaption class="content-extension-remote__fallback"><a href="${fallbackUrl}" rel="noopener noreferrer">Open ${title} on YouTube</a></figcaption>` +
    `</figure>`
  )
}
