import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

const expectInOrder = (source, snippets) => {
  let offset = 0
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, offset)
    expect(index).toBeGreaterThanOrEqual(0)
    offset = index + snippet.length
  }
}

describe('admin-dashboard recent pages / last logins root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-dashboard.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadRecentPages = script && extractMethod(script, 'loadRecentPages')
  const loadLastLogins = script && extractMethod(script, 'loadLastLogins')
  const directRootUiCommit =
    /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"])\s*,/

  test('admin-dashboard.vue imports the typed API rows, wiki store, and root UI facades needed by this slice', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bgetErrorMessage\b)(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchRecentPages\b)(?=[^}]*\btype RecentPageRow\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/pages-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchLastLogins\b)(?=[^}]*\btype LastLoginRow\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/users-api['"]/)
    expect(script).toMatch(/recentPages:\s*\[\]\s+as\s+RecentPageRow\[\]/)
    expect(script).toMatch(/lastLogins:\s*\[\]\s+as\s+LastLoginRow\[\]/)
  })

  test('uses the shared compact hero with the configured workspace identity and deployed build status', () => {
    expect(source).toMatch(
      /admin-hero\([\s\S]*?:title='\$t\(`admin:dashboard\.title`\)'[\s\S]*?:description='siteTitle'[\s\S]*?icon='\/_assets\/svg\/icon-features-list\.svg'[\s\S]*?eyebrow='Control room'/
    )
    expect(source).toContain('template(#status)')
    expect(source).toContain('Deployed build')
    expect(source).toContain("siteTitle() { return wikiStore.site.title?.trim() || 'tsFranki' },")
    expect(source.match(/\{\{ siteTitle \}\}/g) || []).toHaveLength(2)
    expect(source).toContain('strong tsFranki {{ info.product.version }}')
    expect(source).not.toContain('info.product.upstreamBase')
    expect(source).not.toMatch(/Wiki\.js/i)
    expect(source).not.toContain('.admin-header')
    expect(source).not.toContain('admin-dashboard__header')
  })

  test('keeps every metric contract while using the shorter dashboard card rhythm', () => {
    expect(source).toMatch(
      /\.admin-stat\s*\{[\s\S]*?min-height:\s*calc\(var\(--wiki-control-height\) \+ var\(--wiki-space-10\)\);[\s\S]*?align-items:\s*center;[\s\S]*?gap:\s*var\(--wiki-space-3\);[\s\S]*?padding:\s*var\(--wiki-space-3\) var\(--wiki-space-4\);/
    )
    expect(source).not.toContain('min-height: 8.5rem')
    expect(source).not.toContain('min-height: 7.5rem')
    expect(source).toContain("v-if='stat.value !== undefined'")
    expect(source).toContain(":to='stat.to'")
    expect(source).toContain('{{ stat.hint }}')
    expect(source).toContain("{ key: 'version', label: 'Current build'")
  })

  test('loadRecentPages() uses loading/notification facades while preserving fetch, state, returns, and cleanup order', () => {
    expect(loadRecentPages).not.toBeNull()

    expectInOrder(loadRecentPages, [
      'this.recentPagesLoading = true',
      "this.recentPagesError = ''",
      "loadingStart(wikiStore, 'admin-dashboard-recentpages')",
      "this.recentPages = await fetchRecentPages(window.fetch.bind(window), 'Recent pages response is invalid')",
      'return true',
      'this.recentPagesError = getErrorMessage(err)',
      "showNotification(wikiStore, { message: this.recentPagesError, style: 'error', icon: 'alert' })",
      'return false',
      'this.recentPagesLoading = false',
      "loadingStop(wikiStore, 'admin-dashboard-recentpages')"
    ])
    expect(loadRecentPages).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?this\.recentPagesError\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?showNotification\s*\(/
    )
    expect(loadRecentPages).toMatch(
      /finally\s*\{[\s\S]*?this\.recentPagesLoading\s*=\s*false[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-dashboard-recentpages['"]\s*\)\s*\}/
    )
    expect(loadRecentPages).not.toMatch(directRootUiCommit)

    expect(loadRecentPages.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadRecentPages.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadRecentPages.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('loadLastLogins() uses loading/notification facades while preserving fetch, state, returns, and cleanup order', () => {
    expect(loadLastLogins).not.toBeNull()

    expectInOrder(loadLastLogins, [
      'this.lastLoginsLoading = true',
      "this.lastLoginsError = ''",
      "loadingStart(wikiStore, 'admin-dashboard-lastlogins')",
      "this.lastLogins = await fetchLastLogins(window.fetch.bind(window), 'Last logins response is invalid')",
      'return true',
      'this.lastLoginsError = getErrorMessage(err)',
      "showNotification(wikiStore, { message: this.lastLoginsError, style: 'error', icon: 'alert' })",
      'return false',
      'this.lastLoginsLoading = false',
      "loadingStop(wikiStore, 'admin-dashboard-lastlogins')"
    ])
    expect(loadLastLogins).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?this\.lastLoginsError\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?showNotification\s*\(/)
    expect(loadLastLogins).toMatch(
      /finally\s*\{[\s\S]*?this\.lastLoginsLoading\s*=\s*false[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-dashboard-lastlogins['"]\s*\)\s*\}/
    )
    expect(loadLastLogins).not.toMatch(directRootUiCommit)

    expect(loadLastLogins.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadLastLogins.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLastLogins.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
