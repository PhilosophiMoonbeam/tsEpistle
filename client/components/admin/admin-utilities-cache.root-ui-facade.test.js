import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
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
  const methodStart = script.search(new RegExp(`(?:async\\s+)?${name}\\s*\\(`))

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
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-cache.vue imports REST helpers and the typed wiki store', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+\{\s*defineComponent\s*\}\s+from\s+['"]vue['"]/)
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bflushSystemCache\b)(?=[^}]*\bflushSystemTemporaryUploads\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/
    )
    expect(script).not.toMatch(/utilities-mutation-cache-flush(?:cache|uploads)\.gql/)
    expect(script).not.toMatch(/utilityCacheFlush(?:Cache|Uploads)Mutation/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
    expect(script).not.toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
  })

  test('flushCache uses the REST helper with explicit operation state and cleanup', () => {
    expect(flushCache).not.toBeNull()

    expect(source).toMatch(/@click=['"]flushCache['"][\s\S]*?:loading=['"]activeOperation === ["']cache["']['"]/)
    expect(flushCache).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.activeOperation\s*=\s*['"]cache['"][\s\S]*?wikiStore\.startLoading\s*\(\s*['"]admin-utilities-cache-flushCache['"]\s*\)[\s\S]*?await\s+flushSystemCache\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/
    )
    expect(flushCache).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{[\s\S]*?message:\s*['"]Pages and assets cache flushed successfully\.['"][\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]check['"][\s\S]*?\}\s*\)/
    )
    expect(flushCache).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)[\s\S]*?\}/)
    expect(flushCache).toMatch(
      /finally\s*\{[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-cache-flushCache['"]\s*\)[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.activeOperation\s*=\s*['"][^'"]*['"]/
    )
    expect(flushCache).not.toMatch(/this\.\$apollo\.mutate|utilityCacheFlushCacheMutation/)
    expect(flushCache).not.toMatch(directRootUiCommit)
  })

  test('flushUploads remains confirmation-gated and preserves REST state boundaries', () => {
    expect(flushUploads).not.toBeNull()

    expect(source).toMatch(/@click=['"]confirmationDialog\s*=\s*true['"]/)
    expect(source).toMatch(/v-dialog\s*\(\s*v-model=['"]confirmationDialog['"][\s\S]*?\bpersistent\b/)
    expect(source).toMatch(/@click=['"]confirmationDialog\s*=\s*false;\s*flushUploads\(\)['"]/)
    expect(source).not.toMatch(/@click=['"]flushUploads(?:\(\))?['"]/)

    expect(flushUploads).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.activeOperation\s*=\s*['"]uploads['"][\s\S]*?wikiStore\.startLoading\s*\(\s*['"]admin-utilities-cache-flushUploads['"]\s*\)[\s\S]*?await\s+flushSystemTemporaryUploads\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/
    )
    expect(flushUploads).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{[\s\S]*?message:\s*['"]Temporary uploads deleted successfully\.['"][\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]check['"][\s\S]*?\}\s*\)/
    )
    expect(flushUploads).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)[\s\S]*?\}/)
    expect(flushUploads).toMatch(
      /finally\s*\{[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-cache-flushUploads['"]\s*\)[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.activeOperation\s*=\s*['"][^'"]*['"]/
    )
    expect(flushUploads).not.toMatch(/this\.\$apollo\.mutate|utilityCacheFlushUploadsMutation/)
    expect(flushUploads).not.toMatch(directRootUiCommit)
  })

  test('flushClientLocaleCache deletes a typed snapshot with explicit local state', () => {
    expect(flushClientLocaleCache).not.toBeNull()

    expect(source).toMatch(/@click=['"]flushClientLocaleCache['"][\s\S]*?:loading=['"]activeOperation === ["']locale["']['"]/)
    expect(flushClientLocaleCache).toMatch(/this\.loading\s*=\s*true[\s\S]*?this\.activeOperation\s*=\s*['"]locale['"]/)
    expect(flushClientLocaleCache).toMatch(
      /const\s+keys\s*=\s*Array\.from\s*\(\s*\{\s*length:\s*window\.localStorage\.length\s*\}[\s\S]*?window\.localStorage\.key\s*\(\s*index\s*\)[\s\S]*?\.filter\s*\(\s*\(\s*key\s*\)\s*:\s*key\s+is\s+string\s*=>\s*key\?\.startsWith\s*\(\s*['"]i18next_res['"]\s*\)\s*===\s*true\s*\)/
    )
    expect(flushClientLocaleCache).toMatch(/keys\.forEach\s*\(\s*key\s*=>\s*window\.localStorage\.removeItem\s*\(\s*key\s*\)\s*\)/)
    expect(flushClientLocaleCache).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{[\s\S]*?message:\s*['"]This browser’s locale cache was cleared successfully\.['"][\s\S]*?style:\s*['"]success['"][\s\S]*?icon:\s*['"]check['"][\s\S]*?\}\s*\)/
    )
    expect(flushClientLocaleCache).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)[\s\S]*?\}[\s\S]*?finally\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?this\.activeOperation\s*=\s*['"][^'"]*['"]/
    )
    expect(flushClientLocaleCache).not.toMatch(/\bflushSystem(?:Cache|TemporaryUploads)\s*\(/)
    expect(flushClientLocaleCache).not.toMatch(directRootUiCommit)
  })
})
