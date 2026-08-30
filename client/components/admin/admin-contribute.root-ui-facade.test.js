import fs from 'node:fs'
import path from 'node:path'

describe('admin-contribute root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-contribute.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-contribute.vue preserves root UI ownership and explicit backer states', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(source).toMatch(/async-state\(\s*v-if='backersLoading'[\s\S]*?state='loading'/)
    expect(source).toMatch(/async-state\(\s*v-else-if='backersError'[\s\S]*?state='error'[\s\S]*?:message='backersError'[\s\S]*?@retry='loadBackers'/)
    expect(source).toMatch(/async-state\(\s*v-else-if='backersLoaded && backers\.length < 1'[\s\S]*?state='empty'/)
    expect(source).toMatch(/v-row\(v-else[\s\S]*?v-for='backer in backers'/)
    expect(script).toMatch(/backers:\s*\[\]\s+as\s+ContributorRow\[\],\s*backersLoading:\s*true,\s*backersLoaded:\s*false,\s*backersError:\s*(['"])\1/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadBackers\(\)\.catch\(\(\)\s*=>\s*\{\}\)\s*\}/)

    const loadBackers = script.match(/async\s+loadBackers[\s\S]*?(?=\n\s+async\s+copyAddress)/)?.[0]
    expect(loadBackers).toBeDefined()
    expect(loadBackers).toMatch(
      /async\s+loadBackers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*this\.backersLoading\s*=\s*true\s*this\.backersLoaded\s*=\s*false\s*this\.backersError\s*=\s*(['"])\1\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-contribute-refresh['"]\s*\)\s*try\s*\{/
    )
    expect(loadBackers).toMatch(
      /this\.backers\s*=\s*await\s+fetchContributors\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Contributors response is invalid['"]\s*\)\s*this\.backersLoaded\s*=\s*true\s*return\s+true/
    )
    expect(loadBackers).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*this\.backers\s*=\s*\[\]\s*this\.backersLoaded\s*=\s*true\s*this\.backersError\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.backersError,\s*style:\s*['"]red['"],\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}/
    )
    expect(loadBackers).toMatch(
      /finally\s*\{\s*this\.backersLoading\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-contribute-refresh['"]\s*\)\s*\}/
    )
    expect(loadBackers.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadBackers.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadBackers).not.toContain('$store.commit')
  })
})
