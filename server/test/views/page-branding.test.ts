import path from 'node:path'
import { runInNewContext } from 'node:vm'
import pug from 'pug'
import * as cheerio from 'cheerio'
import { describe, expect, it } from '../bun-test.mts'

const viewsPath = path.resolve('server/views')

const brandingAssignment = { assetId: 42 }
const sourceSha256 = 'a'.repeat(64)
const brandingView = {
  assetId: brandingAssignment.assetId,
  imageUrl: `/_assets/branding.png?v=${sourceSha256}`,
  sourceSha256,
  width: 320,
  height: 180,
  accent: '#AABBCC'
}

const baseLocals = {
  siteConfig: { lang: 'en' },
  pageMeta: {
    title: 'Template test page',
    description: 'Template test description',
    image: '',
    url: 'https://wiki.example.test/i/template-test'
  },
  config: {
    title: 'Template Test Wiki',
    theming: { iconset: 'md' },
    nav: { mode: 'MIXED', expandParent: true },
    editShortcuts: { editFab: true, editMenuBar: false, editMenuBtn: true }
  },
  faviconUrl: '/favicon.ico',
  langs: [],
  devMode: false,
  vite: { client: '', css: [], preloads: [], file: '/assets/app.js' },
  analyticsCode: { head: '', bodyStart: '', bodyEnd: '' },
  injectCode: { css: '', head: '', body: '' },
  comments: { codeTemplate: '', head: '', body: '', main: '' },
  commentsEnabled: false,
  spaNavigation: false,
  sidebar: [],
  effectivePermissions: {},
  pageFilename: 'en/template-test.md'
}

const page = {
  id: 7,
  localeCode: 'en',
  path: 'template-test',
  title: 'Branded & payload page',
  description: 'A rendered page',
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  sourceRevision: 'revision-1',
  authorName: 'Template Author',
  authorId: 9,
  editorKey: 'markdown',
  isPublished: true,
  visibility: 'public',
  toc: '[]',
  render: '<p>Rendered page</p>',
  ownerId: 9,
  publishStartDate: null,
  publishEndDate: null,
  extra: { css: '', js: '' },
  mode: 'edit',
  content: 'VGVzdCBjb250ZW50',
  pageFilename: 'en/template-test.md'
}

const renderView = (name: 'page' | 'editor', locals: Record<string, unknown> = {}): string =>
  pug.renderFile(path.join(viewsPath, `${name}.pug`), { ...baseLocals, page, ...locals })

const pagePayload = (html: string): { props: { title: string; branding: unknown } } => {
  const payload = cheerio.load(html)('wiki-page').attr('payload')
  expect(payload).toBeDefined()
  return JSON.parse(Buffer.from(payload!, 'base64').toString('utf8')) as { props: { title: string; branding: unknown } }
}

const jsonAttribute = ($editor: cheerio.Cheerio<cheerio.Element>, name: string): unknown => {
  const value = $editor.attr(name)
  return value === undefined ? null : JSON.parse(value)
}

describe('page and editor branding template mounts', () => {
  it('paints the saved appearance before application modules run, independent of device mode', () => {
    for (const [initialAppearance, systemDark, expected] of [
      ['light', true, 'light'],
      ['dark', false, 'dark'],
      ['system', true, 'dark'],
      ['system', false, 'light']
    ] as const) {
      const themeColors = { light: { background: '#FAFAFA' }, dark: { background: '#121212' } }
      const html = renderView('page', { siteConfig: { lang: 'en', initialAppearance, themeColors } })
      const style: Record<string, string> = {}
      const context = {
        document: { documentElement: { style } },
        window: { matchMedia: () => ({ matches: systemDark }) }
      }
      cheerio.load(html)('head script:not([src])').each((_index, element) => {
        runInNewContext(cheerio.load(element).text(), context)
      })
      expect(style.colorScheme).toBe(expected)
      expect(style.backgroundColor).toBe(themeColors[expected].background)
    }
  })

  it('renders page.pug through master.pug with a decodable branded payload', () => {
    const payload = pagePayload(renderView('page', { branding: brandingView }))

    expect(payload.props.title).toBe(page.title)
    expect(payload.props.branding).toEqual(brandingView)
  })

  it('keeps a null page branding payload at the mount boundary', () => {
    const payload = pagePayload(renderView('page', { branding: null }))

    expect(payload.props.title).toBe(page.title)
    expect(payload.props.branding).toBeNull()
  })

  it('renders editor.pug through master.pug with escaped structured branding attributes', () => {
    const $editor = cheerio.load(renderView('editor', { brandingAssignment, branding: brandingView }))('editor')

    expect($editor).toHaveLength(1)
    expect(jsonAttribute($editor, ':branding-assignment')).toEqual(brandingAssignment)
    expect(jsonAttribute($editor, ':branding-view')).toEqual(brandingView)
  })

  it('keeps null editor branding assignments and views at the mount boundary', () => {
    const $editor = cheerio.load(renderView('editor', { brandingAssignment: null, branding: null }))('editor')

    expect($editor).toHaveLength(1)
    expect(jsonAttribute($editor, ':branding-assignment')).toBeNull()
    expect(jsonAttribute($editor, ':branding-view')).toBeNull()
  })
})
