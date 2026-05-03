const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`async\\s+${name}\\s*\\(`))

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

describe('admin-storage refresh root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-storage.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const refresh = script && extractMethod(script, 'refresh')

  test('refresh() routes the success notification through root-ui-store after reloading targets by REST', () => {
    expect(script).not.toBeNull()
    expect(refresh).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bsetLoading\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchStorageTargets\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/)

    expect(refresh).toMatch(/await\s+this\.loadTargets\s*\(\s*\)/)
    expect(refresh).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]List of storage targets has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/)
    expect(refresh).not.toMatch(/this\.\$apollo\.queries\.targets\.refetch/)
    expect(refresh).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)
    expect(refresh).toMatch(/await\s+this\.loadTargets\s*\(\s*\)[\s\S]*?showNotification\s*\(\s*this\.\$store\s*,/)

    const showNotificationCalls = refresh.match(/\bshowNotification\s*\(/g) || []
    expect(showNotificationCalls).toHaveLength(1)
  })

  test('admin-storage no longer contains direct root UI commits after storage facade slices', () => {
    expect(script).not.toBeNull()
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,/)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*(?:`loadingStart`|['"]loadingStart['"])\s*,/)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*(?:`loadingStop`|['"]loadingStop['"])\s*,/)
    expect(script).not.toMatch(/this\.\$store\.commit\s*\(\s*`loading\$\{isLoading\s*\?\s*['"]Start['"]\s*:\s*['"]Stop['"]\}`\s*,/)
  })
})
