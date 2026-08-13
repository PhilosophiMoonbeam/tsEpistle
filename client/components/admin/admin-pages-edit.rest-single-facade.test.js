import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-pages-edit.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
const loadPageStart = script.indexOf('async loadPage () {')
const loadPageEnd = script.indexOf('    async deletePage', loadPageStart)
const loadPageBody = script.slice(loadPageStart, loadPageEnd)

describe('admin pages edit REST single facade', () => {
  it('loads page details through the pages REST helper instead of Apollo', () => {
    expect(script).toContain("import { deletePage as deletePageById, fetchPage, type PageDetails } from '../../helpers/pages-api'")
    expect(script).not.toContain('pages-query-single.gql')
    expect(script).not.toContain('pageQuery')
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
    expect(loadPageBody).toContain('await fetchPage(')
    expect(loadPageBody).toContain('window.fetch.bind(window)')
    expect(loadPageBody).toContain('_.toSafeInteger(this.$route.params.id)')
  })

  it('preserves page detail loading and graph error behavior', () => {
    expect(loadPageBody).toContain('this.loading = true')
    expect(loadPageBody).toContain("wikiStore.startLoading('admin-pages-refresh')")
    expect(loadPageBody).toContain("wikiStore.stopLoading('admin-pages-refresh')")
    expect(loadPageBody).toContain('wikiStore.showError(err)')
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPage\(\)\s*\}/)
  })
})
