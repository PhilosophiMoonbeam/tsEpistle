const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp('async\\s+' + name + '\\s*\\('))
  if (methodStart === -1) {
    return null
  }

  const bodyStart = script.indexOf('{', methodStart)
  let depth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      depth++
    } else if (script[idx] === '}') {
      depth--
      if (depth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-api REST mutation migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-api.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const globalSwitch = script && extractMethod(script, 'globalSwitch')
  const revokeConfirm = script && extractMethod(script, 'revokeConfirm')

  test('admin-api.vue imports API mutation REST helpers and no longer uses inline GraphQL mutations', () => {
    expect(script).toContain('fetchAdminApiBootstrap')
    expect(script).toContain('revokeAdminApiKey')
    expect(script).toContain('setAdminApiState')
    expect(script).toContain('../../helpers/auth-api')
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo.mutate')
    expect(script).not.toContain('mutation: gql`')
    expect(script).not.toMatch(/\bsetApiState\s*\(/)
    expect(script).not.toMatch(/\brevokeApiKey\s*\(/)
  })

  test('globalSwitch() uses REST helper while preserving refresh, loading, and notification flow', () => {
    expect(globalSwitch).not.toBeNull()
    expect(globalSwitch).toMatch(/this\.\$store\.commit\(\s*['"]loadingStart['"]\s*,\s*['"]admin-api-toggle['"]\s*\)/)
    expect(globalSwitch).toMatch(/await\s+setAdminApiState\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*!this\.enabled\s*\)/)
    expect(globalSwitch).toMatch(/const\s+loaded\s*=\s*await\s+this\.refresh\(\s*false\s*\)/)
    expect(globalSwitch).toMatch(/admin:api\.toggleStateDisabledSuccess/)
    expect(globalSwitch).toMatch(/admin:api\.toggleStateEnabledSuccess/)
    expect(globalSwitch).toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(globalSwitch).toMatch(/this\.\$store\.commit\(\s*['"]loadingStop['"]\s*,\s*['"]admin-api-toggle['"]\s*\)/)
    expect(globalSwitch).toMatch(/this\.isToggleLoading\s*=\s*false/)
  })

  test('revokeConfirm() uses REST helper while preserving refresh, dialog, loading, and notification flow', () => {
    expect(revokeConfirm).not.toBeNull()
    expect(revokeConfirm).toMatch(/this\.\$store\.commit\(\s*['"]loadingStart['"]\s*,\s*['"]admin-api-revoke['"]\s*\)/)
    expect(revokeConfirm).toMatch(/await\s+revokeAdminApiKey\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.current\.id\s*\)/)
    expect(revokeConfirm).toMatch(/const\s+loaded\s*=\s*await\s+this\.refresh\(\s*false\s*\)/)
    expect(revokeConfirm).toMatch(/admin:api\.revokeSuccess/)
    expect(revokeConfirm).toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(revokeConfirm).toMatch(/this\.\$store\.commit\(\s*['"]loadingStop['"]\s*,\s*['"]admin-api-revoke['"]\s*\)/)
    expect(revokeConfirm).toMatch(/this\.isRevokeConfirmDialogShown\s*=\s*false/)
    expect(revokeConfirm).toMatch(/this\.revokeLoading\s*=\s*false/)
  })
})
