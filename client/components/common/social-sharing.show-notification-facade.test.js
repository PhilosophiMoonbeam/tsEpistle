const fs = require('fs')
const path = require('path')

describe('social-sharing showNotification facade migration guard', () => {
  const socialSharingPath = path.join(process.cwd(), 'client/components/common/social-sharing.vue')
  const source = fs.readFileSync(socialSharingPath, 'utf8')

  test('social-sharing.vue imports and uses root-ui-store showNotification for ClipboardJS notifications', () => {
    expect(source).toMatch(/import\s+\{[^}]*\bshowNotification\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(source).toMatch(/clip\.on\(\s*['"]success['"]\s*,\s*\(\s*\)\s*=>\s*\{[\s\S]*?\bshowNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`URL copied successfully`\s*,\s*icon:\s*['"]content-copy['"]\s*\}\s*\)[\s\S]*?\}\s*\)/)
    expect(source).toMatch(/clip\.on\(\s*['"]error['"]\s*,\s*\(\s*\)\s*=>\s*\{[\s\S]*?\bshowNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*`Failed to copy to clipboard`\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)[\s\S]*?\}\s*\)/)

    expect(source).not.toMatch(/this\.\$store\.commit\(\s*['"]showNotification['"]\s*,/)

    const showNotificationCalls = source.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(2)
  })
})
