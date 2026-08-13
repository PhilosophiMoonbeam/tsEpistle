import fs from 'node:fs'
import path from 'node:path'

describe('admin groups edit rules showNotification facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups-edit-rules.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-groups-edit-rules.vue routes only comingSoon notifications through the wiki store UI facade', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/comingSoon\s*\(\s*\)\s*\{\s*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]indigo['"]\s*,\s*message:\s*`Coming soon\.\.\.`\s*,\s*icon:\s*['"]directions_boat['"]\s*\}\s*\)/)
    expect(script).not.toMatch(/\$store\.commit\(\s*(?:`showNotification`|['"]showNotification['"])\s*,/)

    const showNotificationCalls = script.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)
  })
})
