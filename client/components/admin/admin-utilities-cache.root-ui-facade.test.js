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

describe('admin utilities cache REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-cache.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const flushCache = script && extractMethod(script, 'flushCache')
  const flushUploads = script && extractMethod(script, 'flushUploads')
  const flushClientLocaleCache = script && extractMethod(script, 'flushClientLocaleCache')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-cache.vue imports REST helpers and removes cache GraphQL mutations', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/) // still needed for localStorage key matching
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bflushSystemCache\b)(?=[^}]*\bflushSystemTemporaryUploads\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).not.toMatch(/utilities-mutation-cache-flush(?:cache|uploads)\.gql/)
    expect(script).not.toMatch(/utilityCacheFlush(?:Cache|Uploads)Mutation/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
  })

  test('flushCache uses REST helper while preserving loading, notification, and error facades', () => {
    expect(flushCache).not.toBeNull()

    expect(flushCache).toMatch(/this\.loading\s*=\s*true/)
    expect(flushCache).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushCache['"]\s*\)/)
    expect(flushCache).toMatch(/await\s+flushSystemCache\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(flushCache).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Cache flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(flushCache).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}/)
    expect(flushCache).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushCache['"]\s*\)/)
    expect(flushCache).toMatch(/this\.loading\s*=\s*false/)
    expect(flushCache).not.toMatch(/this\.\$apollo\.mutate|utilityCacheFlushCacheMutation/)
    expect(flushCache).not.toMatch(directRootUiCommit)
  })

  test('flushUploads uses REST helper while preserving loading, notification, and error facades', () => {
    expect(flushUploads).not.toBeNull()

    expect(flushUploads).toMatch(/this\.loading\s*=\s*true/)
    expect(flushUploads).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushUploads['"]\s*\)/)
    expect(flushUploads).toMatch(/await\s+flushSystemTemporaryUploads\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(flushUploads).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Temporary Uploads flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(flushUploads).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}/)
    expect(flushUploads).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-cache-flushUploads['"]\s*\)/)
    expect(flushUploads).toMatch(/this\.loading\s*=\s*false/)
    expect(flushUploads).not.toMatch(/this\.\$apollo\.mutate|utilityCacheFlushUploadsMutation/)
    expect(flushUploads).not.toMatch(directRootUiCommit)
  })

  test('flushClientLocaleCache remains local-only and keeps lodash usage', () => {
    expect(flushClientLocaleCache).not.toBeNull()

    expect(flushClientLocaleCache).toMatch(/window\.localStorage\.length/)
    expect(flushClientLocaleCache).toMatch(/_\.startsWith\s*\(\s*lsKey\s*,\s*['"]i18next_res['"]\s*\)/)
    expect(flushClientLocaleCache).toMatch(/window\.localStorage\.removeItem\s*\(\s*lsKey\s*\)/)
    expect(flushClientLocaleCache).toMatch(/message:\s*['"]Locale Client-Side Cache flushed successfully\.['"]/)
    expect(flushClientLocaleCache).not.toMatch(/\bflushSystem(?:Cache|TemporaryUploads)\s*\(/)
    expect(flushClientLocaleCache).not.toMatch(directRootUiCommit)
  })
})
