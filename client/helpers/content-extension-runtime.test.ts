import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateContentExtensions, revealContentExtensionTarget } from './content-extension-runtime.ts'
import { encodeKrokiSource, encodePlantUmlSource } from './content-extension-runtimes/remote-diagram.ts'

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

  it('hydrates tabs and spoilers with accessible controls while preserving static fallback content', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <section class="content-extension--tabs" data-tabs-active="0">
        <div class="content-extension-tabs__list" role="tablist">
          <button class="content-extension-tabs__tab" data-tab-index="0" type="button" role="tab" hidden>A</button>
          <button class="content-extension-tabs__tab" data-tab-index="1" type="button" role="tab" hidden>B</button>
        </div>
        <section class="content-extension-tabs__panel" data-tab-index="0" role="tabpanel"><p class="content-extension-tabs__fallback-label">A</p><p>Alpha</p></section>
        <section class="content-extension-tabs__panel" data-tab-index="1" role="tabpanel"><h2 id="details" class="content-extension-tabs__fallback-label">B</h2><p>Beta</p></section>
      </section>
      <section class="content-extension--spoiler">
        <button class="content-extension-spoiler__toggle" type="button" hidden>Reveal</button>
        <div class="content-extension-spoiler__content">Secret</div>
      </section>`
    document.body.append(root)

    const cleanup = hydrateContentExtensions(root, vi.fn())
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.content-extension-tabs__tab')]
    const panels = [...root.querySelectorAll<HTMLElement>('.content-extension-tabs__panel')]
    expect(buttons.map(button => button.hidden)).toEqual([false, false])
    expect(buttons.map(button => button.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect(panels.map(panel => panel.hidden)).toEqual([false, true])
    expect(panels[1]?.id).toBe('details')
    expect(panels[1]?.querySelector('.content-extension-tabs__fallback-label')?.id).toBe('')

    expect(revealContentExtensionTarget(root, '#details')).toBe(true)
    expect(panels.map(panel => panel.hidden)).toEqual([true, false])
    expect(panels[1]?.style.scrollMarginTop).toBe('20px')
    buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
    expect(document.activeElement).toBe(buttons[0])

    const spoilerButton = root.querySelector<HTMLButtonElement>('.content-extension-spoiler__toggle')!
    const spoilerContent = root.querySelector<HTMLElement>('.content-extension-spoiler__content')!
    expect(spoilerButton.hidden).toBe(false)
    expect(spoilerContent.hidden).toBe(true)
    spoilerButton.click()
    expect(spoilerButton.getAttribute('aria-expanded')).toBe('true')
    expect(spoilerContent.hidden).toBe(false)
    cleanup()
  })

  it('creates same-origin PDF and consent-gated remote frames only at their declared boundary', async () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <figure class="content-extension--pdf" data-pdf-src="/uploads/guide.pdf" data-pdf-page="3" data-pdf-height="640" data-pdf-title="Guide">
        <div class="content-extension-pdf__viewer"></div>
      </figure>
      <figure class="content-extension--youtube" data-youtube-id="abc123_DEF" data-youtube-start="12" data-youtube-controls="true" data-youtube-title="Demo">
        <div class="content-extension-remote__consent"><button class="content-extension-remote__load" type="button">Load</button></div>
      </figure>
      <figure class="content-extension--map" data-map-latitude="45.5" data-map-longitude="-73.5" data-map-zoom="13" data-map-height="400" data-map-label="Montreal">
        <div class="content-extension-remote__consent"><button class="content-extension-remote__load" type="button">Load</button></div>
      </figure>`
    document.body.append(root)

    const cleanup = hydrateContentExtensions(root, vi.fn())
    await vi.waitFor(() => expect(root.querySelector<HTMLIFrameElement>('.content-extension-pdf__frame')).not.toBeNull())
    expect(root.querySelector('iframe[src^="https://"]')).toBeNull()

    await vi.waitFor(() => {
      root.querySelector<HTMLButtonElement>('.content-extension--youtube button')!.click()
      expect(root.querySelector<HTMLIFrameElement>('.content-extension--youtube iframe')?.src)
        .toBe('https://www.youtube-nocookie.com/embed/abc123_DEF?start=12')
    })
    await vi.waitFor(() => {
      root.querySelector<HTMLButtonElement>('.content-extension--map button')!.click()
      expect(root.querySelector<HTMLIFrameElement>('.content-extension--map iframe')?.src)
        .toMatch(/^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?/)
    })
    cleanup()
  })

  it('encodes external diagrams deterministically and does not create a Kroki request before consent', async () => {
    await expect(encodeKrokiSource('digraph{a->b}')).resolves.toMatch(/^[A-Za-z0-9_-]+$/)
    const plantUml = await encodePlantUmlSource('@startuml\nA->B\n@enduml')
    await expect(encodePlantUmlSource('@startuml\nA->B\n@enduml')).resolves.toBe(plantUml)

    const root = document.createElement('div')
    root.innerHTML = `
      <figure class="content-extension--kroki" data-kroki-type="graphviz" data-kroki-format="svg" data-remote-alt="Graph">
        <div class="content-extension-remote__consent"><button class="content-extension-remote__load" type="button">Render</button></div>
        <pre class="content-extension-diagram__source"><code>digraph{a-&gt;b}</code></pre>
      </figure>`
    document.body.append(root)
    const cleanup = hydrateContentExtensions(root, vi.fn())
    expect(root.querySelector('img')).toBeNull()
    await vi.waitFor(() => {
      root.querySelector<HTMLButtonElement>('button')!.click()
      expect(root.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    })
    await vi.waitFor(() => expect(root.querySelector<HTMLImageElement>('img')?.src).toMatch(/^https:\/\/kroki\.io\/graphviz\/svg\//))
    expect(root.querySelector('.content-extension-diagram__source--fallback')?.textContent).toBe('digraph{a->b}')
    cleanup()
  })

  it('renders Mermaid locally without leaving active SVG elements', async () => {
    vi.doMock('mermaid', () => ({
      default: {
        initialize: vi.fn(),
        render: vi.fn().mockResolvedValue({
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text>Flow</text></svg>'
        })
      }
    }))
    const root = document.createElement('div')
    root.innerHTML = `
      <figure class="content-extension--diagram" data-diagram-theme="default">
        <div class="content-extension-diagram__output"><pre class="content-extension-diagram__source"><code>flowchart LR
A--&gt;B</code></pre></div>
        <figcaption>Flow</figcaption>
      </figure>`
    document.body.append(root)
    const cleanup = hydrateContentExtensions(root, vi.fn())
    await vi.waitFor(() => expect(root.querySelector('.content-extension-diagram__output svg')).not.toBeNull(), { timeout: 5000 })
    expect(root.querySelector('script, foreignObject, iframe, image, use, a')).toBeNull()
    expect(root.querySelector('svg')?.getAttribute('aria-label')).toBe('Flow')
    cleanup()
  })
})
