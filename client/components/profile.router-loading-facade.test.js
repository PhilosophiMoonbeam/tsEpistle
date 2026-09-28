import fs from 'node:fs'
import path from 'node:path'

describe('profile router loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/profile.vue')
  const componentSource = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = componentSource.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const componentScript = scriptMatch && scriptMatch[1]
  const routerSource = fs.readFileSync(path.join(process.cwd(), 'client/router.ts'), 'utf8')

  test('keeps profile mode and accessible route-heading focus behind the root UI facade', () => {
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
    expect(routerSource).toMatch(/\bloadingStart\s*\(\s*wikiStore\s*,\s*profileLoadingKey\s*\)/)
    expect(routerSource).toMatch(/\bloadingStop\s*\(\s*wikiStore\s*,\s*profileLoadingKey\s*\)/)
    expect(componentScript).not.toContain('WIKI.$store')
    expect(routerSource).not.toContain('WIKI.$store')
  })
})
