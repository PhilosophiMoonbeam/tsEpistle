const fs = require('fs')
const path = require('path')

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`async\\s+${name}\\s*\\(\\s*\\)\\s*\\{`))

  if (methodStart === -1) {
    return null
  }

  const bodyStart = script.indexOf('{', methodStart)
  let depth = 0

  for (let idx = bodyStart; idx < script.length; idx++) {
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

describe('admin-extensions root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-extensions.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const loadExtensions = script && extractMethod(script, 'loadExtensions')

  test('admin-extensions.vue uses grouped root-ui-store facades in active loadExtensions flow', () => {
    expect(script).not.toBeNull()
    expect(loadExtensions).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)

    expect(loadExtensions).toMatch(/async\s+loadExtensions\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-extensions-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?this\.extensions\s*=\s*await\s+fetchSystemExtensions\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]System extensions response is invalid['"]\s*\)[\s\S]*?return\s+true[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.extensions\s*=\s*\[\s*\]\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*return\s+false[\s\S]*?\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-extensions-refresh['"]\s*\)\s*\}/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadExtensions\s*\(\s*\)\s*\}/)

    expect(loadExtensions).not.toMatch(/\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/)

    const loadingStartCalls = loadExtensions.match(/\bloadingStart\s*\(/g) || []
    expect(loadingStartCalls).toHaveLength(1)

    const pushGraphErrorCalls = loadExtensions.match(/\bpushGraphError\s*\(/g) || []
    expect(pushGraphErrorCalls).toHaveLength(1)

    const loadingStopCalls = loadExtensions.match(/\bloadingStop\s*\(/g) || []
    expect(loadingStopCalls).toHaveLength(1)
  })

  test('admin-extensions.vue does not keep stale commented save/Apollo root UI code', () => {
    expect(script).not.toMatch(/\basync\s+save\s*\(/)
    expect(script).not.toMatch(/\bthis\.\$store\.commit\s*\(/)
    expect(source).not.toMatch(/\bthis\.\$apollo\b/)
    expect(source).not.toMatch(/\bmutation\s*:\s*gql`/)
    expect(source).not.toMatch(/\bupdateConfig\s*\(/)
    expect(source).not.toMatch(/\bwatchLoading\s*\(/)
    expect(source).not.toMatch(/\bshowNotification\b/)
    expect(source).not.toMatch(/\$store\.commit\(\s*['"]pushGraphError['"]\s*,/)
  })
})
