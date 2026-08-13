import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

  test('admin-utilities-cache.vue imports REST helpers and the typed wiki store', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{\s*defineComponent\s*\}\s+from\s+['"]vue['"]/)
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bflushSystemCache\b)(?=[^}]*\bflushSystemTemporaryUploads\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/)
    expect(script).not.toMatch(/utilities-mutation-cache-flush(?:cache|uploads)\.gql/)
    expect(script).not.toMatch(/utilityCacheFlush(?:Cache|Uploads)Mutation/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
    expect(script).not.toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
  })

  test('flushCache uses REST helper while preserving loading, notification, and error behavior', () => {
    expect(flushCache).not.toBeNull()

    expect(flushCache).toMatch(/this\.loading\s*=\s*true/)
    expect(flushCache).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-cache-flushCache['"]\s*\)/)
    expect(flushCache).toMatch(/await\s+flushSystemCache\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(flushCache).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Cache flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(flushCache).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}/)
    expect(flushCache).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-cache-flushCache['"]\s*\)/)
    expect(flushCache).toMatch(/this\.loading\s*=\s*false/)
    expect(flushCache).not.toMatch(/this\.\$apollo\.mutate|utilityCacheFlushCacheMutation/)
    expect(flushCache).not.toMatch(directRootUiCommit)
  })

  test('flushUploads uses REST helper while preserving loading, notification, and error behavior', () => {
    expect(flushUploads).not.toBeNull()

    expect(flushUploads).toMatch(/this\.loading\s*=\s*true/)
    expect(flushUploads).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-utilities-cache-flushUploads['"]\s*\)/)
    expect(flushUploads).toMatch(/await\s+flushSystemTemporaryUploads\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(flushUploads).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Temporary Uploads flushed successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(flushUploads).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}/)
    expect(flushUploads).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-cache-flushUploads['"]\s*\)/)
    expect(flushUploads).toMatch(/this\.loading\s*=\s*false/)
    expect(flushUploads).not.toMatch(/this\.\$apollo\.mutate|utilityCacheFlushUploadsMutation/)
    expect(flushUploads).not.toMatch(directRootUiCommit)
  })

  test('flushClientLocaleCache remains local-only and uses typed native key matching', () => {
    expect(flushClientLocaleCache).not.toBeNull()

    expect(flushClientLocaleCache).toMatch(/window\.localStorage\.length/)
    expect(flushClientLocaleCache).toMatch(/lsKey\?\.startsWith\s*\(\s*['"]i18next_res['"]\s*\)/)
    expect(flushClientLocaleCache).toMatch(/window\.localStorage\.removeItem\s*\(\s*lsKey\s*\)/)
    expect(flushClientLocaleCache).toMatch(/wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Locale Client-Side Cache flushed successfully\.['"]/)
    expect(flushClientLocaleCache).not.toMatch(/\bflushSystem(?:Cache|TemporaryUploads)\s*\(/)
    expect(flushClientLocaleCache).not.toMatch(directRootUiCommit)
  })
})
