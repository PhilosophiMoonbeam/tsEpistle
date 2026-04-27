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

  const paramsStart = script.indexOf('(', methodStart)
  let paramsDepth = 0
  let bodyStart = -1

  for (let idx = paramsStart; idx < script.length; idx++) {
    if (script[idx] === '(') {
      paramsDepth++
    } else if (script[idx] === ')') {
      paramsDepth--

      if (paramsDepth === 0) {
        bodyStart = script.indexOf('{', idx)
        break
      }
    }
  }

  if (bodyStart === -1) {
    return null
  }

  let bodyDepth = 0

  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      bodyDepth++
    } else if (script[idx] === '}') {
      bodyDepth--

      if (bodyDepth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-system loadInfo/refresh root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-system.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadInfo = script && extractMethod(script, 'loadInfo')
  const refresh = script && extractMethod(script, 'refresh')
  const performUpgrade = script && extractMethod(script, 'performUpgrade')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-system.vue imports the root UI facades required by loadInfo() and refresh()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{\s*fetchSystemInfo\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/
    )
  })

  test('loadInfo() uses loading and error facades while preserving fetch assignment, boolean return, and cleanup behavior', () => {
    expect(loadInfo).not.toBeNull()

    expect(loadInfo).toMatch(/async\s+loadInfo\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-system-refresh['"]\s*\)\s*try\s*\{\s*this\.info\s*=\s*await\s+fetchSystemInfo\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]System info response is invalid['"]\s*\)\s*return\s+true\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*return\s+false\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-system-refresh['"]\s*\)\s*\}\s*\}/)
    expect(loadInfo).not.toMatch(directRootUiCommit)

    expect(loadInfo.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh() only shows the success notification through the facade after a successful loadInfo()', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*const\s+loaded\s*=\s*await\s+this\.loadInfo\s*\(\s*\)\s*if\s*\(\s*!loaded\s*\)\s*\{\s*return\s+false\s*\}\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:system\.refreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*return\s+true\s*\}/)
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('performUpgrade() direct store commits are intentionally out of scope for this narrow slice', () => {
    expect(performUpgrade).not.toBeNull()

    expect(performUpgrade).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStart`\s*,\s*['"]admin-system-upgrade['"]\s*\)/)
    expect(performUpgrade).toMatch(/this\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(performUpgrade).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStop`\s*,\s*['"]admin-system-upgrade['"]\s*\)/)
  })
})
