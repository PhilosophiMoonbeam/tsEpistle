import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderDiagramContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'diagram') throw new TypeError('Mermaid renderer received another content extension type.')
  const caption = envelope.props.caption === undefined
    ? ''
    : `<figcaption class="content-extension-diagram__caption">${escapeHtml(envelope.props.caption)}</figcaption>`
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--diagram content-extension-diagram--${envelope.props.align ?? 'left'}" ` +
      `data-diagram-theme="${envelope.props.theme ?? 'auto'}">` +
      `<div class="content-extension-diagram__output" aria-live="polite">` +
        `<pre class="content-extension-diagram__source"><code>${escapeHtml(envelope.props.source)}</code></pre>` +
      `</div>` + caption +
    `</figure>`
  )
}
