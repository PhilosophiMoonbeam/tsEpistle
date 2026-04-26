const fs = require('fs')
const path = require('path')

describe('admin-contribute root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-contribute.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-contribute.vue uses grouped root-ui-store facades for loadBackers UI state', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/\bloadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-contribute-refresh['"]\s*\)/)
    expect(script).toMatch(/if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*err\.message\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/)
    expect(script).toMatch(/finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-contribute-refresh['"]\s*\)\s*\}/)

    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"])\s*,/)

    const loadingStartCalls = script.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const loadingStopCalls = script.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })
})
