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

describe('admin-ssl loadInfo root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-ssl.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadInfo = script && extractMethod(script, 'loadInfo')
  const toggleRedir = script && extractMethod(script, 'toggleRedir')
  const renewCertificate = script && extractMethod(script, 'renewCertificate')
  const rootUiImportMatch = script && script.match(
    /import\s+\{([^}]+)\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
  )
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-ssl.vue imports the root UI facades required by SSL methods', () => {
    expect(script).not.toBeNull()
    expect(rootUiImportMatch).not.toBeNull()

    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSystemSsl\b)(?=[^}]*\bupdateSystemSslRedirection\b)(?=[^}]*\brenewSystemSslCertificate\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/
    )
  })

  test('loadInfo() uses loading and error facades while preserving SSL fetch/reset/rethrow/cleanup behavior', () => {
    expect(loadInfo).not.toBeNull()

    expect(loadInfo).toMatch(/async\s+loadInfo\s*\(\s*\{\s*notifyError\s*=\s*true\s*\}\s*=\s*\{\s*\}\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-ssl-refresh['"]\s*\)\s*try\s*\{\s*this\.info\s*=\s*await\s+fetchSystemSsl\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]SSL status response is invalid['"]\s*\)\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*this\.info\s*=\s*makeDefaultSslInfo\s*\(\s*\)\s*if\s*\(\s*notifyError\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-ssl-refresh['"]\s*\)\s*\}\s*\}/)
    expect(loadInfo).not.toMatch(directRootUiCommit)

    expect(loadInfo.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('toggleRedir() and renewCertificate() use REST helpers and root UI facades while preserving behavior', () => {
    expect(toggleRedir).not.toBeNull()
    expect(renewCertificate).not.toBeNull()

    expect(script).not.toMatch(/graphql-tag/)
    expect(script).not.toMatch(/this\.\$apollo|gql`|setHTTPSRedirection|renewHTTPSCertificate/)

    expect(toggleRedir).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-ssl-toggleRedirection['"]\s*\)/)
    expect(toggleRedir).toMatch(/updateSystemSslRedirection\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*_.get\(\s*this\.info\s*,\s*['"]httpRedirection['"]\s*,\s*false\s*\)\s*\)/)
    expect(toggleRedir).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{[\s\S]*?admin:ssl\.httpPortRedirectSaveSuccess[\s\S]*?\}\s*\)/)
    expect(toggleRedir).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(toggleRedir).toMatch(/this\.info\.httpRedirection\s*=\s*!this\.info\.httpRedirection[\s\S]*catch\s*\(\s*err\s*\)\s*\{\s*this\.info\.httpRedirection\s*=\s*!this\.info\.httpRedirection/)
    expect(toggleRedir).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-ssl-toggleRedirection['"]\s*\)/)
    expect(toggleRedir).toMatch(/this\.loadingRedir\s*=\s*false/)
    expect(toggleRedir).not.toMatch(directRootUiCommit)
    expect(toggleRedir).not.toMatch(/this\.\$store\.commit\s*\(/)

    expect(renewCertificate).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-ssl-renew['"]\s*\)/)
    expect(renewCertificate).toMatch(/renewSystemSslCertificate\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*\)/)
    expect(renewCertificate).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{[\s\S]*?admin:ssl\.renewCertificateSuccess[\s\S]*?\}\s*\)/)
    expect(renewCertificate).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(renewCertificate).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-ssl-renew['"]\s*\)/)
    expect(renewCertificate).toMatch(/this\.loadingRenew\s*=\s*false/)
    expect(renewCertificate).not.toMatch(directRootUiCommit)
    expect(renewCertificate).not.toMatch(/this\.\$store\.commit\s*\(/)
  })
})
