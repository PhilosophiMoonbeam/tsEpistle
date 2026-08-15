export const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

export const renderPlainText = (value: string, className: string): string =>
  `<p class="${className}">${escapeHtml(value).replaceAll('\n', '<br>')}</p>`
