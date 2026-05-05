const fs = require('fs')
const path = require('path')

describe('admin-pages-visualize loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages-visualize.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
  const loadPagesStart = script.indexOf('async loadPages () {')
  const loadPagesEnd = script.indexOf('    goToPage', loadPagesStart)
  const loadPagesBody = script.slice(loadPagesStart, loadPagesEnd)

  test('admin-pages-visualize.vue uses root-ui-store setLoading for page visualization refresh loading', () => {
    expect(source).toMatch(/import\s+\{[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]|import\s+\{[^}]*\bpushGraphError\b[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]|import\s+\{[^}]*\bsetLoading\b[^}]*\bpushGraphError\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(loadPagesBody).toContain("setLoading(this.$store, 'admin-pages-refresh', true)")
    expect(loadPagesBody).toContain("setLoading(this.$store, 'admin-pages-refresh', false)")

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*(?:`loading|['"]loading(?:Start|Stop)['"])/)

    const setLoadingCalls = source.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(2)
  })
})
