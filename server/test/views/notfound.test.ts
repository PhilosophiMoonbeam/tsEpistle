import path from 'node:path'
import pug from 'pug'
import * as cheerio from 'cheerio'
import { describe, expect, it } from '../bun-test.mts'

const viewsPath = path.resolve('server/views')

const locals = {
  siteConfig: { lang: 'en', product: { revision: 'c'.repeat(40) } },
  pageMeta: { title: 'Page Not Found', description: '', image: '', url: '' },
  config: { title: 'Test Wiki', theming: { iconset: 'md' } },
  faviconUrl: '/favicon.ico',
  langs: [],
  devMode: false,
  vite: { client: '', css: [], preloads: [], file: '/assets/app.js' },
  analyticsCode: { head: '', bodyStart: '', bodyEnd: '' },
  injectCode: { css: '', head: '', body: '' }
}

const notFoundMount = (extra: Record<string, unknown>) => cheerio.load(pug.renderFile(path.join(viewsPath, 'notfound.pug'), { ...locals, ...extra }))('not-found')

describe('not-found view mount', () => {
  it('passes the editor link only when the server set one', () => {
    expect(notFoundMount({ action: 'history', createHref: '/e/en/guides/new%20guide' }).attr('create-href')).toBe('/e/en/guides/new%20guide')
    const withoutLink = notFoundMount({ action: 'history' })
    expect(withoutLink).toHaveLength(1)
    expect(withoutLink.attr('create-href')).toBeUndefined()
  })
})
