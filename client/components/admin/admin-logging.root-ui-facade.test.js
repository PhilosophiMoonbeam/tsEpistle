import fs from 'node:fs'
import path from 'node:path'

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

describe('admin-logging root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-logging.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const loadLoggers = script && extractMethod(script, 'loadLoggers')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-logging.vue keeps the REST dependencies and both rendered child components', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)

    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+LoggingConsole\s+from\s+['"]\.\/admin-logging-console\.vue['"]/)
    expect(script).toMatch(/import\s+AsyncState\s+from\s+['"]@\/components\/common\/async-state\.vue['"]/)
    expect(script).toMatch(/components:\s*\{[\s\S]*?\bLoggingConsole\b[\s\S]*?\bAsyncState\b[\s\S]*?\}/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchLoggingLoggers\b)(?=[^}]*\bsaveLoggingLoggers\b)(?=[^}]*\bLogger\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/logging-api['"]/
    )
    expect(script).not.toMatch(/logging-mutation-save-loggers\.gql|loggersSaveMutation/)
    expect(script).toMatch(/activeLoggers\s*\(\s*\)\s*\{\s*return\s+this\.loggers\.filter\s*\(\s*logger\s*=>\s*logger\.isEnabled\s*\)\s*\}/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadLoggers\s*\(\s*\)\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\s*\}/)
    expect(script).toMatch(/toggleConsole\s*\(\s*\)\s*\{\s*this\.showConsole\s*=\s*!this\.showConsole\s*\}/)
  })

  test('loadLoggers exposes loading, success, and error boundaries while balancing root loading', () => {
    expect(loadLoggers).not.toBeNull()

    expect(loadLoggers).toMatch(/async\s+loadLoggers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?\s*:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)/)
    expect(loadLoggers).toMatch(
      /this\.loading\s*=\s*true\s*this\.errorMessage\s*=\s*''\s*this\.loggersLoaded\s*=\s*false\s*this\.loggers\s*=\s*\[\]\s*wikiStore\.startLoading\(['"]admin-logging-refresh['"]\)/
    )
    expect(loadLoggers).toMatch(
      /this\.loggers\s*=\s*await\s+fetchLoggingLoggers\(window\.fetch\.bind\(window\),\s*['"]Logging loggers response is invalid['"]\)\s*this\.loggersLoaded\s*=\s*true\s*return\s+true/
    )
    expect(loadLoggers).toMatch(
      /catch\s*\(err\)\s*\{\s*this\.errorMessage\s*=\s*getErrorMessage\(err\)\s*if\s*\(notifyError\)\s*\{\s*wikiStore\.showNotification\(\{\s*message:\s*getErrorMessage\(err\),\s*style:\s*['"]red['"],\s*icon:\s*['"]warning['"]\s*\}\)\s*\}\s*throw\s+err\s*\}/
    )
    expect(loadLoggers).toMatch(/finally\s*\{\s*this\.loading\s*=\s*false\s*wikiStore\.stopLoading\(['"]admin-logging-refresh['"]\)\s*\}/)
    expect(loadLoggers).not.toMatch(directRootUiCommit)

    expect(loadLoggers.match(/\bwikiStore\.startLoading\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bwikiStore\.stopLoading\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh coordinates with active loads and saves and only reports successful reloads', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(
      /async\s+refresh\s*\(\s*\)\s*\{\s*if\s*\(this\.loading \|\| this\.saving\) return\s*try\s*\{\s*await\s+this\.loadLoggers\s*\(\s*\)\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]List of loggers has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}\s*catch\s*\{\s*\/\/ loadLoggers reports the request error\.\s*\}\s*\}/
    )
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save preserves the complete helper payload, silent reload, outcomes, and balanced cleanup', () => {
    expect(save).not.toBeNull()

    expect(save).toContain('if (this.saving || this.loading || !this.loggersLoaded) return')
    expect(save).toMatch(/this\.saving\s*=\s*true\s*wikiStore\.startLoading\(['"]admin-logging-saveloggers['"]\)/)
    expect(save).toMatch(
      /await\s+saveLoggingLoggers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,[\s\S]*?await\s+this\.loadLoggers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Logging configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /this\.loggers\.map\s*\(\s*tgt\s*=>\s*\(\s*\{\s*isEnabled:\s*tgt\.isEnabled,\s*key:\s*tgt\.key,\s*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\),\s*level:\s*tgt\.level\s*\}\s*\)\s*\)/
    )
    expect(save).toMatch(/['"]Logging loggers update failed['"]/)
    expect(save).toMatch(
      /catch\s*\(err\)\s*\{\s*wikiStore\.showError\(err\)\s*\}\s*finally\s*\{\s*this\.saving\s*=\s*false\s*wikiStore\.stopLoading\(['"]admin-logging-saveloggers['"]\)\s*\}/
    )
    expect(save).not.toMatch(/this\.\$apollo\.mutate|loggersSaveMutation|logging-mutation-save-loggers\.gql/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bwikiStore\.startLoading\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.showError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.stopLoading\s*\(/g) || []).toHaveLength(1)
  })
})
