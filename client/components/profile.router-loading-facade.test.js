const fs = require('fs')
const path = require('path')

describe('profile router loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/profile.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]

  test('profile.vue router hooks use root-ui-store loading facades and preserve unrelated commits', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)[^}]*\}\s+from\s+['"]\.\.\/helpers\/root-ui-store['"]/)

    expect(script).toMatch(/router\.beforeEach\s*\(\s*\(\s*to\s*,\s*from\s*,\s*next\s*\)\s*=>\s*\{[\s\S]*?\bloadingStart\s*\(\s*WIKI\.\$store\s*,\s*['"]profile['"]\s*\)[\s\S]*?\bnext\s*\(\s*\)[\s\S]*?\}\s*\)/)
    expect(script).toMatch(/router\.afterEach\s*\(\s*\(\s*to\s*,\s*from\s*\)\s*=>\s*\{[\s\S]*?\bloadingStop\s*\(\s*WIKI\.\$store\s*,\s*['"]profile['"]\s*\)[\s\S]*?\}\s*\)/)

    expect(script).not.toMatch(/WIKI\.\$store\.commit\(\s*['"]loading(?:Start|Stop)['"]\s*,\s*['"]profile['"]\s*\)/)
    expect(script).toMatch(/this\.\$store\.commit\(\s*['"]page\/SET_MODE['"]\s*,\s*['"]profile['"]\s*\)/)

    const loadingStartCalls = script.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const loadingStopCalls = script.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })
})
