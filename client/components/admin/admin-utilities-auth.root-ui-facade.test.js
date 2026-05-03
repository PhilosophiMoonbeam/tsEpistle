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

describe('admin utilities auth REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-auth.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const regenCerts = script && extractMethod(script, 'regenCerts')
  const resetGuest = script && extractMethod(script, 'resetGuest')
  const directRootUiCommit = /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-auth.vue imports REST helpers and removes auth GraphQL mutations', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/) // still used for delayed redirect
    expect(script).toMatch(/import\s+Cookies\s+from\s+['"]js-cookie['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bregenerateAuthCertificates\b)(?=[^}]*\bresetGuestUser\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/auth-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).not.toMatch(/utilities-mutation-auth-(?:regencerts|resetguest)\.gql/)
    expect(script).not.toMatch(/utilityAuth(?:Regencerts|Resetguest)Mutation/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
  })

  test('regenCerts uses REST helper while preserving logout and redirect behavior', () => {
    expect(regenCerts).not.toBeNull()

    expect(regenCerts).toMatch(/this\.loading\s*=\s*true/)
    expect(regenCerts).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-auth-regencerts['"]\s*\)/)
    expect(regenCerts).toMatch(/await\s+regenerateAuthCertificates\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(regenCerts).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]New Certificates generated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(regenCerts).toMatch(/Cookies\.remove\s*\(\s*['"]jwt['"]\s*\)/)
    expect(regenCerts).toMatch(/_\.delay\s*\([\s\S]*window\.location\.assign\s*\(\s*['"]\/login['"]\s*\)[\s\S]*,\s*1000\s*\)/)
    expect(regenCerts).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}/)
    expect(regenCerts).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-auth-regencerts['"]\s*\)/)
    expect(regenCerts).toMatch(/this\.loading\s*=\s*false/)
    expect(regenCerts).not.toMatch(/this\.\$apollo\.mutate|utilityAuthRegencertsMutation/)
    expect(regenCerts).not.toMatch(directRootUiCommit)
  })

  test('resetGuest uses REST helper while preserving notification and error behavior', () => {
    expect(resetGuest).not.toBeNull()

    expect(resetGuest).toMatch(/this\.loading\s*=\s*true/)
    expect(resetGuest).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-auth-resetguest['"]\s*\)/)
    expect(resetGuest).toMatch(/await\s+resetGuestUser\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(resetGuest).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Guest user was reset successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(resetGuest).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}/)
    expect(resetGuest).toMatch(/loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-utilities-auth-resetguest['"]\s*\)/)
    expect(resetGuest).toMatch(/this\.loading\s*=\s*false/)
    expect(resetGuest).not.toMatch(/this\.\$apollo\.mutate|utilityAuthResetguestMutation/)
    expect(resetGuest).not.toMatch(directRootUiCommit)
  })
})
