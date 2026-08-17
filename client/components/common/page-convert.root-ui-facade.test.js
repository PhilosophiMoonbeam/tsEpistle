import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/page-convert.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)[1]

describe('page-convert REST migration guard', () => {
  test('converts pages through the REST helper from a TypeScript component', () => {
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { convertPage } from '../../helpers/pages-api'")
    expect(script).toContain('await convertPage(window.fetch.bind(window), this.pageId, this.newEditor, this.pageSourceRevision)')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves loading, errors, dialog close, and redirect behavior through wikiStore', () => {
    expect(script).toMatch(/async\s+convertPage\s*\(\s*\)\s*:\s*Promise<void>\s*\{\s*this\.loading\s*=\s*true\s*wikiStore\.startLoading\s*\(\s*['"]page-convert['"]\s*\)/)
    expect(script).toContain('this.isShown = false')
    expect(script).toMatch(/window\.location\.assign\(`\/e\/\$\{this\.pageLocale\}\/\$\{this\.pagePath\}`\)/)
    expect(script).toContain('wikiStore.showError(err)')
    expect(script).toContain("wikiStore.stopLoading('page-convert')")
    expect(script).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]page-convert['"]\s*\)\s*this\.loading\s*=\s*false/)
  })
})
