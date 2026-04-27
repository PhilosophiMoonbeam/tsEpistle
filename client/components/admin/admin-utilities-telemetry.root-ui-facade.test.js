const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractBlock = (source, startIndex, openingBraceIndex) => {
  const bodyStart = openingBraceIndex === undefined ? source.indexOf('{', startIndex) : openingBraceIndex

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
        return source.slice(startIndex, idx + 1)
      }
    }
  }

  return null
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

  return extractBlock(script, methodStart, bodyStart)
}

describe('admin utilities telemetry root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-telemetry.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadTelemetry = script && extractMethod(script, 'loadTelemetry')
  const updateTelemetry = script && extractMethod(script, 'updateTelemetry')
  const resetClientId = script && extractMethod(script, 'resetClientId')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-telemetry.vue imports root UI facades while preserving telemetry dependencies', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(script).toMatch(/import\s+utilityTelemetryResetIdMutation\s+from\s+['"]gql\/admin\/utilities\/utilities-mutation-telemetry-resetid\.gql['"]/)
    expect(script).toMatch(/import\s+utilityTelemetrySetMutation\s+from\s+['"]gql\/admin\/utilities\/utilities-mutation-telemetry-set\.gql['"]/)
    expect(script).toMatch(/import\s+\{\s*fetchSystemTelemetry\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
  })

  test('loadTelemetry uses loading and error facades without changing fetch, notifyError, rethrow, or cleanup behavior', () => {
    expect(loadTelemetry).not.toBeNull()

    expect(loadTelemetry).toMatch(/async\s+loadTelemetry\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-telemetry-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?const\s+telemetryState\s*=\s*await\s+fetchSystemTelemetry\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*\)[\s\S]*?this\.telemetry\s*=\s*telemetryState\.telemetry\s*this\.clientId\s*=\s*telemetryState\.telemetryClientId\s*\|\|\s*['"]N\/A['"][\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*notifyError\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-telemetry-refresh['"]\s*\)\s*\}\s*\}/)
    expect(loadTelemetry).not.toMatch(directRootUiCommit)

    expect(loadTelemetry.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadTelemetry.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(loadTelemetry.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadTelemetry).not.toMatch(/\bshowNotification\s*\(/)
  })

  test('updateTelemetry uses loading, notification, and error facades while preserving mutation variables and response path', () => {
    expect(updateTelemetry).not.toBeNull()

    expect(updateTelemetry).toMatch(/async\s+updateTelemetry\s*\(\s*\)\s*\{\s*this\.loading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-telemetry-set['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?const\s+respRaw\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*utilityTelemetrySetMutation\s*,\s*variables:\s*\{\s*enabled:\s*this\.telemetry\s*\}\s*\}\s*\)[\s\S]*?const\s+resp\s*=\s*_\.get\s*\(\s*respRaw\s*,\s*['"]data\.system\.setTelemetry\.responseResult['"]\s*,\s*\{\s*\}\s*\)[\s\S]*?if\s*\(\s*resp\.succeeded\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Telemetry updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)\s*\}\s*else\s*\{\s*throw\s+new\s+Error\s*\(\s*resp\.message\s*\)\s*\}\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-telemetry-set['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(updateTelemetry).not.toMatch(directRootUiCommit)

    expect(updateTelemetry.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(updateTelemetry.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(updateTelemetry.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(updateTelemetry.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('resetClientId uses loading, notification, and error facades while preserving reset mutation and silent reload', () => {
    expect(resetClientId).not.toBeNull()

    expect(resetClientId).toMatch(/async\s+resetClientId\s*\(\s*\)\s*\{\s*this\.loading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-telemetry-resetid['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?const\s+respRaw\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*utilityTelemetryResetIdMutation\s*\}\s*\)[\s\S]*?const\s+resp\s*=\s*_\.get\s*\(\s*respRaw\s*,\s*['"]data\.system\.resetTelemetryClientId\.responseResult['"]\s*,\s*\{\s*\}\s*\)[\s\S]*?if\s*\(\s*resp\.succeeded\s*\)\s*\{\s*await\s+this\.loadTelemetry\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Telemetry Client ID reset successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)\s*\}\s*else\s*\{\s*throw\s+new\s+Error\s*\(\s*resp\.message\s*\)\s*\}\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-telemetry-resetid['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(resetClientId).not.toMatch(directRootUiCommit)

    expect(resetClientId.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(resetClientId.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(resetClientId.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(resetClientId.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
