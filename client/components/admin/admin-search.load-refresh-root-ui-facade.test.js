import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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
  const directRootUiCommit =
    /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-search.vue imports REST and root UI facades needed by loadEngines(), refresh(), save(), and rebuild()', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSearchEngines\b)(?=[^}]*\brebuildSearchIndex\b)(?=[^}]*\bsaveSearchEngines\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/search-api['"]/
    )
    expect(script).not.toMatch(/search-mutation-save-engines\.gql|enginesSaveMutation/)
    expect(script).not.toMatch(/search-mutation-rebuild-index\.gql|enginesRebuildMutation/)
  })

  test('selected engine configuration stays computed from the current engine list', () => {
    expect(script).toMatch(
      /engine\s*\(\s*\)\s*:\s*SearchEngine\s*\{[\s\S]*this\.engines\.find\s*\(\s*engine\s*=>\s*engine\.key\s*===\s*this\.selectedEngine\s*\)\s*\|\|\s*createEmptySearchEngine\s*\(\s*\)/
    )
  })

  test('loadEngines() uses loading/notification facades while preserving fetch, notifyError, rethrow, and cleanup', () => {
    expect(loadEngines).not.toBeNull()

    expect(loadEngines).toMatch(/if\s*\(\s*this\.enginesLoading\s*\)\s*return/)
    expect(loadEngines).toMatch(
      /this\.enginesLoading\s*=\s*true[\s\S]*this\.enginesLoadError\s*=\s*false[\s\S]*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-search-refresh['"]\s*\)/
    )
    expect(loadEngines).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-search-refresh['"]\s*\)/)
    expect(loadEngines).toMatch(
      /this\.engines\s*=\s*await\s+fetchSearchEngines\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Search engines response is invalid['"]\s*\)/
    )
    expect(loadEngines).toMatch(/this\.selectedEngine\s*=\s*this\.engines\.find\s*\(\s*engine\s*=>\s*engine\.isEnabled\s*\)\?\.key\s*\|\|\s*['"]postgres['"]/)
    expect(loadEngines).toMatch(/this\.enginesLoaded\s*=\s*true/)
    expect(loadEngines).toMatch(/if\s*\(\s*notifyError\s*\)/)
    expect(loadEngines).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*message:\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*style:\s*['"]error['"][\s\S]*icon:\s*['"]alert['"][\s\S]*\}\s*\)/
    )
    expect(loadEngines).toMatch(
      /this\.engines\s*=\s*\[\][\s\S]*this\.selectedEngine\s*=\s*['"]['"][\s\S]*this\.enginesLoaded\s*=\s*false[\s\S]*this\.enginesLoadError\s*=\s*true/
    )
    expect(loadEngines).toMatch(/throw\s+err/)
    expect(loadEngines).toMatch(/loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-refresh['"]\s*\)/)
    expect(loadEngines).toMatch(
      /finally\s*\{[\s\S]*this\.enginesLoading\s*=\s*false[\s\S]*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-refresh['"]\s*\)/
    )
    expect(loadEngines).not.toMatch(directRootUiCommit)

    expect(loadEngines.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bfetchSearchEngines\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh() keeps loadEngines() await and routes only the refresh success notification through the facade', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/if\s*\(\s*this\.saving\s*\|\|\s*this\.rebuilding\s*\|\|\s*this\.enginesLoading\s*\)\s*return/)
    expect(refresh).toMatch(/await\s+this\.loadEngines\s*\(\s*\)/)
    expect(refresh).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*message:\s*this\.\$t\s*\(\s*['"]admin:search\.listRefreshSuccess['"]\s*\)[\s\S]*style:\s*['"]success['"][\s\S]*icon:\s*['"]cached['"][\s\S]*\}\s*\)/
    )
    expect(refresh).not.toMatch(directRootUiCommit)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save() uses REST helper while preserving payload, silent reload, success notification, error facade, and cleanup', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/if\s*\(\s*this\.saving\s*\|\|\s*this\.rebuilding\s*\|\|\s*this\.enginesLoading\s*\)\s*return/)
    expect(save).toMatch(/this\.saving\s*=\s*true[\s\S]*loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-search-saveengines['"]\s*\)/)
    expect(save).toMatch(
      /await\s+saveSearchEngines\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.engines\.map\s*\(\s*tgt\s*=>\s*\(\{[\s\S]*isEnabled:\s*tgt\.key\s*===\s*this\.selectedEngine[\s\S]*key:\s*tgt\.key[\s\S]*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\{\.\.\.cfg,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\)\)/
    )
    expect(save).toMatch(/this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)/)
    expect(save).toMatch(/await\s+this\.loadEngines\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)/)
    expect(save).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*message:\s*this\.\$t\s*\(\s*['"]admin:search\.configSaveSuccess['"]\s*\)[\s\S]*style:\s*['"]success['"][\s\S]*icon:\s*['"]check['"][\s\S]*\}\s*\)/
    )
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}/)
    expect(save).toMatch(/loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-saveengines['"]\s*\)/)
    expect(save).toMatch(/finally\s*\{[\s\S]*this\.saving\s*=\s*false[\s\S]*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-saveengines['"]\s*\)/)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|enginesSaveMutation|updateSearchEngines\.responseResult/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bsaveSearchEngines\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bthis\.loadEngines\s*\(/g) || []).toHaveLength(1)
  })

  test('rebuild() uses REST and root UI facades while owning its mutually exclusive busy state', () => {
    expect(rebuild).not.toBeNull()

    expect(rebuild).toMatch(/if\s*\(\s*this\.saving\s*\|\|\s*this\.rebuilding\s*\|\|\s*this\.enginesLoading\s*\)\s*return/)
    expect(rebuild).toMatch(/this\.rebuilding\s*=\s*true/)
    expect(rebuild).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-search-rebuildindex['"]\s*\)/)
    expect(rebuild).toMatch(
      /await\s+rebuildSearchIndex\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*\)/
    )
    expect(rebuild).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:search\.indexRebuildSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(rebuild).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}/)
    expect(rebuild).toMatch(/finally\s*\{[\s\S]*this\.rebuilding\s*=\s*false[\s\S]*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-rebuildindex['"]\s*\)/)
    expect(rebuild).not.toMatch(directRootUiCommit)
    expect(rebuild).not.toMatch(/this\.\$apollo\.mutate|enginesRebuildMutation/)

    expect(rebuild.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\brebuildSearchIndex\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
