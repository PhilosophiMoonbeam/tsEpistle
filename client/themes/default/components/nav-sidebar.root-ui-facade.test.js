const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodMatch = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`).exec(script)

  if (!methodMatch) {
    return null
  }

  const methodStart = methodMatch.index + methodMatch[0].search(/\S/)
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

describe('default nav-sidebar browse loading root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/themes/default/components/nav-sidebar.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const fetchBrowseItems = script && extractMethod(script, 'fetchBrowseItems')
  const loadFromCurrentPath = script && extractMethod(script, 'loadFromCurrentPath')
  const switchMode = script && extractMethod(script, 'switchMode')
  const mounted = script && extractMethod(script, 'mounted')
  const directLoadingCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"])\s*,\s*['"]browse-load['"]\s*\)/

  test('nav-sidebar.vue imports only the loading facades needed by browse loading', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(script).toMatch(/import\s+gql\s+from\s+['"]graphql-tag['"]/)
    expect(script).toMatch(/import\s+\{\s*get\s*\}\s+from\s+['"]vuex-pathify['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
  })

  test('fetchBrowseItems() routes browse loading through facades while preserving page tree query and cache updates', () => {
    expect(fetchBrowseItems).not.toBeNull()

    expect(fetchBrowseItems).toMatch(/async\s+fetchBrowseItems\s*\(\s*item\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]browse-load['"]\s*\)/)
    expect(fetchBrowseItems).toMatch(/if\s*\(\s*!item\s*\)\s*\{\s*item\s*=\s*this\.currentParent\s*\}/)
    expect(fetchBrowseItems).toMatch(/if\s*\(\s*this\.loadedCache\.indexOf\s*\(\s*item\.id\s*\)\s*<\s*0\s*\)\s*\{\s*this\.currentItems\s*=\s*\[\s*\]\s*\}/)
    expect(fetchBrowseItems).toMatch(/if\s*\(\s*item\.id\s*===\s*0\s*\)\s*\{\s*this\.parents\s*=\s*\[\s*\]\s*\}/)
    expect(fetchBrowseItems).toMatch(/const\s+flushRightIndex\s*=\s*_\.findIndex\s*\(\s*this\.parents\s*,\s*\[\s*['"]id['"]\s*,\s*item\.id\s*\]\s*\)/)
    expect(fetchBrowseItems).toMatch(/this\.currentParent\s*=\s*item/)
    expect(fetchBrowseItems).toMatch(/const\s+resp\s*=\s*await\s+this\.\$apollo\.query\s*\(\s*\{[\s\S]*pages\s*\{[\s\S]*tree\s*\(\s*parent:\s*\$parent\s*,\s*mode:\s*ALL\s*,\s*locale:\s*\$locale\s*\)/)
    expect(fetchBrowseItems).toMatch(/fetchPolicy:\s*['"]cache-first['"]/)
    expect(fetchBrowseItems).toMatch(/variables:\s*\{\s*parent:\s*item\.id\s*,\s*locale:\s*this\.locale\s*\}/)
    expect(fetchBrowseItems).toMatch(/this\.loadedCache\s*=\s*_\.union\s*\(\s*this\.loadedCache\s*,\s*\[\s*item\.id\s*\]\s*\)/)
    expect(fetchBrowseItems).toMatch(/this\.currentItems\s*=\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.pages\.tree['"]\s*,\s*\[\s*\]\s*\)/)
    expect(fetchBrowseItems).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]browse-load['"]\s*\)\s*\}/)
    expect(fetchBrowseItems).not.toMatch(directLoadingCommit)

    expect(fetchBrowseItems.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(fetchBrowseItems.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(fetchBrowseItems.match(/\bthis\.\$apollo\.query\s*\(/g) || []).toHaveLength(1)
  })

  test('loadFromCurrentPath() routes browse loading through facades while preserving current-page lookup and existing early return shape', () => {
    expect(loadFromCurrentPath).not.toBeNull()

    expect(loadFromCurrentPath).toMatch(/async\s+loadFromCurrentPath\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]browse-load['"]\s*\)/)
    expect(loadFromCurrentPath).toMatch(/const\s+resp\s*=\s*await\s+this\.\$apollo\.query\s*\(\s*\{[\s\S]*tree\s*\(\s*path:\s*\$path\s*,\s*mode:\s*ALL\s*,\s*locale:\s*\$locale\s*,\s*includeAncestors:\s*true\s*\)/)
    expect(loadFromCurrentPath).toMatch(/variables:\s*\{\s*path:\s*this\.path\s*,\s*locale:\s*this\.locale\s*\}/)
    expect(loadFromCurrentPath).toMatch(/const\s+items\s*=\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.pages\.tree['"]\s*,\s*\[\s*\]\s*\)/)
    expect(loadFromCurrentPath).toMatch(/const\s+curPage\s*=\s*_\.find\s*\(\s*items\s*,\s*\[\s*['"]pageId['"]\s*,\s*this\.\$store\.get\s*\(\s*['"]page\/id['"]\s*\)\s*\]\s*\)/)
    expect(loadFromCurrentPath).toMatch(/if\s*\(\s*!curPage\s*\)\s*\{\s*console\.warn\s*\(\s*['"]Could not find current page in page tree listing!['"]\s*\)\s*return\s*\}/)
    expect(loadFromCurrentPath).toMatch(/this\.parents\s*=\s*\[\s*this\.currentParent\s*,\s*\.\.\.invertedAncestors\.reverse\s*\(\s*\)\s*\]/)
    expect(loadFromCurrentPath).toMatch(/this\.currentParent\s*=\s*_\.last\s*\(\s*this\.parents\s*\)/)
    expect(loadFromCurrentPath).toMatch(/this\.loadedCache\s*=\s*\[\s*curPage\.parent\s*\]/)
    expect(loadFromCurrentPath).toMatch(/this\.currentItems\s*=\s*_\.filter\s*\(\s*items\s*,\s*\[\s*['"]parent['"]\s*,\s*curPage\.parent\s*\]\s*\)/)
    expect(loadFromCurrentPath).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]browse-load['"]\s*\)\s*\}/)
    expect(loadFromCurrentPath).not.toMatch(/finally\s*\{/)
    expect(loadFromCurrentPath).not.toMatch(directLoadingCommit)

    expect(loadFromCurrentPath.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadFromCurrentPath.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadFromCurrentPath.match(/\bthis\.\$apollo\.query\s*\(/g) || []).toHaveLength(1)
  })

  test('pathify, mode switching, mounted browse loading, and home navigation remain present', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/path:\s*get\s*\(\s*['"]page\/path['"]\s*\)/)
    expect(script).toMatch(/locale:\s*get\s*\(\s*['"]page\/locale['"]\s*\)/)
    expect(switchMode).toMatch(/window\.localStorage\.setItem\s*\(\s*['"]navPref['"]\s*,\s*mode\s*\)/)
    expect(switchMode).toMatch(/if\s*\(\s*mode\s*===\s*`browse`\s*&&\s*this\.loadedCache\.length\s*<\s*1\s*\)\s*\{\s*this\.loadFromCurrentPath\s*\(\s*\)\s*\}/)
    expect(mounted).toMatch(/if\s*\(\s*this\.currentMode\s*===\s*['"]browse['"]\s*\)\s*\{\s*this\.loadFromCurrentPath\s*\(\s*\)\s*\}/)
    expect(script).toMatch(/goHome\s*\(\s*\)\s*\{\s*window\.location\.assign\s*\(\s*siteLangs\.length\s*>\s*0\s*\?\s*`\/\$\{this\.locale\}\/home`\s*:\s*['"]\/['"]\s*\)\s*\}/)
  })
})
