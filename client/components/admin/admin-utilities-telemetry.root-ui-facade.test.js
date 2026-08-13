import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractBlock = (source, startIndex, openingBraceIndex) => {
  const bodyStart = openingBraceIndex === undefined ? source.indexOf('{', startIndex) : openingBraceIndex
  if (bodyStart === -1) { return null }

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
  if (methodStart === -1) { return null }

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

  return extractBlock(script, methodStart, bodyStart)
}

describe('admin utilities telemetry REST and root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-telemetry.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadTelemetry = script && extractMethod(script, 'loadTelemetry')
  const updateTelemetry = script && extractMethod(script, 'updateTelemetry')
  const resetClientId = script && extractMethod(script, 'resetClientId')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-telemetry.vue imports REST helpers and the typed wiki store', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{\s*defineComponent\s*\}\s+from\s+['"]vue['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchSystemTelemetry\b)(?=[^}]*\bresetSystemTelemetryClientId\b)(?=[^}]*\bupdateSystemTelemetry\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).not.toMatch(/utilities-mutation-telemetry-(?:resetid|set)\.gql/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
    expect(script).not.toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
  })

  test('loadTelemetry preserves refresh loading, REST fetch, notifyError, rethrow, and cleanup behavior', () => {
    expect(loadTelemetry).not.toBeNull()
    expect(loadTelemetry).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-telemetry-refresh['"]\s*\)/)
    expect(loadTelemetry).toMatch(/fetchSystemTelemetry\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*\)/)
    expect(loadTelemetry).toMatch(/this\.telemetry\s*=\s*telemetryState\.telemetry/)
    expect(loadTelemetry).toMatch(/this\.clientId\s*=\s*telemetryState\.telemetryClientId\s*\|\|\s*['"]N\/A['"]/)
    expect(loadTelemetry).toMatch(/if\s*\(\s*notifyError\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}\s*throw\s+err/)
    expect(loadTelemetry).toMatch(/finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-telemetry-refresh['"]\s*\)\s*\}/)
    expect(loadTelemetry).not.toMatch(directRootUiCommit)
  })

  test('updateTelemetry uses REST helper while preserving loading, notification, and error behavior', () => {
    expect(updateTelemetry).not.toBeNull()
    expect(updateTelemetry).toMatch(/this\.loading\s*=\s*true/)
    expect(updateTelemetry).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-telemetry-set['"]\s*\)/)
    expect(updateTelemetry).toMatch(/await\s+updateSystemTelemetry\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.telemetry\s*\)/)
    expect(updateTelemetry).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Telemetry updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(updateTelemetry).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}/)
    expect(updateTelemetry).toMatch(/finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-telemetry-set['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(updateTelemetry).not.toMatch(directRootUiCommit)
  })

  test('resetClientId uses REST helper while preserving silent reload, notification, and cleanup behavior', () => {
    expect(resetClientId).not.toBeNull()
    expect(resetClientId).toMatch(/this\.loading\s*=\s*true/)
    expect(resetClientId).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-telemetry-resetid['"]\s*\)/)
    expect(resetClientId).toMatch(/await\s+resetSystemTelemetryClientId\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*\)/)
    expect(resetClientId).toMatch(/await\s+this\.loadTelemetry\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)/)
    expect(resetClientId).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Telemetry Client ID reset successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(resetClientId).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}/)
    expect(resetClientId).toMatch(/finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-telemetry-resetid['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(resetClientId).not.toMatch(directRootUiCommit)
  })
})
