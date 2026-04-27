const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
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

describe('admin-dashboard recent pages / last logins root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-dashboard.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadRecentPages = script && extractMethod(script, 'loadRecentPages')
  const loadLastLogins = script && extractMethod(script, 'loadLastLogins')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"])\s*,/

  test('admin-dashboard.vue imports only the root UI facades needed by this slice', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{\s*fetchRecentPages\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/pages-api['"]/
    )
    expect(script).toMatch(
      /import\s+\{\s*fetchLastLogins\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/users-api['"]/
    )
  })

  test('loadRecentPages() uses loading/notification facades while preserving fetch, state, returns, and cleanup order', () => {
    expect(loadRecentPages).not.toBeNull()

    expect(loadRecentPages).toMatch(/async\s+loadRecentPages\s*\(\s*\)\s*\{\s*this\.recentPagesLoading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-dashboard-recentpages['"]\s*\)\s*try\s*\{\s*this\.recentPages\s*=\s*await\s+fetchRecentPages\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Recent pages response is invalid['"]\s*\)\s*return\s+true\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.recentPages\s*=\s*\[\]\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*err\.message\s*,\s*style:\s*['"]error['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*return\s+false\s*\}\s*finally\s*\{\s*this\.recentPagesLoading\s*=\s*false\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-dashboard-recentpages['"]\s*\)\s*\}\s*\}/)
    expect(loadRecentPages).not.toMatch(directRootUiCommit)

    expect(loadRecentPages.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadRecentPages.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadRecentPages.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('loadLastLogins() uses loading/notification facades while preserving fetch, state, returns, and cleanup order', () => {
    expect(loadLastLogins).not.toBeNull()

    expect(loadLastLogins).toMatch(/async\s+loadLastLogins\s*\(\s*\)\s*\{\s*this\.lastLoginsLoading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-dashboard-lastlogins['"]\s*\)\s*try\s*\{\s*this\.lastLogins\s*=\s*await\s+fetchLastLogins\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Last logins response is invalid['"]\s*\)\s*return\s+true\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.lastLogins\s*=\s*\[\]\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*err\.message\s*,\s*style:\s*['"]error['"]\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*return\s+false\s*\}\s*finally\s*\{\s*this\.lastLoginsLoading\s*=\s*false\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-dashboard-lastlogins['"]\s*\)\s*\}\s*\}/)
    expect(loadLastLogins).not.toMatch(directRootUiCommit)

    expect(loadLastLogins.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadLastLogins.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLastLogins.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
