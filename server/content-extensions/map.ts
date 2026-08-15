import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderMapContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'map') throw new TypeError('Map renderer received another content extension type.')
  const { latitude, longitude } = envelope.props
  const zoom = envelope.props.zoom ?? 13
  const height = envelope.props.height ?? 400
  const label = escapeHtml(envelope.props.label ?? `Map at ${latitude}, ${longitude}`)
  const fallbackUrl = `https://www.openstreetmap.org/?mlat=${latitude}&amp;mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--map" aria-label="${label}" ` +
      `data-map-latitude="${latitude}" data-map-longitude="${longitude}" data-map-zoom="${zoom}" data-map-height="${height}" data-map-label="${label}">` +
      `<div class="content-extension-remote__consent">` +
        `<p>Loading this map connects to OpenStreetMap. No request is made until you continue.</p>` +
        `<button class="content-extension-remote__load" type="button">Load OpenStreetMap</button>` +
      `</div>` +
      `<figcaption class="content-extension-remote__fallback"><a href="${fallbackUrl}" rel="noopener noreferrer">Open ${label} on OpenStreetMap</a></figcaption>` +
    `</figure>`
  )
}
