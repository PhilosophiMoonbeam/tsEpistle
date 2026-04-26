const fs = require('fs')
const path = require('path')

describe('admin-pages-visualize Apollo loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages-visualize.vue')
  const source = fs.readFileSync(componentPath, 'utf8')

  test('admin-pages-visualize.vue uses root-ui-store setLoading for page visualization refresh loading', () => {
    expect(source).toMatch(/import\s+\{[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(source).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-pages-refresh['"]\s*,\s*isLoading\s*\)\s*\}/)
    expect(source).toMatch(/\bsetLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-pages-refresh['"]\s*,\s*isLoading\s*\)/)

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*(?:`loading|['"]loading(?:Start|Stop)['"])/)

    const setLoadingCalls = source.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(1)
  })
})
