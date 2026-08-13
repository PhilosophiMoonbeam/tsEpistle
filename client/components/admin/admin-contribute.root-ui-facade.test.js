import fs from 'node:fs'
import path from 'node:path'

describe('admin-contribute root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-contribute.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-contribute.vue uses the typed wiki store for loadBackers UI state', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/async\s+loadBackers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)/)
    expect(script).toMatch(/\bloadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-contribute-refresh['"]\s*\)/)
    expect(script).toMatch(/if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*getErrorMessage\s*\(\s*err\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)/)
    expect(script).toMatch(/finally\s*\{\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-contribute-refresh['"]\s*\)\s*\}/)

    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"])\s*,/)

    const loadingStartCalls = script.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const loadingStopCalls = script.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })
})
