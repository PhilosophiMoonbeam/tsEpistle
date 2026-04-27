const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

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

describe('admin utilities cache root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-cache.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const flushCache = script && extractMethod(script, 'flushCache')
  const flushUploads = script && extractMethod(script, 'flushUploads')
  const flushClientLocaleCache = script && extractMethod(script, 'flushClientLocaleCache')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-cache.vue imports root UI facades without changing gql or lodash dependencies', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+utilityCacheFlushCacheMutation\s+from\s+['"]gql\/admin\/utilities\/utilities-mutation-cache-flushcache\.gql['"]/)
    expect(script).toMatch(/import\s+utilityCacheFlushUploadsMutation\s+from\s+['"]gql\/admin\/utilities\/utilities-mutation-cache-flushuploads\.gql['"]/)
  })

  test('flushCache uses loading, notification, and GraphQL error facades while preserving mutation flow', () => {
    expect(flushCache).not.toBeNull()

    expect(flushCache).toMatch(/async\s+flushCache\s*\(\s*\)\s*\{\s*this\.loading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushCache['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?const\s+respRaw\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*utilityCacheFlushCacheMutation\s*\}\s*\)[\s\S]*?const\s+resp\s*=\s*_\.get\s*\(\s*respRaw\s*,\s*['"]data\.pages\.flushCache\.responseResult['"]\s*,\s*\{\s*\}\s*\)[\s\S]*?if\s*\(\s*resp\.succeeded\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Cache flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)\s*\}\s*else\s*\{\s*throw\s+new\s+Error\s*\(\s*resp\.message\s*\)\s*\}\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushCache['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(flushCache).not.toMatch(directRootUiCommit)

    expect(flushCache.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(flushCache.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(flushCache.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(flushCache.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('flushUploads uses loading, notification, and GraphQL error facades while preserving mutation flow', () => {
    expect(flushUploads).not.toBeNull()

    expect(flushUploads).toMatch(/async\s+flushUploads\s*\(\s*\)\s*\{\s*this\.loading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushUploads['"]\s*\)[\s\S]*?try\s*\{[\s\S]*?const\s+respRaw\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*utilityCacheFlushUploadsMutation\s*\}\s*\)[\s\S]*?const\s+resp\s*=\s*_\.get\s*\(\s*respRaw\s*,\s*['"]data\.assets\.flushTempUploads\.responseResult['"]\s*,\s*\{\s*\}\s*\)[\s\S]*?if\s*\(\s*resp\.succeeded\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Temporary Uploads flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)\s*\}\s*else\s*\{\s*throw\s+new\s+Error\s*\(\s*resp\.message\s*\)\s*\}\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushUploads['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(flushUploads).not.toMatch(directRootUiCommit)

    expect(flushUploads.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(flushUploads.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(flushUploads.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(flushUploads.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('flushClientLocaleCache preserves the localStorage loop and only migrates the success notification', () => {
    expect(flushClientLocaleCache).not.toBeNull()

    expect(flushClientLocaleCache).toMatch(/async\s+flushClientLocaleCache\s*\(\s*\)\s*\{\s*for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*window\.localStorage\.length\s*;\s*i\+\+\s*\)\s*\{\s*const\s+lsKey\s*=\s*window\.localStorage\.key\s*\(\s*i\s*\)\s*if\s*\(\s*_\.startsWith\s*\(\s*lsKey\s*,\s*['"]i18next_res['"]\s*\)\s*\)\s*\{\s*window\.localStorage\.removeItem\s*\(\s*lsKey\s*\)\s*\}\s*\}\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Locale Client-Side Cache flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)\s*\}/)
    expect(flushClientLocaleCache).not.toMatch(directRootUiCommit)

    expect(flushClientLocaleCache.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(flushClientLocaleCache).not.toMatch(/\bloading(?:Start|Stop)\s*\(/)
    expect(flushClientLocaleCache).not.toMatch(/\bpushGraphError\s*\(/)
  })
})
