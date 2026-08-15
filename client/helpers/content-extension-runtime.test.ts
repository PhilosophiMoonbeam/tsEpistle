import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateContentExtensions } from './content-extension-runtime.ts'

const indexElement = (): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = `<section class="content-extension--index content-extension-index--columns-2" aria-busy="true"
    data-index-path="guide" data-index-locale="en" data-index-depth="1" data-index-order="title"
    data-index-limit="20" data-index-show-icons="true" data-index-empty-label="Nothing readable.">
    <p class="content-extension-index__status">Loading page index…</p></section>`
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('content extension browser runtime', () => {
  it('hydrates a policy-filtered page index with text-only DOM construction', async () => {
    const root = indexElement()
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          id: 7,
          title: '<img src=x onerror=alert(1)>',
          description: 'Reader-visible description',
          path: 'guide/visible',
          href: '/en/guide/visible',
          updatedAt: '2026-08-15T00:00:00.000Z'
        }]
      })
    })

    const cleanup = hydrateContentExtensions(root, fetchImpl)
    await vi.waitFor(() => expect(root.querySelector('.content-extension-index__link')).not.toBeNull())

    expect(fetchImpl).toHaveBeenCalledWith(
      '/_api/content-extensions/index?path=guide&locale=en&depth=1&order=title&limit=20',
      expect.objectContaining({ credentials: 'same-origin', headers: { Accept: 'application/json' } })
    )
    const index = root.querySelector<HTMLElement>('.content-extension--index')!
    expect(index.getAttribute('aria-busy')).toBe('false')
    expect(index.querySelector('a')?.getAttribute('href')).toBe('/en/guide/visible')
    expect(index.querySelector('.content-extension-index__title')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(index.querySelector('img')).toBeNull()
    expect(index.querySelector('.content-extension-index__icon')?.getAttribute('aria-hidden')).toBe('true')
    cleanup()
  })

  it('renders the authored empty state without inventing links', async () => {
    const root = indexElement()
    const cleanup = hydrateContentExtensions(root, vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }))

    await vi.waitFor(() => expect(root.querySelector('.content-extension-index__status')?.textContent).toBe('Nothing readable.'))
    expect(root.querySelector('a')).toBeNull()
    cleanup()
  })

  it('fails closed on malformed or failed index responses', async () => {
    const root = indexElement()
    const cleanup = hydrateContentExtensions(root, vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 1, title: 'Unsafe', description: null, path: 'x', href: 'https://evil.test', updatedAt: 'now' }] })
    }))

    await vi.waitFor(() => expect(root.querySelector('.content-extension-index__status')?.textContent).toBe('Page index is temporarily unavailable.'))
    expect(root.querySelector('a')).toBeNull()
    cleanup()
  })

  it('keeps gallery links as no-script fallbacks when modal dialogs are unavailable', () => {
    const root = document.createElement('div')
    root.innerHTML = `<section class="content-extension--gallery"><a class="content-extension-gallery__link" href="/uploads/a.jpg"><img src="/uploads/a.jpg" alt="A"></a></section>`
    document.body.append(root)
    const showModal = HTMLDialogElement.prototype.showModal
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: undefined })

    const cleanup = hydrateContentExtensions(root, vi.fn())
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/uploads/a.jpg')
    expect(document.querySelector('.content-extension-gallery-dialog')).toBeNull()
    cleanup()

    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal })
  })
})
