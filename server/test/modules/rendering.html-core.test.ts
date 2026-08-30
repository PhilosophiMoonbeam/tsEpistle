import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

interface PageLinkRow {
  id: number
  pageId: number
  localeCode: string
  path: string
}

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
    $relatedQuery: (relation: 'links') => Promise<PageLinkRow[]>
  }
}

const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')

afterEach(() => {
  if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
  else Reflect.deleteProperty(globalThis, 'WIKI')
})

const rendererHarness = async (beforeLinkRead?: () => Promise<void>) => {
  const storedLinks: PageLinkRow[] = []
  const mutations: string[] = []
  const insertBatches: Array<Array<Omit<PageLinkRow, 'id'>>> = []
  const conflictTargets: string[][] = []
  let nextId = 1

  const pageQuery: Record<string, unknown> & PromiseLike<Array<{ localeCode: string; path: string }>> = {
    column: vi.fn(() => pageQuery),
    where: vi.fn((...args: unknown[]) => {
      if (typeof args[0] === 'function') Reflect.apply(args[0], undefined, [pageQuery])
      return pageQuery
    }),
    orWhere: vi.fn(() => pageQuery),
    then: (onFulfilled, onRejected) => Promise.resolve([{ localeCode: 'en', path: 'target' }]).then(onFulfilled, onRejected)
  }

  const insert = vi.fn((rows: Array<Omit<PageLinkRow, 'id'>>) => {
    insertBatches.push(rows)
    return {
      onConflict: (columns: string[]) => {
        conflictTargets.push(columns)
        return {
          ignore: async () => {
            for (const row of rows) {
              const exists = storedLinks.some(link => link.pageId === row.pageId && link.localeCode === row.localeCode && link.path === row.path)
              if (!exists) {
                storedLinks.push({ id: nextId++, ...row })
                mutations.push(`add:${row.localeCode}:${row.path}`)
              }
            }
          }
        }
      }
    }
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
      pageLinks: {
        query: () => ({
          insert,
          delete: () => ({
            whereIn: async (_column: string, ids: number[]) => {
              for (let index = storedLinks.length - 1; index >= 0; index -= 1) {
                if (ids.includes(storedLinks[index].id)) {
                  mutations.push(`remove:${storedLinks[index].localeCode}:${storedLinks[index].path}`)
                  storedLinks.splice(index, 1)
                }
              }
            }
          })
        })
      }
    }
  })

  const renderer = (await vi.importFresh<RendererModule>('../../modules/rendering/html-core/renderer.ts', import.meta.url)).default
  const page: RendererContext['page'] = {
    id: 42,
    localeCode: 'en',
    path: 'home',
    visibility: 'public',
    ownerId: null,
    $relatedQuery: async () => {
      if (beforeLinkRead) await beforeLinkRead()
      return storedLinks.map(link => ({ ...link }))
    }
  }
  const render = (input: string) =>
    renderer.render.call({
      children: [],
      config: {
        absoluteLinks: true,
        openExternalLinkNewTab: false,
        relAttributeExternalLink: ''
      },
      input,
      page
    })
  return { conflictTargets, insertBatches, mutations, render, storedLinks }
}

describe('HTML core page-link identity', () => {
  it('persists two anchors to one target once across repeated renders', async () => {
    const harness = await rendererHarness()
    const input = '<a href="/target">first</a><a href="/target">second</a>'

    const firstOutput = await harness.render(input)
    await harness.render(input)

    expect(firstOutput.match(/is-valid-page/g) ?? []).toHaveLength(2)
    expect(harness.insertBatches).toEqual([[{ pageId: 42, localeCode: 'en', path: 'target' }]])
    expect(harness.storedLinks).toHaveLength(1)
    expect(harness.storedLinks[0]).toMatchObject({ pageId: 42, localeCode: 'en', path: 'target' })
  })

  it('adds the replacement before removing the obsolete bounded-list entry', async () => {
    const harness = await rendererHarness()

    await harness.render('<a href="/target">old target</a>')
    await harness.render('<a href="/replacement">replacement</a>')

    expect(harness.storedLinks).toHaveLength(1)
    expect(harness.storedLinks[0]).toMatchObject({ pageId: 42, localeCode: 'en', path: 'replacement' })
    expect(harness.mutations).toEqual(['add:en:target', 'add:en:replacement', 'remove:en:target'])
  })

  it('uses the canonical identity as the conflict target for concurrent renders', async () => {
    let reads = 0
    let releaseReads: (() => void) | undefined
    const bothReads = new Promise<void>(resolve => {
      releaseReads = resolve
    })
    const harness = await rendererHarness(async () => {
      reads += 1
      if (reads === 2) releaseReads?.()
      await bothReads
    })

    await Promise.all([harness.render('<a href="/target">first render</a>'), harness.render('<a href="/target">second render</a>')])

    expect(harness.conflictTargets).toEqual([
      ['pageId', 'localeCode', 'path'],
      ['pageId', 'localeCode', 'path']
    ])
    expect(harness.storedLinks).toHaveLength(1)
  })
})
