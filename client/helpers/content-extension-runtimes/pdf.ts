import { isSafeContentExtensionPdfPath } from '../../../shared/content-extensions.ts'

type Cleanup = () => void

export const hydratePdf = (figure: HTMLElement): Cleanup => {
  const src = figure.dataset.pdfSrc ?? ''
  const viewer = figure.querySelector<HTMLElement>('.content-extension-pdf__viewer')
  if (!viewer) return () => {}
  // Stored figures bypass envelope parsing. Retire their unverified links as well
  // as refusing a frame: a same-origin application pathname is not a PDF proof.
  let fallback = figure.querySelector<HTMLElement>('.content-extension-pdf__fallback')
  if (!fallback) {
    fallback = figure.ownerDocument.createElement('figcaption')
    fallback.className = 'content-extension-pdf__fallback'
    figure.append(fallback)
  }
  fallback.textContent = 'PDF preview unavailable: the asset could not be verified.'
  const pageText = figure.dataset.pdfPage ?? ''
  const heightText = figure.dataset.pdfHeight ?? ''
  const page = Number(pageText)
  const height = Number(heightText)
  const title = figure.dataset.pdfTitle ?? 'PDF document'
  if (!isSafeContentExtensionPdfPath(src) ||
      !/^\d+$/.test(pageText) || !Number.isInteger(page) || page < 1 || page > 100000 ||
      !/^\d+$/.test(heightText) || !Number.isInteger(height) || height < 320 || height > 1600 || title.length > 200) return () => {}

  const controller = new AbortController()
  let frame: HTMLIFrameElement | undefined
  let open: HTMLAnchorElement | undefined
  void (async () => {
    try {
      // No redirects or inferred MIME: only the authorized canonical byte route
      // can attest the selected source as PDF, including legacy storage copies.
      const response = await fetch(src, { method: 'HEAD', credentials: 'same-origin', redirect: 'error', signal: controller.signal })
      if (controller.signal.aborted) return
      const expected = new URL(src, figure.ownerDocument.location.origin)
      const byteLength = Number(response.headers.get('Content-Length'))
      if (response.status !== 200 || response.redirected || response.url !== expected.href ||
          response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf' ||
          response.headers.get('X-Content-Type-Options')?.toLowerCase() !== 'nosniff' ||
          response.headers.get('X-Wiki-Asset-Type') !== 'pdf' || !Number.isSafeInteger(byteLength) || byteLength <= 0) return

      open = figure.ownerDocument.createElement('a')
      open.href = `${src}#page=${page}`
      open.textContent = `${title || 'PDF document'} — open or download PDF`
      fallback.replaceChildren(open)
      fallback.append(figure.ownerDocument.createTextNode(' If the preview is unavailable in your browser, use this link.'))
      // An authorized forced download is already a complete safe outcome.
      if (/^attachment(?:;|$)/i.test(response.headers.get('Content-Disposition') ?? '')) return
      frame = figure.ownerDocument.createElement('iframe')
      frame.className = 'content-extension-pdf__frame'
      frame.setAttribute('sandbox', '')
      frame.src = `${src}#page=${page}`
      frame.title = title || 'PDF document'
      frame.loading = 'lazy'
      frame.style.height = `${height}px`
      viewer.append(frame)
    } catch {
      // Refusal includes revoked authorization, errors, redirects and CSP/network
      // failures. Never trade away the opaque frame sandbox for plugin support.
    }
  })()
  return () => {
    controller.abort()
    if (frame) {
      frame.src = 'about:blank'
      frame.remove()
    }
    open?.remove()
  }
}
