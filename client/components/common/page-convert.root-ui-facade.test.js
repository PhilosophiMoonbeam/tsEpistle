const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/common/page-convert.vue'), 'utf8')
const script = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1]

describe('page-convert REST migration guard', () => {
  test('converts pages through the REST helper', () => {
    expect(script).toContain("import { convertPage } from '../../helpers/pages-api'")
    expect(script).toContain('await convertPage(window.fetch.bind(window), this.pageId, this.newEditor)')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves loading, errors, dialog close, and redirect behavior', () => {
    expect(script).toContain("loadingStart(this.$store, 'page-convert')")
    expect(script).toContain('this.isShown = false')
    expect(script).toMatch(/window\.location\.assign\(`\/e\/\$\{this\.pageLocale\}\/\$\{this\.pagePath\}`\)/)
    expect(script).toContain('pushGraphError(this.$store, err)')
    expect(script).toContain("loadingStop(this.$store, 'page-convert')")
    expect(script).toContain('this.loading = false')
  })
})
