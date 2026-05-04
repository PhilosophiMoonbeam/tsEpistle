const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractGenerate = (script) => {
  const methodStart = script.search(/async\s+generate\s*\(/)
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

describe('admin-api-create REST mutation migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-api-create.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const generate = script && extractGenerate(script)

  test('admin-api-create.vue imports the create-key REST helper and no longer uses inline GraphQL mutation', () => {
    expect(script).toContain('createAdminApiKey')
    expect(script).toContain('../../helpers/auth-api')
    expect(script).not.toMatch(/graphql-tag|this\.\$apollo\.mutate|mutation\s*:\s*gql`|createApiKey\s*\(/)
  })

  test('generate() uses REST helper while preserving payload, generated-key, refresh, loading, and copy-dialog flow', () => {
    expect(generate).not.toBeNull()
    expect(generate).toMatch(/this\.\$store\.commit\(\s*['"]loadingStart['"]\s*,\s*['"]admin-api-create['"]\s*\)/)
    expect(generate).toMatch(/const\s+resp\s*=\s*await\s+createAdminApiKey\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*\{[\s\S]*?name:\s*this\.name[\s\S]*?expiration:\s*this\.expiration[\s\S]*?fullAccess:\s*\(this\.fullAccess\s*===\s*true\)[\s\S]*?group:\s*this\.group[\s\S]*?\}\s*\)/)
    expect(generate).toMatch(/const\s+refreshed\s*=\s*this\.refreshApiKeys\s*\?\s*await\s+this\.refreshApiKeys\(\s*false\s*\)\s*:\s*true/)
    expect(generate).toMatch(/this\.key\s*=\s*resp\.key/)
    expect(generate).toMatch(/this\.isCopyKeyDialogShown\s*=\s*true/)
    expect(generate).toMatch(/admin:api\.newKeySuccess/)
    expect(generate).toMatch(/this\.\$store\.commit\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(generate).toMatch(/this\.\$store\.commit\(\s*['"]loadingStop['"]\s*,\s*['"]admin-api-create['"]\s*\)/)
    expect(generate).toMatch(/this\.loading\s*=\s*false/)
  })
})
