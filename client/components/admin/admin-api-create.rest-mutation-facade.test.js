import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractGenerate = script => {
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
    expect(source).toMatch(/<script\s+lang=["']ts["']>/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bcreateAdminApiKey\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/auth-api['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).not.toMatch(/graphql-tag|this\.\$apollo\.mutate|mutation\s*:\s*gql`|createApiKey\s*\(/)
  })

  test('generate() preserves the scoped REST payload, refresh result, loading, and one-time key acknowledgement flow', () => {
    expect(generate).not.toBeNull()
    expect(generate).toContain('const normalizedName = this.name.trim()')
    expect(generate).toContain('this.name = normalizedName')
    expect(generate).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-api-create['"]\s*\)/)
    expect(generate).toMatch(
      /const\s+resp\s*=\s*await\s+createAdminApiKey\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*\{[\s\S]*?name:\s*this\.name[\s\S]*?expiration:\s*this\.expiration[\s\S]*?fullAccess:\s*this\.scope\s*===\s*['"]full['"][\s\S]*?group:\s*this\.scope\s*===\s*['"]group['"]\s*\?\s*this\.group\s*:\s*null[\s\S]*?\}\s*\)/
    )
    expect(generate).toMatch(
      /const\s+refreshed\s*=\s*this\.refreshApiKeys\s*\?\s*await\s+\(\s*this\.refreshApiKeys\s+as\s+\(\s*notify:\s*boolean\s*\)\s*=>\s*Promise<boolean>\s*\)\s*\(\s*false\s*\)\s*:\s*true/
    )

    const normalizeIndex = generate.indexOf('const normalizedName = this.name.trim()')
    const normalizedAssignmentIndex = generate.indexOf('this.name = normalizedName')
    const createIndex = generate.indexOf('await createAdminApiKey(')
    const refreshIndex = generate.indexOf('await (this.refreshApiKeys')
    const keyIndex = generate.indexOf('this.key = resp.key')
    const dialogIndex = generate.indexOf('this.isCopyKeyDialogShown = true')
    expect(normalizeIndex).toBeGreaterThan(-1)
    expect(normalizedAssignmentIndex).toBeGreaterThan(normalizeIndex)
    expect(createIndex).toBeGreaterThan(normalizedAssignmentIndex)
    expect(refreshIndex).toBeGreaterThan(createIndex)
    expect(keyIndex).toBeGreaterThan(refreshIndex)
    expect(dialogIndex).toBeGreaterThan(keyIndex)

    expect(generate).toMatch(
      /if\s*\(\s*refreshed\s*\)\s*\{[\s\S]*?wikiStore\.showNotification\s*\(\s*\{[\s\S]*?message:\s*this\.\$t\s*\(\s*['"]admin:api\.newKeySuccess['"]\s*\)[\s\S]*?\}\s*\)/
    )
    expect(generate).toMatch(/catch\s*\(\s*err\s*\)\s*\{[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)/)
    expect(generate).toMatch(/finally\s*\{[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-api-create['"]\s*\)[\s\S]*?this\.loading\s*=\s*false/)

    expect(source).toMatch(/v-dialog\([\s\S]*?v-model=['"]isCopyKeyDialogShown['"][\s\S]*?\bpersistent\b[\s\S]*?\)/)
    expect(source).toMatch(/@click=['"]copyKey['"][\s\S]*?\{\{\s*copied\s*\?\s*['"]Copied['"]\s*:\s*['"]Copy key['"]\s*\}\}/)
    expect(source).toMatch(/@click=['"]finishCopyKey['"][^)]*\)\s*I’ve saved this key/)
    expect(script).toMatch(
      /async\s+copyKey\s*\(\s*\)\s*\{[\s\S]*?await\s+navigator\.clipboard\.writeText\s*\(\s*this\.key\s*\)[\s\S]*?this\.copied\s*=\s*true[\s\S]*?catch\s*\{[\s\S]*?input\?\.select\?\.\(\s*\)[\s\S]*?wikiStore\.showNotification/
    )
    expect(script).toMatch(
      /finishCopyKey\s*\(\s*\)\s*\{[\s\S]*?this\.isCopyKeyDialogShown\s*=\s*false[\s\S]*?this\.copied\s*=\s*false[\s\S]*?this\.key\s*=\s*['"]['"]/
    )
  })
})
