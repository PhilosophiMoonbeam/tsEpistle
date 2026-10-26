import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'
import { document } from '../../test/browser-dom.mts'

// These modules import runtime-dom, which must capture the document installed by browser-dom first.
const Vue = await import('vue')
const { default: LocalizedRichText } = await import('./localized-rich-text')
const { localizationPlugin } = await import('../../modules/localization')
const resources = JSON.parse(fs.readFileSync('server/locales/en.json', 'utf8'))
const localizationApp = Vue.createApp({})
localizationApp.use(localizationPlugin)
const engine = localizationApp.config.globalProperties.$i18n
await engine.init({ lng: 'en', fallbackLng: 'en', resources: { en: resources }, initAsync: false })

const unsafeName = 'Reader <img src=x onerror="attack()"> & {{title}}'
const unsafeTitle = 'Page <script>attack()</script> & {{name}}'
const unsafeAuthor = 'Author <img src=x onerror="attack()"> & {{date}}'
const timestamp = 'October 26, 2026 12:00 UTC'
const warning = 'Are you sure you want to replace your current version with the latest remote content? Your current edits will be lost.'
const sites = [
  { file: 'comments.vue', key: 'common:comments.postingAs', text: `Posting as ${unsafeName}`, strong: unsafeName },
  { file: 'common/page-delete.vue', key: 'common:page.deleteTitle', text: `Are you sure you want to delete page ${unsafeTitle}?`, title: unsafeTitle },
  { file: 'editor/editor-modal-media.vue', key: 'editor:assets.folderNameNamingRules', text: 'Must follow the asset folder naming rules.', link: true },
  { file: 'editor/editor-modal-conflict.vue', key: 'editor:conflict.overwrite.description', text: warning, strong: 'Your current edits will be lost.' },
  { file: 'editor/tiptap/conflict.vue', key: 'editor:conflict.infoGeneric', text: `A more recent version of this page was saved by ${unsafeAuthor}, a moment ago.`, strong: unsafeAuthor, date: true },
  { file: 'editor/tiptap/conflict.vue', key: 'editor:conflict.overwrite.description', text: warning, strong: 'Your current edits will be lost.' }
]

// Compile the production Pug subtree, not a hand-copied version of its slots/markup.
// Locate by resource key so reverting a consumer to its obsolete tag still exercises the failing site.
const compileSite = site => {
  const filename = path.join(process.cwd(), 'client/components', site.file)
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
  const lines = descriptor.template.content.split('\n')
  const start = lines.findIndex(line => line.includes(`path='${site.key}'`))
  if (start < 0) throw new Error(`Missing consumer for ${site.key} in ${site.file}`)
  const indent = lines[start].match(/^\s*/)[0].length
  let end = start + 1
  while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > indent)) end += 1
  const source = lines.slice(start, end).map(line => line.slice(indent)).join('\n')
  const compiled = compileTemplate({
    source,
    filename,
    id: `localized-${site.file}-${site.key}`,
    preprocessLang: 'pug',
    preprocessOptions: { doctype: 'html' },
    compilerOptions: { mode: 'function' }
  })
  if (compiled.errors.length) throw compiled.errors[0]
  return new Function('Vue', compiled.code)(Vue)
}

const mountSite = (site, { register = true } = {}) => {
  const warnings = []
  const app = Vue.createApp({
    components: register ? { LocalizedRichText } : {},
    data: () => ({ userDisplayName: unsafeName, pageTitle: unsafeTitle, latest: { authorName: unsafeAuthor, updatedAt: timestamp } }),
    render: compileSite(site)
  })
  app.use(localizationPlugin)
  app.config.warnHandler = message => warnings.push(message)
  app.config.globalProperties.$helpers = { formatMoment: (_value, format) => format === 'LLL' ? timestamp : 'a moment ago' }
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  return { host, warnings, dispose: () => { app.unmount(); host.remove() } }
}

describe('localized rich text at actual production consumers', () => {
  for (const site of sites) {
    test(`${site.file}: ${site.key} restores the complete phrase and safe named content`, () => {
      const fixture = mountSite(site)
      try {
        expect(fixture.host.textContent).toBe(site.text)
        expect(fixture.warnings).toEqual([])
        expect(fixture.host.querySelector('i18next, localized-rich-text, img, script')).toBeNull()
        if (site.strong) expect(fixture.host.querySelector('strong')?.textContent).toBe(site.strong)
        if (site.title) expect(fixture.host.querySelector('.text-red-darken-2')?.textContent).toBe(site.title)
        if (site.link) {
          const link = fixture.host.querySelector('a')
          expect(link?.textContent).toBe('naming rules')
          expect(link?.getAttribute('href')).toBe('https://docs-beta.requarks.io/guide/assets#naming-restrictions')
          expect(link?.getAttribute('target')).toBe('_blank')
          expect(link?.getAttribute('rel')?.split(' ')).toContain('noopener')
          expect(link?.getAttribute('rel')?.split(' ')).toContain('noreferrer')
        }
        if (site.date) expect(fixture.host.querySelector('span[title]')?.getAttribute('title')).toBe(timestamp)
      } finally {
        fixture.dispose()
      }
    })
  }

  test('the app plugin language change reorders and repeats named slots without reinterpreting their text', async () => {
    // English is the bundled resource; these French resources exercise translator-controlled ordering and repetition.
    engine.addResourceBundle('fr', 'common', { comments: { postingAs: '{{name}} publie — {{name}}' } }, true, true)
    engine.addResourceBundle('fr', 'editor', { conflict: { infoGeneric: '{{date}} Version enregistrée par {{authorName}} ; auteur : {{authorName}}' } }, true, true)
    const comments = mountSite(sites[0])
    const conflict = mountSite(sites[4])
    try {
      await engine.changeLanguage('fr')
      await Vue.nextTick()
      expect(comments.host.textContent).toBe(`${unsafeName} publie — ${unsafeName}`)
      expect([...comments.host.querySelectorAll('strong')].map(node => node.textContent)).toEqual([unsafeName, unsafeName])
      expect(conflict.host.textContent).toBe(`a moment ago. Version enregistrée par ${unsafeAuthor} ; auteur : ${unsafeAuthor}`)
      expect(conflict.host.firstElementChild.firstElementChild.tagName).toBe('SPAN')
      expect([...conflict.host.querySelectorAll('strong')].map(node => node.textContent)).toEqual([unsafeAuthor, unsafeAuthor])
      expect(conflict.host.querySelector('span[title]')?.getAttribute('title')).toBe(timestamp)
      expect(comments.host.querySelector('img, script')).toBeNull()
      expect(conflict.host.querySelector('img, script')).toBeNull()
      expect([...comments.warnings, ...conflict.warnings]).toEqual([])
      await engine.changeLanguage('en')
      await Vue.nextTick()
      expect(comments.host.textContent).toBe(sites[0].text)
      expect(conflict.host.textContent).toBe(sites[4].text)
    } finally {
      comments.dispose()
      conflict.dispose()
      await engine.changeLanguage('en')
      engine.removeResourceBundle('fr', 'common')
      engine.removeResourceBundle('fr', 'editor')
    }
  })

  test('negative control: an unresolved wrapper cannot pass the complete-phrase oracle', () => {
    const fixture = mountSite(sites[0], { register: false })
    try {
      expect(fixture.warnings.some(message => message.includes('Failed to resolve component'))).toBe(true)
      expect(fixture.host.textContent).not.toBe(sites[0].text)
    } finally {
      fixture.dispose()
    }
  })
})
