import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

  return extractBlock(script, methodStart, bodyStart)
}

const expectInOrder = (source, snippets) => {
  let offset = 0
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, offset)
    expect(index).toBeGreaterThanOrEqual(0)
    offset = index + snippet.length
  }
}

describe('admin utilities telemetry REST and root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-telemetry.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadTelemetry = script && extractMethod(script, 'loadTelemetry')
  const updateTelemetry = script && extractMethod(script, 'updateTelemetry')
  const resetClientId = script && extractMethod(script, 'resetClientId')
  const copyClientId = script && extractMethod(script, 'copyClientId')
  const beforeUnmountStart = script ? script.search(/\bbeforeUnmount\s*\(/) : -1
  const beforeUnmount = beforeUnmountStart >= 0 ? extractBlock(script, beforeUnmountStart) : null
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-telemetry.vue imports REST helpers and exposes truthful load and mutation state', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{\s*defineComponent\s*\}\s+from\s+['"]vue['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSystemTelemetry\b)(?=[^}]*\bresetSystemTelemetryClientId\b)(?=[^}]*\bupdateSystemTelemetry\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/
    )
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(source).toContain("v-if='!loaded && !loadError'")
    expect(source).toContain("v-if='loadError'")
    expect(source).toContain(":loading='loading && activeMutation === `save`'")
    expect(source).toContain(":loading='loading && activeMutation === `reset`'")
    expect(source).toMatch(/v-btn\(\s*type=['"]button['"][\s\S]*?@click=['"]copyClientId['"][\s\S]*?aria-label=['"]Copy telemetry client ID['"]\s*\)/)
    expect(source).toContain(
      "v-btn.px-3(type='submit', variant=\"flat\", color='primary', :loading='loading && activeMutation === `save`', :disabled='!loaded || loading')"
    )
    expect(source).toContain(
      "v-btn.px-3(type='button', variant=\"outlined\", color='grey', @click='resetClientId', :loading='loading && activeMutation === `reset`', :disabled='!loaded || loading')"
    )
    expect(script).not.toMatch(/utilities-mutation-telemetry-(?:resetid|set)\.gql/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
    expect(script).not.toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
  })

  test('loadTelemetry preserves explicit load state, REST fetch, notifyError, rethrow, and cleanup behavior', () => {
    expect(loadTelemetry).not.toBeNull()
    expectInOrder(loadTelemetry, [
      'this.loaded = false',
      "this.loadError = ''",
      "wikiStore.startLoading('admin-utilities-telemetry-refresh')",
      'const telemetryState = await fetchSystemTelemetry(window.fetch.bind(window))',
      'this.telemetry = telemetryState.telemetry',
      "this.clientId = telemetryState.telemetryClientId || 'N/A'",
      'this.loaded = true',
      'this.loadError = err instanceof Error ? err.message : String(err)',
      'if (notifyError)',
      'wikiStore.showError(err)',
      'throw err',
      "wikiStore.stopLoading('admin-utilities-telemetry-refresh')"
    ])
    expect(loadTelemetry).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?if\s*\(\s*notifyError\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)[\s\S]*?\}\s*throw\s+err/
    )
    expect(loadTelemetry).toMatch(/finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-telemetry-refresh['"]\s*\)\s*\}/)
    expect(loadTelemetry).not.toMatch(directRootUiCommit)
  })

  test('updateTelemetry uses REST helper with mutation-specific state, success-only notification, errors, and cleanup', () => {
    expect(updateTelemetry).not.toBeNull()
    expect(updateTelemetry).toMatch(/if\s*\(\s*!this\.loaded\s*\|\|\s*this\.loading\s*\)\s*\{\s*return\s*\}/)
    expectInOrder(updateTelemetry, [
      'this.loading = true',
      "this.activeMutation = 'save'",
      "wikiStore.startLoading('admin-utilities-telemetry-set')",
      'await updateSystemTelemetry(window.fetch.bind(window), this.telemetry)',
      'wikiStore.showNotification({',
      'wikiStore.showError(err)',
      "wikiStore.stopLoading('admin-utilities-telemetry-set')",
      'this.loading = false',
      "this.activeMutation = ''"
    ])
    expect(updateTelemetry).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Telemetry updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(updateTelemetry).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!this\.isDisposed\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}\s*\}/)
    expect(updateTelemetry).toMatch(
      /finally\s*\{[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-telemetry-set['"]\s*\)[\s\S]*?if\s*\(\s*!this\.isDisposed\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.activeMutation\s*=\s*['"]{2}\s*\}/
    )
    expect(updateTelemetry.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(updateTelemetry).not.toMatch(directRootUiCommit)
  })

  test('resetClientId uses REST helper with mutation-specific state, silent reload, success-only notification, and cleanup', () => {
    expect(resetClientId).not.toBeNull()
    expect(resetClientId).toMatch(/if\s*\(\s*!this\.loaded\s*\|\|\s*this\.loading\s*\)\s*\{\s*return\s*\}/)
    expectInOrder(resetClientId, [
      'this.loading = true',
      "this.activeMutation = 'reset'",
      "wikiStore.startLoading('admin-utilities-telemetry-resetid')",
      'await resetSystemTelemetryClientId(window.fetch.bind(window))',
      'await this.loadTelemetry({ notifyError: false })',
      'wikiStore.showNotification({',
      'wikiStore.showError(err)',
      "wikiStore.stopLoading('admin-utilities-telemetry-resetid')",
      'this.loading = false',
      "this.activeMutation = ''"
    ])
    expect(resetClientId).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Telemetry Client ID reset successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(resetClientId).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!this\.isDisposed\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}\s*\}/)
    expect(resetClientId).toMatch(
      /finally\s*\{[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-telemetry-resetid['"]\s*\)[\s\S]*?if\s*\(\s*!this\.isDisposed\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.activeMutation\s*=\s*['"]{2}\s*\}/
    )
    expect(resetClientId.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(resetClientId).not.toMatch(directRootUiCommit)
  })

  test('teardown makes settled save, reset, and clipboard callbacks inert', () => {
    expect(beforeUnmount).not.toBeNull()
    expect(beforeUnmount).toMatch(/this\.isDisposed\s*=\s*true/)

    expect(updateTelemetry).toMatch(
      /await\s+updateSystemTelemetry\([\s\S]*?if\s*\(\s*this\.isDisposed\s*\)\s*\{\s*return\s*\}[\s\S]*?wikiStore\.showNotification/
    )
    expect(resetClientId).toMatch(
      /await\s+resetSystemTelemetryClientId\([\s\S]*?if\s*\(\s*this\.isDisposed\s*\)\s*\{\s*return\s*\}[\s\S]*?await\s+this\.loadTelemetry\(\{\s*notifyError:\s*false\s*\}\)[\s\S]*?if\s*\(\s*this\.isDisposed\s*\)\s*\{\s*return\s*\}[\s\S]*?wikiStore\.showNotification/
    )
    expect(copyClientId).not.toBeNull()
    expect(copyClientId).toMatch(
      /await\s+navigator\.clipboard\.writeText\(\s*this\.clientId\s*\)[\s\S]*?if\s*\(\s*this\.isDisposed\s*\)\s*\{\s*return\s*\}[\s\S]*?wikiStore\.showNotification/
    )
    expect(copyClientId).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!this\.isDisposed\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}\s*\}/)
  })
})
