import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

export const renderIndexContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'index') throw new TypeError('Page index renderer received another content extension type.')
  const props = envelope.props
  const emptyLabel = props.emptyLabel ?? 'No pages are available in this section.'
  return sanitizeContentExtensionFragment(
    `<section class="content-extension content-extension--index content-extension-index--columns-${props.columns ?? 2}" ` +
      `aria-label="Page index" aria-busy="true" aria-live="polite" ` +
      `data-index-path="${escapeHtml(props.path)}" ` +
      `data-index-locale="${escapeHtml(props.locale)}" ` +
      `data-index-depth="${props.depth ?? 0}" ` +
      `data-index-columns="${props.columns ?? 2}" ` +
      `data-index-show-icons="${props.showIcons === true ? 'true' : 'false'}" ` +
      `data-index-order="${props.order ?? 'path'}" ` +
      `data-index-limit="${props.limit ?? 50}" ` +
      `data-index-empty-label="${escapeHtml(emptyLabel)}">` +
      `<p class="content-extension-index__status">Loading page index…</p>` +
    `</section>`
  )
}
