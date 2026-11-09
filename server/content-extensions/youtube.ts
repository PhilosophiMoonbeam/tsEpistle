import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderYoutubeContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'youtube') throw new TypeError('YouTube renderer received another content extension type.')
  const source = envelope.version === 1
    ? { kind: 'video' as const, videoId: envelope.props.videoId }
    : envelope.props.source
  const videoId = source.kind === 'playlist' ? undefined : source.videoId
  const playlistId = source.kind === 'video' ? undefined : source.playlistId
  const title = escapeHtml(envelope.props.title?.trim() || (videoId ? 'YouTube video' : 'YouTube playlist'))
  const start = envelope.props.start ?? 0
  const query = new URLSearchParams()
  if (videoId) query.set('v', videoId)
  if (playlistId) query.set('list', playlistId)
  if (start > 0) query.set('t', `${start}s`)
  const fallbackUrl = escapeHtml(`https://www.youtube.com/${videoId ? 'watch' : 'playlist'}?${query}`)
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--youtube" aria-label="${title}" ` +
      `${videoId === undefined ? '' : `data-youtube-id="${escapeHtml(videoId)}" `}` +
      `${playlistId === undefined ? '' : `data-youtube-playlist-id="${escapeHtml(playlistId)}" data-youtube-version="2" data-youtube-source-kind="${source.kind}" `}` +
      `data-youtube-start="${start}" data-youtube-controls="${envelope.props.controls === false ? 'false' : 'true'}" data-youtube-title="${title}">` +
      `<div class="content-extension-remote__consent">` +
        `<p>Loading this player connects to YouTube. No request is made until you continue.</p>` +
        `<button class="content-extension-remote__load" type="button">Load YouTube player</button>` +
      `</div>` +
      `<figcaption class="content-extension-remote__fallback"><a href="${fallbackUrl}" rel="noopener noreferrer">Open ${title} on YouTube</a></figcaption>` +
    `</figure>`
  )
}
