const fs = require('fs')
const path = require('path')

describe('admin-pages root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-pages.vue uses REST page list helper and root-ui-store facades', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{\s*fetchPageList\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/pages-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bshowNotification\b)(?=[^}]*\bsetLoading\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/\bshowNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Page list has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`showNotification`|['"]showNotification['"])\s*,/)

    expect(script).toMatch(/async\s+loadPages\s*\(\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*true[\s\S]*?setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-pages-refresh['"]\s*,\s*true\s*\)[\s\S]*?this\.pages\s*=\s*await\s+fetchPageList\s*\(\s*window\.fetch\.bind\(window\)\s*\)[\s\S]*?pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)[\s\S]*?setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-pages-refresh['"]\s*,\s*false\s*\)/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadPages\s*\(\s*\)\s*\}/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`|`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"])\s*,/)
    expect(script).not.toMatch(/pages-query-list\.gql|apollo\s*:|this\.\$apollo|pagesQuery/)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const setLoadingCalls = script.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(2)
  })
})
