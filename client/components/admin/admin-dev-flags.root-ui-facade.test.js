import fs from 'node:fs'
import path from 'node:path'

describe('admin-dev-flags root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-dev-flags.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('admin-dev-flags.vue preserves root UI ownership and explicit load/save states', () => {
    expect(script).not.toBeNull()

    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toMatch(/async-state\(\s*v-if='loading'[\s\S]*?state='loading'/)
    expect(source).toMatch(/async-state\(\s*v-else-if='errorMessage'[\s\S]*?state='error'[\s\S]*?:message='errorMessage'[\s\S]*?@retry='loadFlags'/)
    expect(source).toMatch(/template\(v-else-if='flagsLoaded'\)[\s\S]*?v-model='flags\.ldapdebug'[\s\S]*?v-model='flags\.sqllog'/)
    expect(source).not.toMatch(/template\(v-else\)/)
    expect(source).toMatch(/v-btn\([\s\S]*?:disabled=['"]!flagsLoaded \|\| loading \|\| saving['"][\s\S]*?:loading=['"]saving['"]/)
    expect(script).toMatch(/flagsLoaded:\s*false,\s*loading:\s*false,\s*saving:\s*false,\s*errorMessage:\s*(['"])\1/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.loadFlags\(\)\s*\}/)

    const loadFlags = script.match(/async\s+loadFlags[\s\S]*?(?=\n\s+async\s+save)/)?.[0]
    expect(loadFlags).toBeDefined()
    expect(loadFlags).toMatch(
      /async\s+loadFlags\s*\(\s*\)\s*\{\s*if\s*\(\s*this\.loading\s*\|\|\s*this\.saving\s*\)\s*\{\s*return\s+false\s*\}\s*this\.loading\s*=\s*true\s*this\.errorMessage\s*=\s*(['"])\1\s*this\.flagsLoaded\s*=\s*false\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-dev-flags-refresh['"]\s*\)\s*try\s*\{/
    )
    expect(loadFlags).toMatch(
      /this\.flags\s*=\s*await\s+fetchSystemFlags\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]System flags response is invalid['"]\s*\)\s*this\.flagsLoaded\s*=\s*true\s*return\s+true/
    )
    expect(loadFlags).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*showNotification\s*\(\s*wikiStore\s*,\s*\{\s*style:\s*['"]red['"],\s*message:\s*this\.errorMessage,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*return\s+false\s*\}/
    )
    expect(loadFlags).toMatch(/finally\s*\{\s*this\.loading\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-dev-flags-refresh['"]\s*\)\s*\}/)

    const save = script.match(/async\s+save[\s\S]*?(?=\n\s+\}\n\})/)?.[0]
    expect(save).toBeDefined()
    expect(save).toMatch(
      /async\s+save\s*\(\s*\)\s*\{\s*if\s*\(\s*!this\.flagsLoaded\s*\|\|\s*this\.loading\s*\|\|\s*this\.saving\s*\)\s*\{\s*return\s*\}\s*this\.saving\s*=\s*true\s*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-dev-flags-update['"]\s*\)\s*try\s*\{/
    )
    expect(save).toMatch(
      /await\s+updateSystemFlags\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.flags\s*,\s*['"]System flags update failed['"]\s*\)[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{\s*style:\s*['"]success['"],\s*message:\s*['"]Flags applied successfully\.['"],\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?message:\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?\}\s*finally\s*\{\s*this\.saving\s*=\s*false\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-dev-flags-update['"]\s*\)\s*\}/
    )
    expect(loadFlags.match(/\bloading(?:Start|Stop)\s*\(/g) || []).toHaveLength(2)
    expect(save.match(/\bloading(?:Start|Stop)\s*\(/g) || []).toHaveLength(2)
    expect(script).not.toContain('$store.commit')
  })
})
