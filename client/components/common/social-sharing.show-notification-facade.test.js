import fs from 'node:fs'
import path from 'node:path'

describe('social-sharing showNotification facade migration guard', () => {
  const socialSharingPath = path.join(process.cwd(), 'client/components/common/social-sharing.vue')
  const source = fs.readFileSync(socialSharingPath, 'utf8')

  test('social-sharing.vue uses the typed wiki store for ClipboardJS notifications', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toMatch(/import\s+\{\s*defineComponent\s*,\s*type ComponentPublicInstance\s*\}\s+from\s+['"]vue['"]/)
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toMatch(/export\s+default\s+defineComponent\s*\(\s*\{/)

    expect(source).toMatch(/this\.clipboard\.on\(\s*['"]success['"]\s*,\s*\(\s*\)\s*=>\s*\{[\s\S]*?\bwikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`URL copied successfully`\s*,\s*icon:\s*['"]content-copy['"]\s*\}\s*\)[\s\S]*?\}\s*\)/)
    expect(source).toMatch(/this\.clipboard\.on\(\s*['"]error['"]\s*,\s*\(\s*\)\s*=>\s*\{[\s\S]*?\bwikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*`Failed to copy to clipboard`\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)[\s\S]*?\}\s*\)/)

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*['"]showNotification['"]\s*,/)
    expect(source).toContain('this.clipboard?.destroy()')

    const showNotificationCalls = source.match(/\bwikiStore\.showNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(2)
  })
})
