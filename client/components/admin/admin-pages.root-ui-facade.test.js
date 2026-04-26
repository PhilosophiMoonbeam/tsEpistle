const fs = require('fs')
const path = require('path')

describe('admin-pages root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-pages.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-pages.vue uses root-ui-store facades for refresh notification and Apollo loading', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bshowNotification\b)(?=[^}]*\bsetLoading\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/\bshowNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Page list has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`showNotification`|['"]showNotification['"])\s*,/)

    expect(script).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*isLoading[\s\S]*?setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-pages-refresh['"]\s*,\s*isLoading\s*\)/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`|`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"])\s*,/)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const setLoadingCalls = script.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(1)
  })
})
