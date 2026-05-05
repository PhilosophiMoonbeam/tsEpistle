const fs = require('fs')
const path = require('path')

const componentPath = path.join(__dirname, 'admin-pages-visualize.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
const loadPagesStart = script.indexOf('async loadPages () {')
const loadPagesEnd = script.indexOf('    goToPage', loadPagesStart)
const loadPagesBody = script.slice(loadPagesStart, loadPagesEnd)

describe('admin pages visualize REST facade', () => {
  it('loads page links through the pages REST helper instead of Apollo', () => {
    expect(script).toContain("import { fetchPageLinks } from '../../helpers/pages-api'")
    expect(script).toContain("import { pushGraphError, setLoading } from '../../helpers/root-ui-store'")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
    expect(script).not.toContain('pages {')
    expect(loadPagesBody).toContain('await fetchPageLinks(')
    expect(loadPagesBody).toContain('window.fetch.bind(window)')
    expect(loadPagesBody).toContain('this.currentLocale')
  })

  it('preserves loading and graph error behavior for page links loading', () => {
    expect(loadPagesBody).toContain("setLoading(this.$store, 'admin-pages-refresh', true)")
    expect(loadPagesBody).toContain("setLoading(this.$store, 'admin-pages-refresh', false)")
    expect(loadPagesBody).toContain('pushGraphError(this.$store, err)')
    expect(script).toMatch(/currentLocale\s*\(\)\s*\{\s*this\.loadPages\(\)\s*\}/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPages\(\)\s*\}/)
  })
})
