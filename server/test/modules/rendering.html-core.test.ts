import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

interface RendererModule {
  default: {
    render: (this: RendererContext) => Promise<string>
  }
}

interface RendererContext {
  children: []
  config: {
    absoluteLinks: boolean
    openExternalLinkNewTab: boolean
    relAttributeExternalLink: string
  }
  input: string
  page: {
    id: number
    localeCode: string
    path: string
    visibility: 'public'
    ownerId: null
  }
}

const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')

afterEach(() => {
  if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
  else Reflect.deleteProperty(globalThis, 'WIKI')
})

const rendererHarness = async () => {
  const pageQuery: Record<string, unknown> & PromiseLike<Array<{ localeCode: string; path: string }>> = {
    column: vi.fn(() => pageQuery),
    where: vi.fn((...args: unknown[]) => {
      if (typeof args[0] === 'function') Reflect.apply(args[0], undefined, [pageQuery])
      return pageQuery
    }),
    orWhere: vi.fn(() => pageQuery),
    then: (onFulfilled, onRejected) => Promise.resolve([{ localeCode: 'en', path: 'target' }]).then(onFulfilled, onRejected)
  }
  const pageLinksQuery = vi.fn(() => {
    throw new Error('Rendering must not persist page links')
  })
  Reflect.set(globalThis, 'WIKI', {
    config: {
      db: { type: 'postgres' },
      host: 'https://wiki.example.test',
      lang: { code: 'en', namespaces: [], namespacing: false }
    },
    data: { reservedPaths: [] },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    models: {
      pages: { query: () => pageQuery },
      pageLinks: { query: pageLinksQuery }
    }
  })
  const renderer = (await vi.importFresh<RendererModule>('../../modules/rendering/html-core/renderer.ts', import.meta.url)).default
  const page: RendererContext['page'] = { id: 42, localeCode: 'en', path: 'home', visibility: 'public', ownerId: null }
  const render = (input: string) =>
    renderer.render.call({
      children: [],
      config: { absoluteLinks: true, openExternalLinkNewTab: false, relAttributeExternalLink: '' },
      input,
      page
    })
  return { pageLinksQuery, render }
}

describe('HTML core page-link projection boundary', () => {
  it('renders duplicate internal anchors without mutating durable link state', async () => {
    const harness = await rendererHarness()
    const output = await harness.render('<a href="/target">first</a><a href="/target">second</a>')

    expect(output.match(/is-valid-page/g) ?? []).toHaveLength(2)
    expect(harness.pageLinksQuery).not.toHaveBeenCalled()
  })

  it('can render concurrently because link persistence is owned by the fenced outbox consumer', async () => {
    const harness = await rendererHarness()
    const outputs = await Promise.all([harness.render('<a href="/target">first render</a>'), harness.render('<a href="/target">second render</a>')])

    expect(outputs).toHaveLength(2)
    expect(harness.pageLinksQuery).not.toHaveBeenCalled()
  })
})
