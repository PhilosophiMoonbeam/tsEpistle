const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'admin-pages-edit.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
const loadPageStart = script.indexOf('async loadPage () {')
const loadPageEnd = script.indexOf('    async deletePage', loadPageStart)
const loadPageBody = script.slice(loadPageStart, loadPageEnd)

describe('admin pages edit REST single facade', () => {
  it('loads page details through the pages REST helper instead of Apollo', () => {
    expect(script).toContain("import { deletePage as deletePageById, fetchPage } from '../../helpers/pages-api'")
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
    expect(loadPageBody).toContain("this.$store.commit(`loadingStart`, 'admin-pages-refresh')")
    expect(loadPageBody).toContain("this.$store.commit(`loadingStop`, 'admin-pages-refresh')")
    expect(loadPageBody).toContain("this.$store.commit('pushGraphError', err)")
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPage\(\)\s*\}/)
  })
})
