const fs = require('fs')
const path = require('path')

describe('profile pages root UI facade migration guard', () => {
  const pagesPath = path.join(process.cwd(), 'client/components/profile/pages.vue')
  const source = fs.readFileSync(pagesPath, 'utf8')

  test('pages.vue imports and uses root-ui-store facades instead of direct root UI commits', () => {
    expect(source).toMatch(/import\s+\{(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(source).toMatch(/\bshowNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\(\s*['"]profile:pages\.refreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/)
    expect(source).not.toMatch(/this\.\$store\.commit\(\s*['"]showNotification['"]\s*,/)

    expect(source).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*isLoading[\s\S]*?setLoading\s*\(\s*this\.\$store\s*,\s*['"]profile-pages-refresh['"]\s*,\s*isLoading\s*\)/)
    expect(source).not.toMatch(/this\.\$store\.commit\(\s*(?:`loading|['"]loading(?:Start|Stop)['"])/)

    expect(source).toMatch(/creatorId:\s*this\.\$store\.get\(\s*['"]user\/id['"]\s*\)/)
    expect(source).toMatch(/authorId:\s*this\.\$store\.get\(\s*['"]user\/id['"]\s*\)/)

    const showNotificationCalls = source.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)

    const setLoadingCalls = source.match(/\bsetLoading\s*\(/g) || []
    expect(setLoadingCalls).toHaveLength(1)
  })
})
