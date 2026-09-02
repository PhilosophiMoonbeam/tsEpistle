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

  test('keeps abortable REST dependencies, lifecycle cancellation, MDI actions, and mutually exclusive controls', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+LoggingConsole\s+from\s+['"]\.\/admin-logging-console\.vue['"]/)
    expect(script).toMatch(/import\s+AsyncState\s+from\s+['"]@\/components\/common\/async-state\.vue['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchLoggingLoggers\b)(?=[^}]*\bsaveLoggingLoggers\b)(?=[^}]*\bLogger\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/logging-api['"]/
    )
    expect(script).toMatch(
      /const\s+createAbortableFetch\s*=\s*\(\s*signal:\s*AbortSignal\s*\)[\s\S]*?window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.options,\s*signal\s*\}/
    )
    expect(script).toMatch(/loadController:\s*null\s+as\s+AbortController\s*\|\s*null/)
    expect(script).toMatch(/saveController:\s*null\s+as\s+AbortController\s*\|\s*null/)
    expect(script).toMatch(
      /beforeUnmount\s*\(\s*\)\s*\{[\s\S]*?this\.isUnmounted\s*=\s*true[\s\S]*?this\.loadController\?\.abort\(\)[\s\S]*?this\.saveController\?\.abort\(\)/
    )
    expect(source).toMatch(/@click=['"]refresh['"][^)]*:loading=['"]loading['"][^)]*:disabled=['"]saving['"]/)
    expect(source).toMatch(/v-icon\(start\)\s+mdi-refresh/)
    expect(source).toMatch(/@click=['"]save['"][^)]*:disabled=['"]!loggersLoaded \|\| loading['"][^)]*:loading=['"]saving['"]/)
    expect(script).not.toMatch(/logging-mutation-save-loggers\.gql|loggersSaveMutation/)
    expect(script).toMatch(/activeLoggers\s*\(\s*\)\s*\{\s*return\s+this\.loggers\.filter\s*\(\s*logger\s*=>\s*logger\.isEnabled\s*\)\s*\}/)
  })

  test('loadLoggers cancels the prior generation and only the current generation settles state', () => {
    expect(loadLoggers).not.toBeNull()
    expect(loadLoggers).toContain('this.loadController?.abort()')
    expect(loadLoggers).toMatch(/const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.loadController\s*=\s*controller/)
    expect(loadLoggers).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.errorMessage\s*=\s*['"]{2}[\s\S]*?this\.loggersLoaded\s*=\s*false[\s\S]*?this\.loggers\s*=\s*\[\]/
    )
    expect(loadLoggers).toMatch(
      /fetchLoggingLoggers\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]Logging loggers response is invalid['"]\s*\)/
    )
    expect(loadLoggers).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.loggers\s*=\s*loggers[\s\S]*?this\.loggersLoaded\s*=\s*true[\s\S]*?return\s+true/
    )
    expect(loadLoggers).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?if\s*\(\s*notifyError\s*\)[\s\S]*?wikiStore\.showNotification[\s\S]*?throw\s+err/
    )
    expect(loadLoggers).toMatch(/message:\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?style:\s*['"]red['"][\s\S]*?icon:\s*['"]warning['"]/)
    expect(loadLoggers).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.loadController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.loadController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-logging-refresh['"]\s*\)/
    )
    expect(loadLoggers.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bwikiStore\.startLoading\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bwikiStore\.stopLoading\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers).not.toMatch(directRootUiCommit)
  })

  test('refresh announces success only when its awaited generation commits', () => {
    expect(refresh).not.toBeNull()
    expect(refresh).toContain('if (this.loading || this.saving) return')
    expect(refresh).toMatch(/const\s+loaded\s*=\s*await\s+this\.loadLoggers\s*\(\s*\)[\s\S]*?if\s*\(\s*!loaded\s*\)\s*return/)
    expect(refresh.indexOf('if (!loaded) return')).toBeLessThan(refresh.indexOf('wikiStore.showNotification'))
    expect(refresh).toMatch(/message:\s*['"]List of loggers has been refreshed\.['"][\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]cached['"]/)
    expect(refresh).toMatch(/catch\s*\{[\s\S]*?loadLoggers reports the request error/)
    expect(refresh.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(refresh).not.toMatch(directRootUiCommit)
  })

  test('save sends the complete payload and suppresses success and errors after cancellation or a failed silent reload', () => {
    expect(save).not.toBeNull()
    expect(save).toContain('if (this.saving || this.loading || !this.loggersLoaded) return')
    expect(save).toMatch(/const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.saveController\s*=\s*controller[\s\S]*?this\.saving\s*=\s*true/)
    expect(save).toMatch(/saveLoggingLoggers\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,/)
    expect(save).toMatch(
      /this\.loggers\.map\s*\(\s*tgt\s*=>\s*\(\s*\{\s*isEnabled:\s*tgt\.isEnabled,\s*key:\s*tgt\.key,\s*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\),\s*level:\s*tgt\.level\s*\}\s*\)\s*\)/
    )
    expect(save).toContain("'Logging loggers update failed'")
    expect(save).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?const\s+loaded\s*=\s*await\s+this\.loadLoggers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)/
    )
    expect(save).toMatch(/if\s*\(\s*!loaded\s*\|\|\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}/)
    expect(save.indexOf('if (!loaded || controller.signal.aborted)')).toBeLessThan(save.indexOf('wikiStore.showNotification'))
    expect(save).toMatch(/message:\s*['"]Logging configuration saved successfully\.['"][\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]check['"]/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(save).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.saveController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.saveController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{[\s\S]*?this\.saving\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-logging-saveloggers['"]\s*\)/
    )
    expect(save.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.showError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.startLoading\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.stopLoading\s*\(/g) || []).toHaveLength(1)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|loggersSaveMutation|logging-mutation-save-loggers\.gql/)
    expect(save).not.toMatch(directRootUiCommit)
  })
})
