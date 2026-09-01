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

  test('preserves the conversion reentry guard, loading ownership, errors, dialog close, and scoped redirect', () => {
    expect(script).toContain('if (!this.canConvert || this.loading) return')
    expect(script).toMatch(
      /this\.loading\s*=\s*true\s+wikiStore\.startLoading\s*\(\s*['"]page-convert['"]\s*\)\s+try\s*\{\s+await convertPage\(window\.fetch\.bind\(window\), this\.pageId, this\.newEditor, this\.pageSourceRevision\)/
    )
    expect(script).toMatch(/await convertPage[\s\S]*?this\.isShown = false/)
    expect(script).toContain("const scope = this.pageVisibility === 'private' ? '/_private' : ''")
    expect(script).toMatch(/window\.location\.assign\s*\(\s*`\/e\$\{scope\}\/\$\{this\.pageLocale\}\/\$\{this\.pagePath\}`\s*\)/)
    expect(script).toContain('wikiStore.showError(err)')
    expect(script).toMatch(/finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]page-convert['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
  })
})
