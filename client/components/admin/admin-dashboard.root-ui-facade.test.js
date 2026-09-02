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
    expect(script).toContain("import { markRaw } from 'vue'")
    expect(script).toMatch(
      /const\s+RECENT_PAGES_HEADERS\s*=\s*markRaw\s*\(\s*\[\s*\{\s*title:\s*['"]Title['"],\s*value:\s*['"]title['"]\s*\},\s*\{\s*title:\s*['"]Path['"],\s*value:\s*['"]path['"]\s*\},\s*\{\s*title:\s*['"]Last Updated['"],\s*value:\s*['"]updatedAt['"],\s*width:\s*250\s*\}\s*\]\s*\)/
    )
    expect(script).toMatch(
      /const\s+LAST_LOGINS_HEADERS\s*=\s*markRaw\s*\(\s*\[\s*\{\s*title:\s*['"]User['"],\s*value:\s*['"]name['"]\s*\},\s*\{\s*title:\s*['"]Last Login['"],\s*value:\s*['"]lastLoginAt['"],\s*width:\s*250\s*\}\s*\]\s*\)/
    )
    expect(script).toMatch(/recentPagesHeaders:\s*RECENT_PAGES_HEADERS/)
    expect(script).toMatch(/lastLoginsHeaders:\s*LAST_LOGINS_HEADERS/)
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

  test('loadRecentPages() uses generation and permission guards around facade-managed request state', () => {
    expect(loadRecentPages).not.toBeNull()

    expectInOrder(loadRecentPages, [
      'const requestId = ++this.recentPagesRequestId',
      'this.recentPagesLoading = true',
      "this.recentPagesError = ''",
      "loadingStart(wikiStore, 'admin-dashboard-recentpages')",
      "const pages = await fetchRecentPages(window.fetch.bind(window), 'Recent pages response is invalid')",
      'if (requestId !== this.recentPagesRequestId || !this.canViewRecentPages) return false',
      'this.recentPages = markRaw(pages)',
      'return true',
      'if (requestId !== this.recentPagesRequestId || !this.canViewRecentPages) return false',
      'this.recentPagesError = getErrorMessage(err)',
      "showNotification(wikiStore, { message: this.recentPagesError, style: 'error', icon: 'alert' })",
      'return false',
      "loadingStop(wikiStore, 'admin-dashboard-recentpages')",
      'if (requestId === this.recentPagesRequestId) this.recentPagesLoading = false'
    ])
    expect(loadRecentPages).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?requestId\s*!==\s*this\.recentPagesRequestId\s*\|\|\s*!this\.canViewRecentPages[\s\S]*?this\.recentPagesError\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?showNotification\s*\(/
    )
    expect(loadRecentPages).toMatch(
      /finally\s*\{[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-dashboard-recentpages['"]\s*\)[\s\S]*?requestId\s*===\s*this\.recentPagesRequestId[\s\S]*?this\.recentPagesLoading\s*=\s*false[\s\S]*?\}/
    )
    expect(loadRecentPages).not.toMatch(directRootUiCommit)

    expect(loadRecentPages.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadRecentPages.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadRecentPages.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('loadLastLogins() uses generation and permission guards around facade-managed request state', () => {
    expect(loadLastLogins).not.toBeNull()

    expectInOrder(loadLastLogins, [
      'const requestId = ++this.lastLoginsRequestId',
      'this.lastLoginsLoading = true',
      "this.lastLoginsError = ''",
      "loadingStart(wikiStore, 'admin-dashboard-lastlogins')",
      "const users = await fetchLastLogins(window.fetch.bind(window), 'Last logins response is invalid')",
      'if (requestId !== this.lastLoginsRequestId || !this.canViewLastLogins) return false',
      'this.lastLogins = markRaw(users)',
      'return true',
      'if (requestId !== this.lastLoginsRequestId || !this.canViewLastLogins) return false',
      'this.lastLoginsError = getErrorMessage(err)',
      "showNotification(wikiStore, { message: this.lastLoginsError, style: 'error', icon: 'alert' })",
      'return false',
      "loadingStop(wikiStore, 'admin-dashboard-lastlogins')",
      'if (requestId === this.lastLoginsRequestId) this.lastLoginsLoading = false'
    ])
    expect(loadLastLogins).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?requestId\s*!==\s*this\.lastLoginsRequestId\s*\|\|\s*!this\.canViewLastLogins[\s\S]*?this\.lastLoginsError\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?showNotification\s*\(/
    )
    expect(loadLastLogins).toMatch(
      /finally\s*\{[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-dashboard-lastlogins['"]\s*\)[\s\S]*?requestId\s*===\s*this\.lastLoginsRequestId[\s\S]*?this\.lastLoginsLoading\s*=\s*false[\s\S]*?\}/
    )
    expect(loadLastLogins).not.toMatch(directRootUiCommit)

    expect(loadLastLogins.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadLastLogins.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadLastLogins.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
