const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`async\\s+${name}\\s*\\(`))

  if (methodStart === -1) {
    return null
  }

  const openBrace = script.indexOf('{', methodStart)

  if (openBrace === -1) {
    return null
  }

  let depth = 0

  for (let idx = openBrace; idx < script.length; idx++) {
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

describe('admin utilities import v1 pushGraphError facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-importv1.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const startImport = script && extractMethod(script, 'startImport')

  test('startImport routes both active import failure paths through root-ui-store pushGraphError', () => {
    expect(script).not.toBeNull()
    expect(startImport).not.toBeNull()

    expect(script).toMatch(/import\s+\{[^}]*\bpushGraphError\b[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{\s*executeStorageAction\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/)
    expect(script).not.toContain('targetExecuteActionMutation')
    expect(startImport).not.toMatch(/\bthis\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,/)

    const pushGraphErrorCalls = startImport.match(/\bpushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/g) || []
    expect(pushGraphErrorCalls).toHaveLength(2)

    expect(startImport).toMatch(/mutation:\s*utilityImportv1UsersMutation[\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*return\s*\}/)
    expect(startImport).toMatch(/query:\s*storageTargetsQuery[\s\S]*?executeStorageAction\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.contentMode\s*,\s*['"]importAll['"][\s\S]*?catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*this\.isLoading\s*=\s*false\s*return\s*\}/)
  })

  test('startImport preserves v1 import, credential plumbing, storage save, and success flow', () => {
    expect(startImport).not.toBeNull()

    expect(startImport).toMatch(/this\.isLoading\s*=\s*true\s*this\.progress\s*=\s*0\s*this\.failedUsers\s*=\s*\[\]/)
    expect(startImport).toMatch(/mongoDbConnString:\s*this\.dbConnStr/)
    expect(startImport).toMatch(/groupMode:\s*this\.groupMode/)
    expect(startImport).toMatch(/\{\s*key:\s*['"]sshPrivateKeyContent['"]\s*,\s*value:\s*\{\s*value:\s*this\.gitPrivKey\s*\}\s*\}/)
    expect(startImport).toMatch(/\{\s*key:\s*['"]basicPassword['"]\s*,\s*value:\s*\{\s*value:\s*this\.gitPassword\s*\}\s*\}/)
    expect(startImport).toMatch(/\{\s*key:\s*['"]path['"]\s*,\s*value:\s*\{\s*value:\s*this\.contentPath\s*\}\s*\}/)
    expect(startImport).toMatch(/mutation:\s*targetsSaveMutation[\s\S]*?targets:\s*targets\.map\s*\(\s*tgt\s*=>\s*_\.pick\s*\(\s*tgt\s*,\s*\[/)
    expect(startImport).toMatch(/JSON\.stringify\s*\(\s*\{\s*v:\s*cfg\.value\.value\s*\}\s*\)/)
    expect(startImport).toMatch(/executeStorageAction\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.contentMode\s*,\s*['"]importAll['"]\s*\)/)
    expect(startImport).toMatch(/this\.isLoading\s*=\s*false\s*this\.isSuccess\s*=\s*true/)
  })
})
