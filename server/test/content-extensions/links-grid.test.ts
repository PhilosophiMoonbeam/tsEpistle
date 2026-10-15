import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { LINKS_GRID_STARTER, serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
import { hydrateLinksGrid } from '../../../client/helpers/content-extension-runtimes/links-grid.ts'
import { listContentExtensions, setContentExtensionEnabled } from '../../content-extensions/operations.ts'
import { up as createRegistry } from '../../db/migrations/2.5.135.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLease } from '../../db/migrations/2.5.158.ts'
import { up as installLinksGrid, down as retainLinksGrid } from '../../db/migrations/tsepistle-000060-links-grid.ts'
import markdownRenderer from '../../modules/rendering/markdown-core/renderer.ts'

const baseConfig = { allowHTML: false, linebreaks: false, linkify: false, typographer: false, quotes: 'English', underline: false }

const renderMarkdown = (input: string) => markdownRenderer.render.call({ input, config: baseConfig, children: [] })

const source = serializeContentExtensionFence({
  key: 'links-grid',
  version: 1,
  props: {
    cards: [
      {
        title: 'A < B & C',
        url: 'https://example.test/?q=1&lang=en',
        description: '<script>alert(1)</script>',
        image: '/images/card.webp',
        icon: 'page',
        tags: ['<tag>', 'A & B']
      },
      { title: 'Local guide', url: '/en/guide' }
    ]
  }
})

describe('links-grid installation and native Markdown host', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await db('users').insert({ id: 7 })
    await createRegistry(db)
    await createDurableJobs(db)
    await addDurableJobLease(db)
    await installLinksGrid(db)
    global.WIKI = { models: { knex: db } }
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('starts disabled, preserves exact escaped source, and toggles named no-JS links through the existing host', async () => {
    const status = (await listContentExtensions()).extensions.find(extension => extension.key === 'links-grid')
    expect(status).toMatchObject({ isEnabled: false, compatible: true })
    const disabled = new DOMParser().parseFromString(await renderMarkdown(source), 'text/html')
    expect(disabled.querySelector('pre code')?.textContent).toBe(`${source.split('\n')[1]}\n`)
    expect(disabled.querySelector('.content-extension--links-grid')).toBeNull()

    const enabled = await setContentExtensionEnabled('links-grid', true, 7)
    expect(enabled).toMatchObject({ isEnabled: true, compatible: true })
    const output = await renderMarkdown(source)
    const document = new DOMParser().parseFromString(output, 'text/html')
    const links = [...document.querySelectorAll('.content-extension--links-grid ul[role="list"] > li > a')]
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute('href')).toBe('https://example.test/?q=1&lang=en')
    expect(links[0]?.getAttribute('aria-label')).toBe('A < B & C')
    expect(links[0]?.querySelector('.content-extension-links-grid__title')?.textContent).toBe('A < B & C')
    expect(links[0]?.querySelector('.content-extension-links-grid__description')?.textContent).toBe('<script>alert(1)</script>')
    expect([...document.querySelectorAll('.content-extension-links-grid__tag')].map(tag => tag.textContent)).toEqual(['<tag>', 'A & B'])
    expect(links[1]?.getAttribute('href')).toBe('/en/guide')
    expect(document.querySelector('img.content-extension-links-grid__image')?.getAttribute('src')).toBe('/images/card.webp')
    expect(document.querySelector('img.content-extension-links-grid__icon')?.getAttribute('src')).toBe('/_assets/svg/icon-browse-page.svg')
    expect(document.querySelector('script, svg, iframe, style, [onclick], [onerror], [style]')).toBeNull()
    expect(output).not.toContain('aria-busy')

    const jobs = await db<{ type: string; payload: string; state: string }>('durableJobs').select('type', 'payload', 'state')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.type).toBe('rerender-content-extension')
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ key: 'links-grid' })
    expect(jobs[0]?.state).toBe('pending')
    await setContentExtensionEnabled('links-grid', false, 7)
    const restored = new DOMParser().parseFromString(await renderMarkdown(source), 'text/html')
    expect(restored.querySelector('pre code')?.textContent).toBe(`${source.split('\n')[1]}\n`)
    expect(restored.querySelector('.content-extension--links-grid')).toBeNull()
  })

  it('keeps administrator state on migration reruns and rollback and provides an insertable starter', async () => {
    await setContentExtensionEnabled('links-grid', true, 7)
    await db('contentExtensions').where({ key: 'links-grid' }).update({ version: 2 })
    const before = await db('contentExtensions').where({ key: 'links-grid' }).first()
    await installLinksGrid(db)
    await retainLinksGrid()
    expect(await db('contentExtensions').where({ key: 'links-grid' })).toEqual([before])
    await db('contentExtensions').where({ key: 'links-grid' }).update({ version: 1 })
    const starter = new DOMParser().parseFromString(await renderMarkdown(serializeContentExtensionFence(LINKS_GRID_STARTER)), 'text/html')
    expect(starter.querySelector('.content-extension-links-grid__link')?.getAttribute('aria-label')).toBe('Documentation')
    expect(starter.querySelector('.content-extension-links-grid__link')?.getAttribute('href')).toBe('/en/home')
  })

  it('never replaces unsafe authored JSON with partial cards or a fallback UI', async () => {
    await setContentExtensionEnabled('links-grid', true, 7)
    const body = '{"key":"links-grid","version":1,"props":{"cards":[{"title":"Unsafe <name>","url":"javascript:alert(1)"}]}}\n'
    const document = new DOMParser().parseFromString(await renderMarkdown(`\`\`\`wiki-extension\n${body}\`\`\`\n`), 'text/html')
    expect(document.querySelector('pre code')?.textContent).toBe(body)
    expect(document.querySelector('.content-extension--links-grid, a, script')).toBeNull()
  })
})

describe('links-grid lazy style lifecycle', () => {
  it('shares styles across mounted grids and removes them only after the last teardown', () => {
    const document = new DOMParser().parseFromString('<html><head></head><body><section></section><section></section></body></html>', 'text/html')
    const grids = [...document.querySelectorAll<HTMLElement>('section')]
    const first = hydrateLinksGrid(grids[0]!)
    const second = hydrateLinksGrid(grids[1]!)
    expect(document.head.querySelectorAll('style')).toHaveLength(1)
    first()
    first()
    expect(document.head.querySelectorAll('style')).toHaveLength(1)
    second()
    expect(document.head.querySelector('style')).toBeNull()
    const remounted = hydrateLinksGrid(grids[0]!)
    expect(document.head.querySelectorAll('style')).toHaveLength(1)
    remounted()
    expect(document.head.querySelector('style')).toBeNull()
  })
})
