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
  const rootUiImportMatch = script && script.match(/import\s+\{([^}]+)\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
  const directRootUiCommit =
    /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-ssl.vue imports the root UI facades required by SSL methods', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(rootUiImportMatch).not.toBeNull()

    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSystemSsl\b)(?=[^}]*\bupdateSystemSslRedirection\b)(?=[^}]*\brenewSystemSslCertificate\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/system-api['"]/
    )
  })

  test('loadInfo() exposes explicit state and ignores cancelled or stale generations', () => {
    expect(loadInfo).not.toBeNull()

    expect(source).toMatch(/async-state\s*\([\s\S]*?v-if=['"]loading['"][\s\S]*?state=['"]loading['"]/)
    expect(source).toMatch(/async-state\s*\([\s\S]*?v-else-if=['"]errorMessage['"][\s\S]*?state=['"]error['"][\s\S]*?@retry=['"]loadInfo['"]/)
    expect(source).toMatch(/\.pt-3\s*\(\s*v-else-if=['"]infoLoaded['"]\s*\)/)
    expect(loadInfo).toMatch(
      /this\.loadController\?\.abort\s*\(\s*\)[\s\S]*?const\s+controller\s*=\s*new\s+AbortController\s*\(\s*\)[\s\S]*?this\.loadController\s*=\s*controller/
    )
    expect(loadInfo).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.errorMessage\s*=\s*['"]{2}[\s\S]*?this\.infoLoaded\s*=\s*false[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-ssl-refresh['"]\s*\)/
    )
    expect(loadInfo).toMatch(
      /const\s+info\s*=\s*await\s+fetchSystemSsl\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*['"]SSL status response is invalid['"]\s*\)[\s\S]*?if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.info\s*=\s*info[\s\S]*?this\.infoLoaded\s*=\s*true[\s\S]*?return\s+true/
    )
    expect(loadInfo).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s+false\s*\}[\s\S]*?this\.info\s*=\s*makeDefaultSslInfo\s*\(\s*\)[\s\S]*?this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)\s*\|\|\s*this\.\$t\s*\(\s*['"]common:error\.unexpected['"]\s*\)[\s\S]*?if\s*\(\s*notifyError\s*\)\s*\{[\s\S]*?pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)[\s\S]*?\}[\s\S]*?throw\s+err/
    )
    expect(loadInfo).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.loadController\s*===\s*controller\s*\)\s*\{\s*this\.loadController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{\s*this\.loading\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-ssl-refresh['"]\s*\)/
    )
    expect(loadInfo).not.toMatch(directRootUiCommit)

    expect(loadInfo.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('redirect and renewal actions guard concurrency and settle only their active requests', () => {
    expect(toggleRedir).not.toBeNull()
    expect(renewCertificate).not.toBeNull()

    expect(script).not.toMatch(/graphql-tag/)
    expect(script).not.toMatch(/this\.\$apollo|gql`|setHTTPSRedirection|renewHTTPSCertificate/)
    expect(source).toMatch(/:disabled=['"]loadingRenew \|\| loading \|\| !infoLoaded['"]/)
    expect(source).toMatch(/:disabled=['"]loadingRedir \|\| loading \|\| !infoLoaded['"]/)

    expect(toggleRedir).toMatch(/if\s*\(\s*this\.loadingRedir\s*\|\|\s*this\.loadingRenew\s*\|\|\s*!this\.infoLoaded\s*\)\s*return/)
    expect(toggleRedir).toMatch(
      /const\s+previousValue\s*=\s*this\.info\.httpRedirection[\s\S]*?this\.redirectionController\s*=\s*controller[\s\S]*?this\.info\.httpRedirection\s*=\s*!previousValue/
    )
    expect(toggleRedir).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-ssl-toggleRedirection['"]\s*\)/)
    expect(toggleRedir).toMatch(/updateSystemSslRedirection\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*,\s*this\.info\.httpRedirection\s*\)/)
    expect(toggleRedir).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*?admin:ssl\.httpPortRedirectSaveSuccess/
    )
    expect(toggleRedir).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}\s*this\.info\.httpRedirection\s*=\s*previousValue\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/
    )
    expect(toggleRedir).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.redirectionController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.redirectionController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{\s*this\.loadingRedir\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-ssl-toggleRedirection['"]\s*\)/
    )

    expect(renewCertificate).toMatch(
      /if\s*\([\s\S]*?this\.loadingRenew\s*\|\|[\s\S]*?this\.loadingRedir\s*\|\|[\s\S]*?!this\.infoLoaded\s*\|\|[\s\S]*?this\.info\.sslProvider\s*!==\s*['"]letsencrypt['"]\s*\|\|[\s\S]*?this\.info\.httpsPort\s*<=\s*0[\s\S]*?\)\s*return/
    )
    expect(renewCertificate).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-ssl-renew['"]\s*\)/)
    expect(renewCertificate).toMatch(/renewSystemSslCertificate\s*\(\s*createAbortableFetch\s*\(\s*controller\.signal\s*\)\s*\)/)
    expect(renewCertificate).toMatch(
      /if\s*\(\s*controller\.signal\.aborted\s*\)\s*\{\s*return\s*\}[\s\S]*?showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*?admin:ssl\.renewCertificateSuccess/
    )
    expect(renewCertificate).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*!controller\.signal\.aborted\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/
    )
    expect(renewCertificate).toMatch(
      /finally\s*\{\s*if\s*\(\s*this\.renewalController\s*===\s*controller\s*\)\s*\{[\s\S]*?this\.renewalController\s*=\s*null[\s\S]*?if\s*\(\s*!this\.isUnmounted\s*\)\s*\{\s*this\.loadingRenew\s*=\s*false[\s\S]*?\}[\s\S]*?\}[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-ssl-renew['"]\s*\)/
    )

    expect(toggleRedir).not.toMatch(directRootUiCommit)
    expect(renewCertificate).not.toMatch(directRootUiCommit)
  })
})
