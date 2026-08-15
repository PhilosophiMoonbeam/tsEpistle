import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml, renderPlainText } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderSpoilerContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'spoiler') throw new TypeError('Spoiler renderer received another content extension type.')
  const label = escapeHtml(envelope.props.label ?? 'Spoiler')
  const hint = escapeHtml(envelope.props.hint ?? 'Show hidden content')
  return sanitizeContentExtensionFragment(
    `<section class="content-extension content-extension--spoiler" data-spoiler>` +
      `<button class="content-extension-spoiler__toggle" type="button" aria-expanded="true" hidden>` +
        `<span class="content-extension-spoiler__label">${label}</span>` +
        `<span class="content-extension-spoiler__hint">${hint}</span>` +
      `</button>` +
      `<div class="content-extension-spoiler__content">${renderPlainText(envelope.props.content, 'content-extension-spoiler__text')}</div>` +
    `</section>`
  )
}
