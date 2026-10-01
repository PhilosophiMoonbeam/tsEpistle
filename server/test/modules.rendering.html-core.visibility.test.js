import createKnex from 'knex'
import { load } from 'cheerio'

const originalWIKI = global.WIKI

let database

describe('HTML renderer private-link isolation', () => {
  afterEach(async () => {
    if (database) await database.destroy()
    database = undefined
    vi.resetModules()
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  const render = async ({ visibility, ownerId, localeCode = 'en' }) => {
    database = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await database.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId')
    })
    await database('pages').insert([
      { id: 9, localeCode, path: 'public', visibility: 'public', ownerId: null },
      { id: 10, localeCode, path: 'owned', visibility: 'private', ownerId: 7 },
      { id: 11, localeCode, path: 'foreign', visibility: 'private', ownerId: 8 }
    ])
    global.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(false) },
      config: {
        db: { type: 'postgres' },
        host: 'http://wiki.example.test',
        lang: { code: localeCode, namespacing: true }
      },
      logger: { warn: vi.fn() },
      models: {
        pages: { query: () => database('pages') },
      }
    }
    const plugin = (await vi.importFresh('../modules/rendering/html-core/renderer.ts', import.meta.url)).default
    const html = await plugin.render.call({
      children: [],
      config: { absoluteLinks: false, openExternalLinkNewTab: false, relAttributeExternalLink: '' },
      input: ['public', 'owned', 'foreign'].map(route => `<a href="/${localeCode}/${route}">${route}</a>`).join(''),
      page: {
        id: 1,
        localeCode,
        path: 'home',
        visibility,
        ownerId,
      }
    })
    return { html, $: load(html) }
  }

  it('preserves locale-prefixed routes for BCP-47 page locales', async () => {
    const result = await render({ visibility: 'public', ownerId: null, localeCode: 'en-US' })

    expect(result.html).toContain('href="/en-US/public"')
    expect(result.html).not.toContain('href="/en-US/en-US/public"')
  })
  it('resolves links from public pages against public destinations only', async () => {
    const result = await render({ visibility: 'public', ownerId: null })

    expect(result.$('a[href="/en/public"]').hasClass('is-valid-page')).toBe(true)
    for (const route of ['owned', 'foreign']) {
      const anchor = result.$(`a[href="/en/${route}"]`)
      expect(anchor.hasClass('is-invalid-page')).toBe(true)
      expect(anchor.hasClass('is-valid-page')).toBe(false)
    }
  })

  it('allows private pages to resolve only public and same-owner private destinations', async () => {
    const result = await render({ visibility: 'private', ownerId: 7 })

    for (const route of ['public', 'owned']) {
      expect(result.$(`a[href="/en/${route}"]`).hasClass('is-valid-page')).toBe(true)
    }
    const foreign = result.$('a[href="/en/foreign"]')
    expect(foreign.hasClass('is-invalid-page')).toBe(true)
    expect(foreign.hasClass('is-valid-page')).toBe(false)
  })
})
