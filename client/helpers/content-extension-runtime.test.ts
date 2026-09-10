import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { hydrateContentExtensions, revealContentExtensionTarget } from './content-extension-runtime.ts'
import { MERMAID_MAX_DIAGRAMS_PER_ROOT, selectMermaidRenderHosts } from './content-extension-runtimes/mermaid.ts'
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
        items: [
          {
            id: 7,
            title: '<img src=x onerror=alert(1)>',
            description: 'Reader-visible description',
            path: 'guide/visible',
            href: '/en/guide/visible',
            updatedAt: '2026-08-15T00:00:00.000Z'
          }
        ]
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
    const cleanup = hydrateContentExtensions(
      root,
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [{ id: 1, title: 'Unsafe', description: null, path: 'x', href: 'https://evil.test', updatedAt: 'now' }] })
      })
    )

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
      expect(root.querySelector<HTMLIFrameElement>('.content-extension--youtube iframe')?.src).toBe(
        'https://www.youtube-nocookie.com/embed/abc123_DEF?start=12'
      )
    })
    await vi.waitFor(() => {
      root.querySelector<HTMLButtonElement>('.content-extension--map button')!.click()
      expect(root.querySelector<HTMLIFrameElement>('.content-extension--map iframe')?.src).toMatch(/^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?/)
    })
    cleanup()
  })

  it('encodes external diagrams deterministically and does not create a Kroki request before consent', async () => {
    expect(await encodeKrokiSource('digraph{a->b}')).toMatch(/^[A-Za-z0-9_-]+$/)
    const plantUml = await encodePlantUmlSource('@startuml\nA->B\n@enduml')
    expect(await encodePlantUmlSource('@startuml\nA->B\n@enduml')).toBe(plantUml)

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

  it('respects a supplied empty Mermaid allowance without reparsing or duplicating its notice', async () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <figure class="content-extension--diagram">
        <div class="content-extension-diagram__output">
          <pre class="content-extension-diagram__source"><code>flowchart LR
A--&gt;B</code></pre>
        </div>
      </figure>`
    document.body.append(root)
    const emptyHosts = new Set<HTMLElement>()
    const cleanup = hydrateContentExtensions(root, vi.fn(), { mermaidHosts: emptyHosts })
    const output = root.querySelector<HTMLElement>('.content-extension-diagram__output')!
    expect(output.getAttribute('aria-busy')).toBe('false')
    expect(output.querySelector('code')?.textContent).toContain('flowchart LR')
    expect(root.querySelectorAll('.content-extension-diagram__limit-notice')).toHaveLength(1)
    const rehydration = hydrateContentExtensions(root, vi.fn(), { mermaidHosts: emptyHosts })
    expect(root.querySelectorAll('.content-extension-diagram__limit-notice')).toHaveLength(1)
    expect(output.querySelector('code')?.textContent).toContain('flowchart LR')
    cleanup()
    rehydration()
  })

  it('keeps tab IDs paired and scoped when authored and generated IDs collide', () => {
    const outside = document.createElement('div')
    outside.innerHTML = '<span id="inside-target"></span><span id="content-extension-tabs-77-tab-0"></span><span id="content-extension-tabs-77-panel-0"></span>'
    document.body.append(outside)
    const root = document.createElement('div')
    root.innerHTML = `
      <section class="content-extension--tabs" data-tabs-instance="77" data-tabs-active="0">
        <div class="content-extension-tabs__list" role="tablist">
          <button class="content-extension-tabs__tab" data-tab-index="0" type="button" role="tab" hidden>A</button>
          <button class="content-extension-tabs__tab" data-tab-index="1" type="button" role="tab" hidden>B</button>
        </div>
        <section class="content-extension-tabs__panel" data-tab-index="0" role="tabpanel">
          <h2 id="inside-target" class="content-extension-tabs__fallback-label">A</h2><p>Alpha</p>
        </section>
        <section class="content-extension-tabs__panel" data-tab-index="1" role="tabpanel">
          <h2 id="owned-target" class="content-extension-tabs__fallback-label">B</h2><p>Beta</p>
        </section>
      </section>
      <section class="content-extension--tabs" data-tabs-instance="77" data-tabs-active="0">
        <div class="content-extension-tabs__list" role="tablist">
          <button class="content-extension-tabs__tab" data-tab-index="0" type="button" role="tab" hidden>C</button>
          <button class="content-extension-tabs__tab" data-tab-index="1" type="button" role="tab" hidden>D</button>
        </div>
        <section class="content-extension-tabs__panel" data-tab-index="0" role="tabpanel"><p class="content-extension-tabs__fallback-label">C</p></section>
        <section class="content-extension-tabs__panel" data-tab-index="1" role="tabpanel"><p class="content-extension-tabs__fallback-label">D</p></section>
      </section>`
    window.location.hash = '#owned-target'
    const cleanup = hydrateContentExtensions(root, vi.fn())
    const tabs = [...root.querySelectorAll<HTMLElement>('.content-extension--tabs')]
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.content-extension-tabs__tab')]
    const panels = [...root.querySelectorAll<HTMLElement>('.content-extension-tabs__panel')]
    const ids = [...buttons, ...panels].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const button of buttons) {
      const panel = panels.find(candidate => candidate.id === button.getAttribute('aria-controls'))
      expect(panel).not.toBeUndefined()
      expect(panel?.getAttribute('aria-labelledby')).toBe(button.id)
    }
    expect(panels[0]?.id).not.toBe('inside-target')
    expect(root.querySelector<HTMLElement>('#inside-target')).not.toBeNull()
    expect(panels[1]?.id).toBe('owned-target')
    expect(revealContentExtensionTarget(root, '#inside-target')).toBe(true)
    expect(panels[0]?.hidden).toBe(false)
    expect(tabs).toHaveLength(2)
    document.body.append(root)
    const secondSetButtons = buttons.slice(2)
    secondSetButtons[0]!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }))
    expect(document.activeElement).toBe(secondSetButtons[1])
    cleanup()
    secondSetButtons[0]!.click()
    expect(secondSetButtons[1]?.getAttribute('aria-selected')).toBe('true')
    window.location.hash = ''
  })
  it('selects a bounded distinct Mermaid host allowance in input order', () => {
    const root = document.createElement('div')
    const hosts = Array.from({ length: MERMAID_MAX_DIAGRAMS_PER_ROOT + 1 }, () => {
      const host = document.createElement('figure')
      host.className = 'content-extension--diagram'
      root.append(host)
      return host
    })
    const selected = selectMermaidRenderHosts([hosts[0]!, hosts[0]!, ...hosts.slice(1)])
    expect(selected.size).toBe(MERMAID_MAX_DIAGRAMS_PER_ROOT)
    expect([...selected]).toEqual(hosts.slice(0, MERMAID_MAX_DIAGRAMS_PER_ROOT))
    expect(root.querySelectorAll('.content-extension--diagram')).toHaveLength(MERMAID_MAX_DIAGRAMS_PER_ROOT + 1)
  })
})
