import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

  test('admin-api.vue imports typed API REST helpers and the explicit wiki store without inline GraphQL mutations', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchAdminApiBootstrap\b)(?=[^}]*\brevokeAdminApiKey\b)(?=[^}]*\bsetAdminApiState\b)(?=[^}]*\btype AdminApiKey\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/auth-api['"]/)
    expect(script).toContain("import { getErrorMessage } from '../../helpers/root-ui-store'")
    expect(script).toMatch(/keys:\s*\[\]\s+as\s+AdminApiKey\[\]/)
    expect(script).toMatch(/current:\s*null\s+as\s+AdminApiKey\s*\|\s*null/)
    expect(script).toMatch(/revoke\s*\(\s*key:\s*AdminApiKey\s*\)/)
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo.mutate')
    expect(script).not.toContain('mutation: gql`')
    expect(script).not.toMatch(/\bsetApiState\s*\(/)
    expect(script).not.toMatch(/\brevokeApiKey\s*\(/)
  })

  test('globalSwitch() uses REST helper while preserving refresh, loading, notification, and error flow', () => {
    expect(globalSwitch).not.toBeNull()
    expect(globalSwitch).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-api-toggle['"]\s*\)/)
    expect(globalSwitch).toMatch(/await\s+setAdminApiState\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*!this\.enabled\s*\)/)
    expect(globalSwitch).toMatch(/const\s+loaded\s*=\s*await\s+this\.refresh\(\s*false\s*\)/)
    expect(globalSwitch).toMatch(/if\s*\(\s*loaded\s*\)\s*\{\s*wikiStore\.showNotification\s*\(\s*\{/)
    expect(globalSwitch).toMatch(/admin:api\.toggleStateDisabledSuccess/)
    expect(globalSwitch).toMatch(/admin:api\.toggleStateEnabledSuccess/)
    expect(globalSwitch).toMatch(/wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(globalSwitch).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-api-toggle['"]\s*\)/)
    expect(globalSwitch).toMatch(/this\.isToggleLoading\s*=\s*false/)
  })

  test('revokeConfirm() uses REST helper while preserving refresh, guard, dialog, loading, notification, and error flow', () => {
    expect(revokeConfirm).not.toBeNull()
    expect(revokeConfirm).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-api-revoke['"]\s*\)/)
    expect(revokeConfirm).toMatch(/if\s*\(\s*!this\.current\s*\)\s*throw\s+new\s+Error\s*\(\s*['"]No API key selected for revocation\.['"]\s*\)/)
    expect(revokeConfirm).toMatch(/await\s+revokeAdminApiKey\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.current\.id\s*\)/)
    expect(revokeConfirm).toMatch(/const\s+loaded\s*=\s*await\s+this\.refresh\(\s*false\s*\)/)
    expect(revokeConfirm).toMatch(/if\s*\(\s*loaded\s*\)\s*\{\s*wikiStore\.showNotification\s*\(\s*\{/)
    expect(revokeConfirm).toMatch(/admin:api\.revokeSuccess/)
    expect(revokeConfirm).toMatch(/wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(revokeConfirm).toMatch(/wikiStore\.stopLoading\s*\(\s*['"]admin-api-revoke['"]\s*\)/)
    expect(revokeConfirm).toMatch(/this\.isRevokeConfirmDialogShown\s*=\s*false/)
    expect(revokeConfirm).toMatch(/this\.revokeLoading\s*=\s*false/)
  })
})
