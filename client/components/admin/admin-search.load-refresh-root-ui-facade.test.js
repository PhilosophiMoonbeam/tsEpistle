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

  test('keeps abortable REST dependencies, lifecycle cancellation, MDI actions, and mutually exclusive controls', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSearchEngines\b)(?=[^}]*\brebuildSearchIndex\b)(?=[^}]*\bsaveSearchEngines\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/search-api['"]/
    )
    expect(script).toMatch(
      /const\s+createAbortableFetch\s*=\s*\(\s*signal:\s*AbortSignal\s*\)[\s\S]*?window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.options,\s*signal\s*\}/
    )
    expect(script).toMatch(/(?:load|save|rebuild)Controller:\s*null\s+as\s+AbortController\s*\|\s*null/g)
    expect(script.match(/(?:load|save|rebuild)Controller:\s*null\s+as\s+AbortController\s*\|\s*null/g) || []).toHaveLength(3)
    expect(script).toMatch(
      /beforeUnmount\s*\(\s*\)\s*\{[\s\S]*?this\.isUnmounted\s*=\s*true[\s\S]*?this\.loadController\?\.abort\(\)[\s\S]*?this\.saveController\?\.abort\(\)[\s\S]*?this\.rebuildController\?\.abort\(\)/
    )
    expect(source).toMatch(/@click=['"]refresh['"][^)]*:loading=['"]enginesLoading['"][^)]*:disabled=['"]saving \|\| rebuilding['"]/)
    expect(source).toMatch(/@click=['"]rebuild['"][^)]*:loading=['"]rebuilding['"][^)]*:disabled=['"]saving \|\| enginesLoading['"]/)
    expect(source).toMatch(/v-icon\(start\)\s+mdi-cached/)
    expect(source).toMatch(/v-else-if=['"]eng\.key === selectedEngine['"]\)\s+mdi-radiobox-marked/)
    expect(source).toMatch(/v-icon\(color=['"]grey['"],\s*v-else\)\s+mdi-radiobox-blank/)
    expect(source).toMatch(/@click=['"]save['"][^)]*:disabled=['"]!enginesLoaded \|\| enginesLoading \|\| rebuilding['"][^)]*:loading=['"]saving['"]/)
    expect(script).not.toMatch(/search-mutation-(?:save-engines|rebuild-index)\.gql|engines(?:Save|Rebuild)Mutation/)
  })

  test('selected engine configuration stays computed from the current engine list', () => {
    expect(script).toMatch(
      /engine\s*\(\s*\)\s*:\s*SearchEngine\s*\{[\s\S]*this\.engines\.find\s*\(\s*engine\s*=>\s*engine\.key\s*===\s*this\.selectedEngine\s*\)\s*\|\|\s*createEmptySearchEngine\s*\(\s*\)/
    )
  })

  test('loadEngines owns an abortable generation and balances success, error, and cleanup', () => {
    expect(loadEngines).not.toBeNull()
    expect(loadEngines).toContain('if (this.enginesLoading) return false')
    expect(loadEngines).toMatch(/const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.loadController\s*=\s*controller/)
    expect(loadEngines).toMatch(
      /this\.enginesLoading\s*=\s*true[\s\S]*?this\.enginesLoadError\s*=\s*false[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-search-refresh['"]\s*\)/
    )
    expect(loadEngines).toMatch(
      /fetchSearchEngines\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]Search engines response is invalid['"]\s*\)/
    )
    expect(loadEngines).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.engines\s*=\s*engines[\s\S]*?this\.selectedEngine\s*=\s*engines\.find\s*\(\s*engine\s*=>\s*engine\.isEnabled\s*\)\?\.key\s*\|\|\s*['"]postgres['"][\s\S]*?this\.enginesLoaded\s*=\s*true[\s\S]*?return\s+true/
    )
    expect(loadEngines).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.engines\s*=\s*\[\][\s\S]*?this\.enginesLoaded\s*=\s*false[\s\S]*?this\.enginesLoadError\s*=\s*true[\s\S]*?if\s*\(\s*notifyError\s*\)[\s\S]*?throw\s+err/
    )
    expect(loadEngines).toMatch(/message:\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?style:\s*['"]error['"][\s\S]*?icon:\s*['"]alert['"]/)
    expect(loadEngines).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.loadController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.loadController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.enginesLoading\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-refresh['"]\s*\)/
    )
    expect(loadEngines.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadEngines).not.toMatch(directRootUiCommit)
  })

  test('refresh is mutually exclusive and announces success only after a committed load', () => {
    expect(refresh).not.toBeNull()
    expect(refresh).toMatch(/if\s*\(\s*this\.saving\s*\|\|\s*this\.rebuilding\s*\|\|\s*this\.enginesLoading\s*\)\s*return/)
    expect(refresh).toMatch(/const\s+loaded\s*=\s*await\s+this\.loadEngines\s*\(\s*\)[\s\S]*?if\s*\(\s*!loaded\s*\)\s*return/)
    expect(refresh.indexOf('if (!loaded) return')).toBeLessThan(refresh.indexOf('showNotification'))
    expect(refresh).toMatch(
      /message:\s*this\.\$t\s*\(\s*['"]admin:search\.listRefreshSuccess['"]\s*\)[\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]cached['"]/
    )
    expect(refresh).toMatch(/catch\s*\{[\s\S]*?loadEngines reports the request error/)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(refresh).not.toMatch(directRootUiCommit)
  })

  test('save sends the complete payload and gates success on its abortable silent reload', () => {
    expect(save).not.toBeNull()
    expect(save).toMatch(/if\s*\(\s*this\.saving\s*\|\|\s*this\.rebuilding\s*\|\|\s*this\.enginesLoading\s*\)\s*return/)
    expect(save).toMatch(/const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.saveController\s*=\s*controller[\s\S]*?this\.saving\s*=\s*true/)
    expect(save).toMatch(/saveSearchEngines\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,/)
    expect(save).toMatch(
      /this\.engines\.map\s*\(\s*tgt\s*=>\s*\(\s*\{\s*isEnabled:\s*tgt\.key\s*===\s*this\.selectedEngine,\s*key:\s*tgt\.key,\s*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)/)
    expect(save).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?const\s+loaded\s*=\s*await\s+this\.loadEngines\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)/
    )
    expect(save).toMatch(/if\s*\(\s*!loaded\s*\|\|\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}/)
    expect(save.indexOf('if (!loaded || controller.signal.aborted)')).toBeLessThan(save.indexOf('showNotification'))
    expect(save).toMatch(
      /message:\s*this\.\$t\s*\(\s*['"]admin:search\.configSaveSuccess['"]\s*\)[\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]check['"]/
    )
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{[\s\S]*?pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.saveController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.saveController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.saving\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-saveengines['"]\s*\)/
    )
    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|enginesSaveMutation|updateSearchEngines\.responseResult/)
    expect(save).not.toMatch(directRootUiCommit)
  })

  test('rebuild owns its abortable request and mutually exclusive balanced busy state', () => {
    expect(rebuild).not.toBeNull()
    expect(rebuild).toMatch(/if\s*\(\s*this\.saving\s*\|\|\s*this\.rebuilding\s*\|\|\s*this\.enginesLoading\s*\)\s*return/)
    expect(rebuild).toMatch(
      /const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.rebuildController\s*=\s*controller[\s\S]*?this\.rebuilding\s*=\s*true/
    )
    expect(rebuild).toMatch(
      /rebuildSearchIndex\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*\)/
    )
    expect(rebuild).toMatch(/if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?showNotification\s*\(\s*wikiStore/)
    expect(rebuild).toMatch(
      /message:\s*this\.\$t\s*\(\s*['"]admin:search\.indexRebuildSuccess['"]\s*\)[\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]check['"]/
    )
    expect(rebuild).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{[\s\S]*?pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/
    )
    expect(rebuild.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(rebuild).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.rebuildController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.rebuildController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.rebuilding\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-search-rebuildindex['"]\s*\)/
    )
    expect(rebuild.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(rebuild.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(rebuild).not.toMatch(/this\.\$apollo\.mutate|enginesRebuildMutation/)
    expect(rebuild).not.toMatch(directRootUiCommit)
  })
})
