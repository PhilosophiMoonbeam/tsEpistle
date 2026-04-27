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

describe('admin-search load/refresh/save/rebuild root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-search.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadEngines = script && extractMethod(script, 'loadEngines')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const rebuild = script && extractMethod(script, 'rebuild')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-search.vue imports the root UI facades needed by loadEngines(), refresh(), save(), and rebuild()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
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

  test('save() uses root UI facades while preserving mutation payload, response handling, silent reload, fallback error, and trailing cleanup', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-search-saveengines['"]\s*\)\s*try\s*\{\s*const\s+resp\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*enginesSaveMutation/)
    expect(save).toMatch(/variables:\s*\{\s*engines:\s*this\.engines\.map\s*\(\s*tgt\s*=>\s*\(\{[\s\S]*isEnabled:\s*tgt\.key\s*===\s*this\.selectedEngine[\s\S]*key:\s*tgt\.key[\s\S]*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\{\.\.\.cfg,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\)\)/)
    expect(save).toMatch(/if\s*\(\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.search\.updateSearchEngines\.responseResult\.succeeded['"]\s*,\s*false\s*\)\s*\)/)
    expect(save).toMatch(/await\s+this\.loadEngines\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)/)
    expect(save).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:search\.configSaveSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/throw\s+new\s+Error\s*\(\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.search\.updateSearchEngines\.responseResult\.message['"]\s*,\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*\)\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-search-saveengines['"]\s*\)\s*\}/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bthis\.loadEngines\s*\(/g) || []).toHaveLength(1)
  })

  test('rebuild() uses root UI facades while preserving mutation, response handling, fallback error, and trailing cleanup', () => {
    expect(rebuild).not.toBeNull()

    expect(rebuild).toMatch(/async\s+rebuild\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-search-rebuildindex['"]\s*\)\s*try\s*\{\s*const\s+resp\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*enginesRebuildMutation\s*\}\s*\)/)
    expect(rebuild).toMatch(/if\s*\(\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.search\.rebuildIndex\.responseResult\.succeeded['"]\s*,\s*false\s*\)\s*\)/)
    expect(rebuild).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:search\.indexRebuildSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(rebuild).toMatch(/throw\s+new\s+Error\s*\(\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.search\.rebuildIndex\.responseResult\.message['"]\s*,\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*\)\s*\)/)
    expect(rebuild).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-search-rebuildindex['"]\s*\)\s*\}/)
    expect(rebuild).not.toMatch(directRootUiCommit)

    expect(rebuild.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bthis\.\$apollo\.mutate\s*\(/g) || []).toHaveLength(1)
  })
})
