const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractObjectPropertyBlock = (source, propertyName) => {
  const propertyStart = source.search(new RegExp(`\\b${propertyName}\\s*:`))

  if (propertyStart === -1) {
    return null
  }

  const bodyStart = source.indexOf('{', propertyStart)

  if (bodyStart === -1) {
    return null
  }

  let depth = 0

  for (let idx = bodyStart; idx < source.length; idx++) {
    if (source[idx] === '{') {
      depth++
    } else if (source[idx] === '}') {
      depth--

      if (depth === 0) {
        return source.slice(propertyStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-storage Apollo loading facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-storage.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const apollo = script && extractObjectPropertyBlock(script, 'apollo')
  const targets = apollo && extractObjectPropertyBlock(apollo, 'targets')
  const status = apollo && extractObjectPropertyBlock(apollo, 'status')

  test('admin-storage.vue routes only Apollo refresh loading through root-ui-store setLoading', () => {
    expect(script).not.toBeNull()
    expect(apollo).not.toBeNull()
    expect(targets).not.toBeNull()
    expect(status).not.toBeNull()

    expect(script).toMatch(/import\s+\{[^}]*\bsetLoading\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(targets).toMatch(/query:\s*targetsQuery/)
    expect(targets).toMatch(/fetchPolicy:\s*['"]network-only['"]/)
    expect(targets).toMatch(/update:\s*\(\s*data\s*\)\s*=>\s*_\.cloneDeep\s*\(\s*data\.storage\.targets\s*\)\.map\s*\(\s*str\s*=>\s*\(\s*\{[\s\S]*?\.\.\.str[\s\S]*?config:\s*_\.sortBy\s*\(\s*str\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{[\s\S]*?\.\.\.cfg[\s\S]*?value:\s*JSON\.parse\s*\(\s*cfg\.value\s*\)[\s\S]*?\}\s*\)\s*\)\s*,\s*\[\s*t\s*=>\s*t\.value\.order\s*\]\s*\)[\s\S]*?\}\s*\)\s*\)/)
    expect(targets).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-storage-targets-refresh['"]\s*,\s*isLoading\s*\)\s*\}/)

    expect(status).toMatch(/query:\s*statusQuery/)
    expect(status).toMatch(/fetchPolicy:\s*['"]network-only['"]/)
    expect(status).toMatch(/update:\s*\(\s*data\s*\)\s*=>\s*data\.storage\.status/)
    expect(status).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-storage-status-refresh['"]\s*,\s*isLoading\s*\)\s*\}/)
    expect(status).toMatch(/pollInterval:\s*3000/)

    expect(apollo).not.toMatch(/\$store\.commit\(\s*`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`\s*,/)
    expect(apollo).not.toMatch(/\$store\.commit\(\s*['"]loading(?:Start|Stop)['"]\s*,/)

    const apolloSetLoadingCalls = apollo.match(/\bsetLoading\s*\(/g) || []
    expect(apolloSetLoadingCalls).toHaveLength(2)
  })
})
