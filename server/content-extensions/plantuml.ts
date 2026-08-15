import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderPlantUmlContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'plantuml') throw new TypeError('PlantUML renderer received another content extension type.')
  const caption = envelope.props.caption ?? 'PlantUML diagram'
  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--plantuml content-extension-diagram--${envelope.props.align ?? 'left'}" ` +
      `data-plantuml-format="${envelope.props.format ?? 'svg'}" data-remote-alt="${escapeHtml(caption)}">` +
      `<div class="content-extension-remote__consent">` +
        `<p>Rendering this diagram sends its source to plantuml.com. No request is made until you continue.</p>` +
        `<button class="content-extension-remote__load" type="button">Render with PlantUML</button>` +
      `</div>` +
      `<pre class="content-extension-diagram__source"><code>${escapeHtml(envelope.props.source)}</code></pre>` +
      `<figcaption class="content-extension-diagram__caption">${escapeHtml(caption)}</figcaption>` +
    `</figure>`
  )
}
