const fs = require('fs')
const path = require('path')

describe('admin logging console showNotification facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-logging-console.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-logging-console.vue uses root-ui-store showNotification for subscription errors', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{[^}]*\bshowNotification\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/\bshowNotification\s*\(\s*self\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*error\.message\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)/)
    expect(script).not.toMatch(/\bself\.\$store\.commit\(\s*['"]showNotification['"]\s*,/)
    expect(script).not.toMatch(/\$store\.commit\(\s*['"]showNotification['"]\s*,/)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)
  })
})
