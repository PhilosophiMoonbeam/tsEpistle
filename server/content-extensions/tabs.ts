import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { escapeHtml, renderPlainText } from './html.ts'
import { sanitizeContentExtensionFragment } from './sanitize.ts'

export const renderTabsContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  if (envelope.key !== 'tabs') throw new TypeError('Tabs renderer received another content extension type.')
  const tabs = envelope.props.tabs
  const controls = tabs.map((tab, index) =>
    `<button class="content-extension-tabs__tab" type="button" role="tab" data-tab-index="${index}" hidden>${escapeHtml(tab.label)}</button>`
  ).join('')
  const panels = tabs.map((tab, index) => {
    const fallbackLabel = tab.headingLevel
      ? `<h${tab.headingLevel} class="content-extension-tabs__fallback-label">${escapeHtml(tab.label)}</h${tab.headingLevel}>`
      : `<p class="content-extension-tabs__fallback-label">${escapeHtml(tab.label)}</p>`
    return `<section class="content-extension-tabs__panel" role="tabpanel" data-tab-index="${index}">` +
      fallbackLabel +
      renderPlainText(tab.content, 'content-extension-tabs__content') +
    `</section>`
  }).join('')

  return sanitizeContentExtensionFragment(
    `<section class="content-extension content-extension--tabs" aria-label="Tabbed content" data-tabs-active="${envelope.props.active ?? 0}">` +
      `<div class="content-extension-tabs__list" role="tablist">${controls}</div>` +
      panels +
    `</section>`
  )
}
