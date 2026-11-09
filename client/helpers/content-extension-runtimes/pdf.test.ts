import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { hydratePdf } from './pdf.ts'
import { isSafeContentExtensionPdfPath } from '../../../shared/content-extensions.ts'

const fetchPdf = vi.fn()
const cleanups: Array<() => void> = []

const pdfResponse = (options: { status?: number; type?: string; proof?: string | null; nosniff?: string | null; url?: string; redirected?: boolean; disposition?: string; length?: string } = {}): Response => {
  const headers = new Headers({ 'Content-Type': options.type ?? 'application/pdf', 'Content-Length': options.length ?? '512' })
  if (options.proof !== null) headers.set('X-Wiki-Asset-Type', options.proof ?? 'pdf')
  if (options.nosniff !== null) headers.set('X-Content-Type-Options', options.nosniff ?? 'nosniff')
  if (options.disposition) headers.set('Content-Disposition', options.disposition)
  const response = new Response(null, { status: options.status ?? 200, headers })
  Object.defineProperty(response, 'url', { value: options.url ?? new URL('/manual.pdf', document.location.origin).href })
  Object.defineProperty(response, 'redirected', { value: options.redirected ?? false })
  return response
}

const pdfFigure = (attributes: DOMStringMap = {}): HTMLElement => {
  const figure = document.createElement('figure')
  figure.className = 'content-extension--pdf'
  Object.assign(figure.dataset, { pdfSrc: '/manual.pdf', pdfPage: '3', pdfHeight: '720', pdfTitle: 'Reader manual', ...attributes })
  const viewer = document.createElement('div')
  viewer.className = 'content-extension-pdf__viewer'
  const fallback = document.createElement('figcaption')
  fallback.className = 'content-extension-pdf__fallback'
  // Legacy markup may contain a link that was never admitted by today's parser.
  const unverifiedLink = document.createElement('a')
  unverifiedLink.href = figure.dataset.pdfSrc!
  unverifiedLink.textContent = 'Legacy open link'
  fallback.append(unverifiedLink)
  figure.append(viewer, fallback)
  document.body.append(figure)
  return figure
}

beforeEach(() => {
  fetchPdf.mockReset()
  vi.stubGlobal('fetch', fetchPdf)
})

afterEach(() => {
  cleanups.splice(0).forEach(cleanup => { cleanup() })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('PDF hydration authority and opaque frame boundary', () => {
  it.each([
    '/login', '/_admin/settings.pdf', '//attacker.invalid/manual.pdf', '/manual.PDF?download=1',
    '/manual.pdf#page=1', '/%6danual.pdf', '/%2f%2fattacker.invalid/a.pdf', '/%00manual.pdf',
    '/folder/../manual.pdf', '/folder//manual.pdf', '/manual\\.pdf', '/manual\n.pdf'
  ])('refuses legacy path %s before issuing a request or retaining its open link', async src => {
    const figure = pdfFigure({ pdfSrc: src })
    expect(isSafeContentExtensionPdfPath(src)).toBe(false)
    cleanups.push(hydratePdf(figure))
    await Promise.resolve()
    expect(fetchPdf).not.toHaveBeenCalled()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a[href]')).toBeNull()
    expect(figure.textContent).toContain('could not be verified')
  })

  it.each([
    { pdfPage: '0' }, { pdfPage: '100001' }, { pdfPage: '1e2' }, { pdfPage: '1.5' }, { pdfPage: '' },
    { pdfHeight: '319' }, { pdfHeight: '1601' }, { pdfHeight: 'Infinity' }, { pdfHeight: '720px' }, { pdfTitle: 'x'.repeat(201) }
  ])('refuses malformed legacy attributes %j before loading', attributes => {
    const figure = pdfFigure(attributes)
    cleanups.push(hydratePdf(figure))
    expect(fetchPdf).not.toHaveBeenCalled()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a[href]')).toBeNull()
  })

  it('requires canonical response proof before constructing a sandboxed page-selected frame and an accessible fallback', async () => {
    const pending = Promise.withResolvers<Response>()
    fetchPdf.mockReturnValue(pending.promise)
    const figure = pdfFigure()
    const cleanup = hydratePdf(figure)
    cleanups.push(cleanup)
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a[href]')).toBeNull()
    expect(fetchPdf).toHaveBeenCalledWith('/manual.pdf', expect.objectContaining({ method: 'HEAD', redirect: 'error', credentials: 'same-origin', signal: expect.any(AbortSignal) }))
    pending.resolve(pdfResponse())
    await Promise.resolve()
    const frame = figure.querySelector('iframe')!
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toBe('/manual.pdf#page=3')
    expect(frame.title).toBe('Reader manual')
    expect(frame.style.height).toBe('720px')
    const link = figure.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/manual.pdf#page=3')
    expect(link.textContent).toContain('Reader manual — open or download PDF')
    expect(figure.textContent).toContain('If the preview is unavailable in your browser')
    // A native plugin/load failure never upgrades the frame to reader-origin or script authority.
    frame.dispatchEvent(new window.Event('error'))
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(link.isConnected).toBe(true)
    cleanup()
    expect(frame.getAttribute('src')).toBe('about:blank')
    expect(frame.isConnected).toBe(false)
    expect(link.isConnected).toBe(false)
    expect(fetchPdf.mock.calls[0]![1].signal.aborted).toBe(true)
  })

  it.each([
    { type: 'text/html' }, { type: 'image/svg+xml' }, { type: 'application/octet-stream', disposition: 'attachment; filename=manual.pdf' },
    { proof: null }, { proof: 'html' }, { nosniff: null }, { status: 403 }, { status: 404 }, { status: 500 }, { status: 206 },
    { length: '0' }, { length: 'NaN' }, { length: '-1' },
    { redirected: true }, { url: new URL('/login', document.location.origin).href }
  ])('does not frame or expose an unverified/non-PDF/revoked response %j', async options => {
    fetchPdf.mockResolvedValue(pdfResponse(options))
    const figure = pdfFigure()
    cleanups.push(hydratePdf(figure))
    await Promise.resolve()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a[href]')).toBeNull()
  })

  it('offers an authorized forced download without attempting an inline frame', async () => {
    fetchPdf.mockResolvedValue(pdfResponse({ disposition: 'attachment; filename=manual.pdf' }))
    const figure = pdfFigure()
    cleanups.push(hydratePdf(figure))
    await Promise.resolve()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a')?.getAttribute('href')).toBe('/manual.pdf#page=3')
  })

  it('does not insert a frame or restore a link after cleanup while verification is in flight', async () => {
    const pending = Promise.withResolvers<Response>()
    fetchPdf.mockReturnValue(pending.promise)
    const figure = pdfFigure()
    const cleanup = hydratePdf(figure)
    cleanup()
    pending.resolve(pdfResponse())
    await Promise.resolve()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a[href]')).toBeNull()
  })

  it('refuses redirect/network failures without removing sandbox protections on retry', async () => {
    fetchPdf.mockRejectedValue(new TypeError('redirect disallowed'))
    const figure = pdfFigure()
    cleanups.push(hydratePdf(figure))
    await Promise.resolve()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a[href]')).toBeNull()
  })
})
