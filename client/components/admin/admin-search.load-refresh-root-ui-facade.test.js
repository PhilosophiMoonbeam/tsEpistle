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

describe('admin-search load/refresh root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-search.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadEngines = script && extractMethod(script, 'loadEngines')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const rebuild = script && extractMethod(script, 'rebuild')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-search.vue imports only the root UI facades needed by loadEngines() and refresh()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(script).toMatch(/import\s+enginesSaveMutation\s+from\s+['"]gql\/admin\/search\/search-mutation-save-engines\.gql['"]/)
    expect(script).toMatch(/import\s+enginesRebuildMutation\s+from\s+['"]gql\/admin\/search\/search-mutation-rebuild-index\.gql['"]/)
    expect(script).toMatch(/import\s+\{\s*fetchSearchEngines\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/search-api['"]/)
  })

  test('loadEngines() uses loading/notification facades while preserving fetch, notifyError, rethrow, and cleanup', () => {
    expect(loadEngines).not.toBeNull()

    expect(loadEngines).toMatch(/async\s+loadEngines\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*=\s*\{\}\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-search-refresh['"]\s*\)\s*try\s*\{\s*this\.engines\s*=\s*await\s+fetchSearchEngines\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Search engines response is invalid['"]\s*\)\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.engines\s*=\s*\[\]\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*err\.message\s*,\s*style:\s*['"]error['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-search-refresh['"]\s*\)\s*\}\s*\}/)
    expect(loadEngines).not.toMatch(directRootUiCommit)

    expect(loadEngines.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bfetchSearchEngines\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh() keeps loadEngines() await and routes only the refresh success notification through the facade', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*await\s+this\.loadEngines\s*\(\s*\)\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:search\.listRefreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/)
    expect(refresh).not.toMatch(directRootUiCommit)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save() and rebuild() GraphQL mutations, loading keys, and direct commits stay out of scope', () => {
    expect(save).not.toBeNull()
    expect(rebuild).not.toBeNull()

    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStart`\s*,\s*['"]admin-search-saveengines['"]\s*\)/)
    expect(save).toMatch(/mutation:\s*enginesSaveMutation/)
    expect(save).toMatch(/engines:\s*this\.engines\.map\s*\(\s*tgt\s*=>\s*\(\{[\s\S]*isEnabled:\s*tgt\.key\s*===\s*this\.selectedEngine[\s\S]*key:\s*tgt\.key[\s\S]*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\{\.\.\.cfg,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\)\)/)
    expect(save).toMatch(/await\s+this\.loadEngines\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)/)
    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:search\.configSaveSuccess['"]\s*\)/)
    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStop`\s*,\s*['"]admin-search-saveengines['"]\s*\)/)

    expect(rebuild).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStart`\s*,\s*['"]admin-search-rebuildindex['"]\s*\)/)
    expect(rebuild).toMatch(/mutation:\s*enginesRebuildMutation/)
    expect(rebuild).toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:search\.indexRebuildSuccess['"]\s*\)/)
    expect(rebuild).toMatch(/this\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(rebuild).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStop`\s*,\s*['"]admin-search-rebuildindex['"]\s*\)/)
  })
})
