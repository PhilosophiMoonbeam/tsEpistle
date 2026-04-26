const fs = require('fs')
const path = require('path')

describe('admin-dev-flags root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-dev-flags.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-dev-flags.vue uses grouped root-ui-store facades for load and save root UI state', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/async\s+mounted\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-dev-flags-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?this\.flags\s*=\s*await\s+fetchSystemFlags\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]System flags response is invalid['"]\s*\)[\s\S]*?this\.flagsLoaded\s*=\s*true[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*err\.message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-dev-flags-refresh['"]\s*\)/)

    expect(script).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*if\s*\(\s*!this\.flagsLoaded\s*\)\s*\{\s*return\s*\}\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-dev-flags-update['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?await\s+updateSystemFlags\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.flags\s*,\s*['"]System flags update failed['"]\s*\)[\s\S]*?showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Flags applied successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*err\.message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-dev-flags-update['"]\s*\)/)

    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"])\s*,/)

    const loadingStartCalls = script.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(2)

    const loadingStopCalls = script.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(2)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(3)
  })
})
