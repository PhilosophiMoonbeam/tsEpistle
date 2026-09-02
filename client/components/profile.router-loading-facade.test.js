import fs from 'node:fs'
import path from 'node:path'

describe('profile router loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/profile.vue')
  const componentSource = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = componentSource.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const componentScript = scriptMatch && scriptMatch[1]
  const routerSource = fs.readFileSync(path.join(process.cwd(), 'client/router.ts'), 'utf8')

  test('profile routing owns loading per navigation and focuses route headings', () => {
    expect(componentScript).not.toBeNull()
    expect(componentSource).toContain("<script lang='ts'>")
    expect(componentScript).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(componentScript).toMatch(/created\s*\(\s*\)\s*\{\s*wikiStore\.page\.mode\s*=\s*['"]profile['"]\s*\}/)
    expect(componentSource).toMatch(/v-main\.profile-main\(ref=['"]profileMain['"] tabindex=['"]-1['"]\)/)
    expect(componentScript).toMatch(
      /['"]\$route\.fullPath['"]\s*\(\s*\)\s*\{[\s\S]*?this\.\$nextTick\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?this\.\$refs\.profileMain[\s\S]*?querySelector\s*\(\s*['"]h1['"]\s*\)[\s\S]*?heading\.setAttribute\s*\(\s*['"]tabindex['"]\s*,\s*['"]-1['"]\s*\)[\s\S]*?heading\.focus\s*\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/
    )

    expect(routerSource).toContain("import { wikiStore } from './store/index.ts'")
    expect(routerSource).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)[^}]*\}\s+from\s+['"]\.\/helpers\/root-ui-store['"]/)
    expect(routerSource).toMatch(/const\s+profileLoadingKey\s*=\s*['"]profile['"]/)
    expect(routerSource).toMatch(/const\s+profileLoadingOwners\s*=\s*new\s+WeakSet<\s*RouteLocationNormalized\s*>\s*\(\s*\)/)
    expect(routerSource).toMatch(
      /function\s+startProfileRouteLoading\s*\(\s*to:\s*RouteLocationNormalized\s*\)[^{]*\{\s*if\s*\(\s*profileLoadingOwners\.has\s*\(\s*to\s*\)\s*\)\s*return\s*profileLoadingOwners\.add\s*\(\s*to\s*\)\s*loadingStart\s*\(\s*wikiStore\s*,\s*profileLoadingKey\s*\)/
    )
    expect(routerSource).toMatch(
      /function\s+stopProfileRouteLoading\s*\(\s*to:\s*RouteLocationNormalized\s*\)[^{]*\{\s*if\s*\(\s*!profileLoadingOwners\.delete\s*\(\s*to\s*\)\s*\)\s*return\s*loadingStop\s*\(\s*wikiStore\s*,\s*profileLoadingKey\s*\)/
    )
    expect(routerSource).toMatch(/router\.beforeEach\s*\(\s*to\s*=>\s*\{\s*startProfileRouteLoading\s*\(\s*to\s*\)/)
    expect(routerSource).toMatch(/router\.afterEach\s*\(\s*\(\s*to\s*,[^)]*\)\s*=>\s*\{\s*stopProfileRouteLoading\s*\(\s*to\s*\)/)
    expect(routerSource).toMatch(
      /router\.onError\s*\(\s*\(\s*_error\s*,\s*to\s*\)\s*=>\s*\{\s*if\s*\(\s*isProfile\s*\)\s*stopProfileRouteLoading\s*\(\s*to\s*\)/
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
