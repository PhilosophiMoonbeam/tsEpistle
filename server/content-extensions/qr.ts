import * as QRCode from 'qrcode'

import type { ContentExtensionEnvelope } from '../../shared/content-extensions.ts'
import { isSafeContentExtensionLink, sanitizeContentExtensionFragment } from './sanitize.ts'

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

export const renderQrContentExtension = async (envelope: ContentExtensionEnvelope): Promise<string> => {
  const { value } = envelope.props
  const label = envelope.props.label || 'QR code'
  const size = envelope.props.size ?? 256
  const errorCorrectionLevel = envelope.props.errorCorrection ?? 'M'
  const svg = await QRCode.toString(value, {
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel,
    margin: 1,
    type: 'svg',
    width: size
  })
  const safeLabel = escapeHtml(label)
  const accessibleSvg = svg
    .replace('<svg ', `<svg role="img" aria-label="${safeLabel}" `)
    .replace('>', `><title>${safeLabel}</title>`)
    .trim()
  const safeValue = escapeHtml(value)
  const valueFallback = isSafeContentExtensionLink(value)
    ? `<a class="content-extension-qr__value" href="${safeValue}" rel="noopener noreferrer">${safeValue}</a>`
    : `<span class="content-extension-qr__value">${safeValue}</span>`

  return sanitizeContentExtensionFragment(
    `<figure class="content-extension content-extension--qr">` +
      accessibleSvg +
      `<figcaption><span class="content-extension-qr__label">${safeLabel}</span>` +
      `${valueFallback}` +
      `</figcaption>` +
    `</figure>`
  )
}
