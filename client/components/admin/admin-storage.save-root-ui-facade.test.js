const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (source, signaturePattern) => {
  const signatureMatch = signaturePattern.exec(source)

  if (!signatureMatch) {
    return null
  }

  const start = signatureMatch.index
  const openBrace = source.indexOf('{', start)

  if (openBrace === -1) {
    return null
  }

  let depth = 0

  for (let idx = openBrace; idx < source.length; idx++) {
    if (source[idx] === '{') {
      depth++
    } else if (source[idx] === '}') {
      depth--

      if (depth === 0) {
        return source.slice(start, idx + 1)
      }
    }
  }

  return null
}

describe('admin-storage save root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-storage.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const saveMethod = script && extractMethod(script, /async\s+save\s*\(\s*\)\s*\{/)
  const payloadMethod = script && extractMethod(script, /storageTargetsPayload\s*\(\s*\)\s*\{/)

  test('save() uses root-ui-store facades for save-only root UI commits', () => {
    expect(script).not.toBeNull()
    expect(saveMethod).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bsetLoading\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bsaveStorageTargets\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/)

    expect(saveMethod).toMatch(/\bloadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)
    expect(saveMethod).toMatch(/\bshowNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Storage configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(saveMethod).toMatch(/\bloadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)

    expect(saveMethod).not.toMatch(/this\.\$store\.commit\s*\(\s*`loadingStart`\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)
    expect(saveMethod).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]loadingStart['"]\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)
    expect(saveMethod).not.toMatch(/this\.\$store\.commit\s*\(\s*`loadingStop`\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)
    expect(saveMethod).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]loadingStop['"]\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)
    expect(saveMethod).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)
  })

  test('save() preserves target payload and config serialization through REST helper', () => {
    expect(saveMethod).not.toBeNull()
    expect(payloadMethod).not.toBeNull()

    expect(saveMethod).toMatch(/await\s+saveStorageTargets\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.storageTargetsPayload\s*\(\s*\)\s*\)/)
    expect(payloadMethod).toMatch(/return\s+this\.targets\.map\s*\(\s*tgt\s*=>\s*_\.pick\s*\(\s*tgt\s*,\s*\[\s*['"]isEnabled['"]\s*,\s*['"]key['"]\s*,\s*['"]config['"]\s*,\s*['"]mode['"]\s*,\s*['"]syncInterval['"]\s*\]\s*\)\s*\)\.map\s*\(\s*str\s*=>\s*\(\s*\{\s*\.\.\.str\s*,\s*config:\s*str\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/)
    expect(payloadMethod).not.toMatch(/JSON\.stringify\s*\(\s*cfg\.value\.value\s*\)/)
    expect(payloadMethod).not.toMatch(/config:\s*str\.config(?!\.map)/)
    expect(saveMethod).not.toMatch(/this\.\$apollo\.mutate/)
  })

  test('save() preserves operation ordering around REST save', () => {
    expect(saveMethod).not.toBeNull()

    expect(saveMethod).toMatch(/\bloadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-storage-savetargets['"]\s*\)[\s\S]*?await\s+saveStorageTargets/)
    expect(saveMethod).toMatch(/await\s+saveStorageTargets[\s\S]*?\bshowNotification\s*\(\s*this\.\$store\s*,/)
    expect(saveMethod).toMatch(/\bshowNotification\s*\(\s*this\.\$store\s*,[\s\S]*?\bloadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-storage-savetargets['"]\s*\)/)
  })
})
