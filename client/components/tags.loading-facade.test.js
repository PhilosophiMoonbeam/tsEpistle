const fs = require('fs')
const path = require('path')

describe('tags Apollo loading facade migration guard', () => {
  const tagsPath = path.join(process.cwd(), 'client/components/tags.vue')
  const source = fs.readFileSync(tagsPath, 'utf8')

  test('tags.vue imports and uses root-ui-store setLoading instead of dynamic loading commits', () => {
    expect(source).toMatch(/import\s+\{[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/helpers\/root-ui-store['"]/)

    expect(source).toMatch(/\bsetLoading\s*\(\s*this\.\$store\s*,\s*['"]tags-refresh['"]\s*,\s*isLoading\s*\)/)
    expect(source).toMatch(/\bsetLoading\s*\(\s*this\.\$store\s*,\s*['"]pages-refresh['"]\s*,\s*isLoading\s*\)/)

    expect(source).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{[\s\S]*?this\.isLoading\s*=\s*isLoading[\s\S]*?setLoading\s*\(\s*this\.\$store\s*,\s*['"]pages-refresh['"]\s*,\s*isLoading\s*\)/)

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*(?:`loading|['"]loading(?:Start|Stop)['"])/)

    const setLoadingCalls = source.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(2)
  })
})
