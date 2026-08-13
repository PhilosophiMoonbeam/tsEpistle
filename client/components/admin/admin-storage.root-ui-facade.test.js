import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`))

  if (methodStart === -1) {
    return null
  }

  const openBrace = script.indexOf('{', methodStart)

  if (openBrace === -1) {
    return null
  }

  let depth = 0

  for (let idx = openBrace; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--

      if (depth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-storage REST loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-storage.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const normalizeTargets = script && extractMethod(script, 'normalizeTargets')
  const loadTargets = script && extractMethod(script, 'loadTargets')
  const loadStatus = script && extractMethod(script, 'loadStatus')

  test('admin-storage.vue routes REST refresh loading through root-ui-store setLoading', () => {
    expect(script).not.toBeNull()
    expect(normalizeTargets).not.toBeNull()
    expect(loadTargets).not.toBeNull()
    expect(loadStatus).not.toBeNull()

    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchStorageStatus\b)(?=[^}]*\bfetchStorageTargets\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/)

    expect(normalizeTargets).toMatch(/normalizeTargets\s*\(\s*targets:\s*StorageTarget\[\]\s*\):\s*NormalizedStorageTarget\[\]/)
    expect(normalizeTargets).toMatch(/_\.cloneDeep\s*\(\s*targets\s*\)\.map\s*\(\s*target\s*=>\s*\(\s*\{/)
    expect(normalizeTargets).toContain('...target')
    expect(normalizeTargets).toContain('value: JSON.parse(config.value) as StorageConfigValue')
    expect(normalizeTargets).toMatch(/_\.sortBy\s*\(\s*target\.config\.map\s*\(\s*config\s*=>/)
    expect(normalizeTargets).toMatch(/\[\s*config\s*=>\s*config\.value\.order\s*\]/)

    expect(loadTargets).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-storage-targets-refresh['"]\s*,\s*true\s*\)/)
    expect(loadTargets).toMatch(/fetchStorageTargets\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(loadTargets).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-storage-targets-refresh['"]\s*,\s*false\s*\)/)

    expect(loadStatus).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-storage-status-refresh['"]\s*,\s*true\s*\)/)
    expect(loadStatus).toMatch(/fetchStorageStatus\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(loadStatus).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-storage-status-refresh['"]\s*,\s*false\s*\)/)

    expect(script).not.toContain('apollo:')
    expect(script).not.toContain('targetsQuery')
    expect(script).not.toContain('statusQuery')
    expect(script).not.toMatch(/\$store\.commit\(\s*`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`\s*,/)
    expect(script).not.toMatch(/\$store\.commit\(\s*['"]loading(?:Start|Stop)['"]\s*,/)
  })
})
