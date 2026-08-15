import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderKrokiContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'kroki') throw new TypeError('Kroki renderer received another content extension type.')
  const caption = envelope.props.caption === undefined ? `${envelope.props.type} diagram` : envelope.props.caption
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--kroki content-extension-diagram--${envelope.props.align ?? 'left'}" ` +
      `data-kroki-type="${envelope.props.type}" data-kroki-format="${envelope.props.format ?? 'svg'}" data-remote-alt="${escapeHtml(caption)}">` +
      `<div class="content-extension-remote__consent">` +
        `<p>Rendering this diagram sends its source to kroki.io. No request is made until you continue.</p>` +
        `<button class="content-extension-remote__load" type="button">Render with Kroki</button>` +
      `</div>` +
      `<pre class="content-extension-diagram__source"><code>${escapeHtml(envelope.props.source)}</code></pre>` +
      `<figcaption class="content-extension-diagram__caption">${escapeHtml(caption)}</figcaption>` +
    `</figure>`
  )
}
