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

describe('admin-comments root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-comments.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const scriptMatch = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  const script = scriptMatch && scriptMatch[1]
  const watchStart = script && script.search(/\bwatch\s*:/)
  const watchBlock = watchStart !== -1 ? extractBlock(script, watchStart) : null
  const loadProviders = script && extractMethod(script, 'loadProviders')
  const refresh = script && extractMethod(script, 'refresh')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-comments.vue imports the root UI facades and keeps comment provider selection watchers intact', () => {
    expect(script).not.toBeNull()
    expect(watchBlock).not.toBeNull()

    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{\s*fetchCommentProviders\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/comments-api['"]/)
    expect(watchBlock).toMatch(/selectedProvider\s*\(\s*newValue\s*,\s*oldValue\s*\)\s*\{\s*this\.provider\s*=\s*_\.find\s*\(\s*this\.providers\s*,\s*\[\s*['"]key['"]\s*,\s*newValue\s*\]\s*\)\s*\|\|\s*\{\s*\}\s*\}/)
    expect(watchBlock).toMatch(/providers\s*\(\s*newValue\s*,\s*oldValue\s*\)\s*\{\s*this\.selectedProvider\s*=\s*_\.get\s*\(\s*_\.find\s*\(\s*this\.providers\s*,\s*['"]isEnabled['"]\s*\)\s*,\s*['"]key['"]\s*,\s*['"]db['"]\s*\)\s*\}/)
  })

  test('loadProviders uses loading and notification facades without changing fetch, notifyError, rethrow, or cleanup behavior', () => {
    expect(loadProviders).not.toBeNull()

    expect(loadProviders).toMatch(/async\s+loadProviders\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-comments-refresh['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?this\.providers\s*=\s*await\s+fetchCommentProviders\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Comment providers response is invalid['"]\s*\)[\s\S]*?\}\s*catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*notifyError\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*err\.message\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*,\s*style:\s*['"]red['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-comments-refresh['"]\s*\)\s*\}/)
    expect(loadProviders).not.toMatch(directRootUiCommit)

    expect(loadProviders.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadProviders.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh waits for provider reload before showing the success notification through the facade', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*await\s+this\.loadProviders\s*\(\s*\)\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:comments\.listRefreshSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}/)
    expect(refresh).not.toMatch(directRootUiCommit)

    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('save preserves mutation variables, silent reload, success/error facades, and trailing loading stop', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-comments-saveproviders['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?const\s+resp\s*=\s*await\s+this\.\$apollo\.mutate\s*\([\s\S]*?if\s*\(\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.comments\.updateProviders\.responseResult\.succeeded['"]\s*,\s*false\s*\)\s*\)\s*\{\s*await\s+this\.loadProviders\s*\(\s*\{\s*notifyError:\s*false\s*\}\s*\)\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*this\.\$t\s*\(\s*['"]admin:comments\.configSaveSuccess['"]\s*\)\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)[\s\S]*?\}\s*else\s*\{\s*throw\s+new\s+Error\s*\(\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.comments\.updateProviders\.responseResult\.message['"]\s*,\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)\s*\)\s*\)\s*\}\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-comments-saveproviders['"]\s*\)\s*\}/)
    expect(save).toMatch(/mutation:\s*gql`[\s\S]*mutation\s*\(\s*\$providers:\s*\[\s*CommentProviderInput\s*\]!\s*\)\s*\{[\s\S]*updateProviders\s*\(\s*providers:\s*\$providers\s*\)/)
    expect(save).toMatch(/variables:\s*\{\s*providers:\s*this\.providers\.map\s*\(\s*tgt\s*=>\s*\(\s*\{\s*isEnabled:\s*tgt\.key\s*===\s*this\.selectedProvider\s*,\s*key:\s*tgt\.key\s*,\s*config:\s*tgt\.config\.map\s*\(\s*cfg\s*=>\s*\(\s*\{\s*\.\.\.cfg\s*,\s*value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)\s*\}\s*\)\s*\)\s*\}\s*\)\s*\)\s*\}/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
