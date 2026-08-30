import fs from 'node:fs'
import path from 'node:path'

describe('profile router loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/profile.vue')
  const componentSource = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = componentSource.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const componentScript = scriptMatch && scriptMatch[1]
  const routerSource = fs.readFileSync(path.join(process.cwd(), 'client/router.ts'), 'utf8')

  test('profile routing uses root UI loading facades and preserves profile mode state', () => {
    expect(componentScript).not.toBeNull()
    expect(componentSource).toContain("<script lang='ts'>")
    expect(componentScript).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(componentScript).toMatch(/created\s*\(\s*\)\s*\{\s*wikiStore\.page\.mode\s*=\s*['"]profile['"]\s*\}/)

    expect(routerSource).toContain("import { wikiStore } from './store/index.ts'")
    expect(routerSource).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)[^}]*\}\s+from\s+['"]\.\/helpers\/root-ui-store['"]/)
    expect(routerSource).toMatch(/const\s+profileLoadingKey\s*=\s*['"]profile['"]/)
    expect(routerSource).toMatch(
      /if\s*\(\s*isProfile\s*\)\s*\{\s*router\.beforeEach\s*\(\s*\(\s*\)\s*=>\s*\{\s*loadingStart\s*\(\s*wikiStore\s*,\s*profileLoadingKey\s*\)\s*\}\s*\)\s*router\.afterEach\s*\(\s*\(\s*\)\s*=>\s*\{\s*loadingStop\s*\(\s*wikiStore\s*,\s*profileLoadingKey\s*\)\s*\}\s*\)\s*\}/
    )

    expect(componentScript).not.toMatch(/\/\*\s*global\s+WIKI\s*\*\//)
    expect(componentScript).not.toContain('WIKI.$store')
    expect(routerSource).not.toContain('WIKI.$store')

    const loadingStartCalls = routerSource.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const loadingStopCalls = routerSource.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })
})
