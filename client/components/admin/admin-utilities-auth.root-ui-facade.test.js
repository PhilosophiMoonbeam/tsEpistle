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

describe('admin utilities auth REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-auth.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const regenCerts = script && extractMethod(script, 'regenCerts')
  const resetGuest = script && extractMethod(script, 'resetGuest')
  const directRootUiCommit =
    /\$store\.commit\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-utilities-auth.vue imports REST helpers and removes auth GraphQL mutations', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)

    expect(source).toContain('@click=\'openConfirmation("certificates")\'')
    expect(source).toContain('@click=\'openConfirmation("guest")\'')
    expect(source).toContain("v-dialog(v-model='confirmationDialog'")
    expect(source).toContain('confirmAction === "certificates" ? regenCerts() : resetGuest()')
    expect(script).toMatch(/import\s+Cookies\s+from\s+['"]js-cookie['"]/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bregenerateAuthCertificates\b)(?=[^}]*\bresetGuestUser\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/auth-api['"]/
    )
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/utilities-mutation-auth-(?:regencerts|resetguest)\.gql/)
    expect(script).not.toMatch(/utilityAuth(?:Regencerts|Resetguest)Mutation/)
    expect(script).not.toMatch(/\$apollo\.mutate/)
  })

  test('regenCerts uses REST helper while preserving logout and redirect behavior', () => {
    expect(regenCerts).not.toBeNull()

    expect(regenCerts).toMatch(
      /this\.loading\s*=\s*true[\s\S]*this\.activeOperation\s*=\s*['"]certificates['"][\s\S]*wikiStore\.startLoading\s*\(\s*['"]admin-utilities-auth-regencerts['"]\s*\)/
    )
    expect(regenCerts).toMatch(/await\s+regenerateAuthCertificates\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(regenCerts).toMatch(/Cookies\.remove\s*\(\s*['"]jwt['"]\s*\)/)
    expect(regenCerts).toMatch(
      /this\.confirmationDialog\s*=\s*false[\s\S]*this\.resultMessage\s*=\s*['"]Certificates regenerated\. Redirecting to sign-in\.['"][\s\S]*this\.resultDialog\s*=\s*true/
    )
    expect(regenCerts).toMatch(/window\.setTimeout\s*\(\s*\(\s*\)\s*=>\s*window\.location\.assign\s*\(\s*['"]\/login['"]\s*\)\s*,\s*1500\s*\)/)
    expect(regenCerts).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*wikiStore\.showError\s*\(\s*err\s*\)[\s\S]*this\.confirmationDialog\s*=\s*false[\s\S]*\}/)
    expect(regenCerts).toMatch(
      /finally\s*\{[\s\S]*wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-auth-regencerts['"]\s*\)[\s\S]*this\.loading\s*=\s*false[\s\S]*this\.activeOperation\s*=\s*['"][']\s*\}/
    )
    expect(regenCerts).not.toMatch(/this\.\$apollo\.mutate|utilityAuthRegencertsMutation/)
    expect(regenCerts).not.toMatch(directRootUiCommit)
  })

  test('resetGuest uses REST helper while preserving notification and error behavior', () => {
    expect(resetGuest).not.toBeNull()

    expect(resetGuest).toMatch(
      /this\.loading\s*=\s*true[\s\S]*this\.activeOperation\s*=\s*['"]guest['"][\s\S]*wikiStore\.startLoading\s*\(\s*['"]admin-utilities-auth-resetguest['"]\s*\)/
    )
    expect(resetGuest).toMatch(/await\s+resetGuestUser\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(resetGuest).toMatch(
      /this\.confirmationDialog\s*=\s*false[\s\S]*wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Guest user was reset successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(resetGuest).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*wikiStore\.showError\s*\(\s*err\s*\)[\s\S]*this\.confirmationDialog\s*=\s*false[\s\S]*\}/)
    expect(resetGuest).toMatch(
      /finally\s*\{[\s\S]*wikiStore\.stopLoading\s*\(\s*['"]admin-utilities-auth-resetguest['"]\s*\)[\s\S]*this\.loading\s*=\s*false[\s\S]*this\.activeOperation\s*=\s*['"][']\s*\}/
    )
    expect(resetGuest).not.toMatch(/this\.\$apollo\.mutate|utilityAuthResetguestMutation/)
    expect(resetGuest).not.toMatch(directRootUiCommit)
  })
})
