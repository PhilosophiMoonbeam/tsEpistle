const fs = require('fs')
const path = require('path')

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
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const loadLoggers = script && extractMethod(script, 'loadLoggers')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-logging.vue imports root UI facades without changing logging dependencies or component wiring', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+LoggingConsole\s+from\s+['"]\.\/admin-logging-console\.vue['"]/)
    expect(script).toMatch(/components:\s*\{\s*LoggingConsole\s*\}/)
    expect(script).toMatch(/import\s+\{\s*fetchLoggingLoggers\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/logging-api['"]/)
    expect(script).toMatch(/import\s+loggersSaveMutation\s+from\s+['"]gql\/admin\/logging\/logging-mutation-save-loggers\.gql['"]/)
    expect(script).toMatch(/activeLoggers\s*\(\s*\)\s*\{\s*return\s+_\.filter\s*\(\s*this\.loggers\s*,\s*['"]isEnabled['"]\s*\)\s*\}/)
    expect(script).toMatch(/created\s*\(\s*\)\s*\{\s*this\.loadLoggers\s*\(\s*\)\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\s*\}/)
    expect(script).toMatch(/toggleConsole\s*\(\s*\)\s*\{\s*this\.showConsole\s*=\s*!this\.showConsole\s*\}/)
  })

  test('loadLoggers uses loading and notification facades without changing fetch, notifyError, return, rethrow, or cleanup behavior', () => {
    expect(loadLoggers).not.toBeNull()

    expect(loadLoggers).toMatch(/async\s+loadLoggers\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-logging-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?this\.loggers\s*=\s*await\s+fetchLoggingLoggers\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Logging loggers response is invalid['"]\s*\)[\s\S]*?return\s+true[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*err\.message\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-logging-refresh['"]\s*\)\s*\}/)
    expect(loadLoggers).not.toMatch(directRootUiCommit)

    expect(loadLoggers.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLoggers.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh waits for logger reload before showing the success notification through the facade', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*await\s+this\.loadLoggers\s*\(\s*\)\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]List of loggers has been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/)
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save preserves mutation variables, silent reload, success/error facades, and trailing loading stop', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-logging-saveloggers['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?await\s+this\.\$apollo\.mutate\s*\([\s\S]*?await\s+this\.loadLoggers\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Logging configuration saved successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-logging-saveloggers['"]\s*\)\s*\}/)
    expect(save).toMatch(/mutation:\s*loggersSaveMutation/)
    expect(save).toMatch(/variables:\s*\{\s*loggers:\s*this\.loggers\.map\s*\(\s*tgt\s*=>\s*_\.pick\s*\(\s*tgt\s*,\s*\[\s*['"]isEnabled['"]\s*,\s*['"]key['"]\s*,\s*['"]config['"]\s*,\s*['"]level['"]\s*\]\s*\)\s*\)\.map\s*\(\s*str\s*=>\s*\(\s*\{\s*\.\.\.str\s*,\s*config:\s*str\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)\s*\}/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
