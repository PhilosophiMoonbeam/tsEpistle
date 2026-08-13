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
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-logging.vue imports the typed wiki store without changing logging dependencies or component wiring', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)

    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+LoggingConsole\s+from\s+['"]\.\/admin-logging-console\.vue['"]/)
    expect(script).toMatch(/components:\s*\{\s*LoggingConsole\s*\}/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchLoggingLoggers\b)(?=[^}]*\bsaveLoggingLoggers\b)(?=[^}]*\bLogger\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/logging-api['"]/)
    expect(script).not.toMatch(/logging-mutation-save-loggers\.gql|loggersSaveMutation/)
    expect(script).toMatch(/activeLoggers\s*\(\s*\)\s*\{\s*return\s+_\.filter\s*\(\s*this\.loggers\s*,\s*['"]isEnabled['"]\s*\)\s*\}/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadLoggers\s*\(\s*\)\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\s*\}/)
    expect(script).toMatch(/toggleConsole\s*\(\s*\)\s*\{\s*this\.showConsole\s*=\s*!this\.showConsole\s*\}/)
  })

  test('loadLoggers uses wiki store loading and notifications without changing fetch, notifyError, return, rethrow, or cleanup behavior', () => {
    expect(loadLoggers).not.toBeNull()

    expect(loadLoggers).toMatch(/async\s+loadLoggers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*:\s*\{\s*notifyError\?\s*:\s*boolean\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*wikiStore\.startLoading\s*\(\s*['"]admin-logging-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?this\.loggers\s*=\s*await\s+fetchLoggingLoggers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Logging loggers response is invalid['"]\s*\)[\s\S]*?return\s+true[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*notifyError\s*\)\s*\{\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*getErrorMessage\s*\(\s*err\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]admin-logging-refresh['"]\s*\)\s*\}/)
    expect(loadLoggers).not.toMatch(directRootUiCommit)

    expect(loadLoggers.match(/\bwikiStore\.startLoading\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bwikiStore\.stopLoading\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh waits for logger reload before showing the success notification through the wiki store', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*await\s+this\.loadLoggers\s*\(\s*\)\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]List of loggers has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/)
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save preserves mutation variables, silent reload, success/error facades, and trailing loading stop', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*wikiStore\.startLoading\s*\(\s*['"]admin-logging-saveloggers['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?await\s+saveLoggingLoggers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,[\s\S]*?await\s+this\.loadLoggers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Logging configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}\s*wikiStore\.stopLoading\s*\(\s*['"]admin-logging-saveloggers['"]\s*\)\s*\}/)
    expect(save).toMatch(/this\.loggers\.map\s*\(\s*tgt\s*=>\s*_\.pick\s*\(\s*tgt\s*,\s*\[\s*['"]isEnabled['"]\s*,\s*['"]key['"]\s*,\s*['"]config['"]\s*,\s*['"]level['"]\s*\]\s*\)\s*\)\.map\s*\(\s*str\s*=>\s*\(\s*\{\s*\.\.\.str\s*,\s*config:\s*str\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)/)
    expect(save).toMatch(/['"]Logging loggers update failed['"]/)
    expect(save).not.toMatch(/this\.\$apollo\.mutate|loggersSaveMutation|logging-mutation-save-loggers\.gql/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bwikiStore\.startLoading\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.showNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.showError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bwikiStore\.stopLoading\s*\(/g) || []).toHaveLength(1)
  })
})
