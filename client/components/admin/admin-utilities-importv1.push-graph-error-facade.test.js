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

describe('admin utilities import v1 wiki store error migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-importv1.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const executeImport = script && extractMethod(script, 'executeImport')

  test('executeImport routes both active import failure paths through wikiStore.showError', () => {
    expect(script).not.toBeNull()
    expect(executeImport).not.toBeNull()

    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/export\s+default\s+defineComponent\s*\(\s*\{/)
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bexecuteStorageAction\b)(?=[^}]*\bfetchStorageStatus\b)(?=[^}]*\bfetchStorageTargets\b)(?=[^}]*\bsaveStorageTargets\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/storage-api['"]/
    )
    expect(script).toContain("import { importV1Users } from '../../helpers/system-api'")
    expect(source).toContain("@click='startImport'")
    expect(source).toContain("v-dialog(v-model='confirmImport'")
    expect(source).toContain("@click='confirmImport = false; executeImport()'")
    expect(script).toMatch(/startImport\s*\(\s*\)\s*\{\s*if\s*\(\s*!this\.canStartImport\s*\)\s*return\s*this\.confirmImport\s*=\s*true\s*\}/)
    expect(executeImport).not.toMatch(/\bthis\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,/)
    expect(executeImport).toContain('const result = await importV1Users(')
    expect(executeImport).toContain('this.successUsers = result.usersCount')
    expect(executeImport).toContain('this.successGroups = result.groupsCount')
    expect(executeImport).toContain('this.failedUsers = normalizeFailedUsers(result.failed)')
    expect(executeImport).not.toMatch(/graphql-tag|\$apollo/)

    expect(executeImport).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*this\.userStage\s*=\s*['"]failed['"]\s*this\.userStageError\s*=[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)\s*\}/
    )
    expect(executeImport).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*this\.contentStage\s*=\s*['"]failed['"]\s*this\.contentStageError\s*=[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)\s*\}/
    )
    const showErrorCalls = executeImport.match(/\bwikiStore\.showError\s*\(\s*err\s*\)/g) || []
    expect(showErrorCalls).toHaveLength(2)
  })

  test('executeImport preserves v1 import, credential plumbing, typed storage save, and partial-result flow', () => {
    expect(executeImport).not.toBeNull()

    expect(executeImport).toMatch(/this\.isLoading\s*=\s*true\s*this\.isSuccess\s*=\s*false\s*this\.progress\s*=\s*0\s*this\.failedUsers\s*=\s*\[\]/)
    expect(executeImport).toMatch(/importV1Users\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.dbConnStr\s*,\s*this\.groupMode\s*\)/)
    expect(executeImport).toMatch(/const\s+nStr:\s*StorageTarget\s*=\s*\{/)
    expect(executeImport).toMatch(/\{\s*key:\s*['"]sshPrivateKeyContent['"]\s*,\s*value:\s*\{\s*value:\s*this\.gitPrivKey\s*\}\s*\}/)
    expect(executeImport).toMatch(/\{\s*key:\s*['"]basicPassword['"]\s*,\s*value:\s*\{\s*value:\s*this\.gitPassword\s*\}\s*\}/)
    expect(executeImport).toMatch(/\{\s*key:\s*['"]path['"]\s*,\s*value:\s*\{\s*value:\s*this\.contentPath\s*\}\s*\}/)
    expect(executeImport).toMatch(
      /saveStorageTargets\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*targets\.map\s*\(\s*target\s*=>\s*\(\s*\{\s*isEnabled:\s*target\.isEnabled\s*,\s*key:\s*target\.key\s*,\s*config:\s*target\.config\.map\s*\(\s*config\s*=>\s*\(\s*\{/
    )
    expect(executeImport).toMatch(/value:\s*JSON\.stringify\s*\(\s*\{\s*v:\s*config\.value\.value\s*\}\s*\)/)
    expect(executeImport).toMatch(/mode:\s*target\.mode\s*,\s*syncInterval:\s*target\.syncInterval/)
    expect(executeImport).toMatch(/executeStorageAction\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.contentMode\s*,\s*['"]importAll['"]\s*\)/)
    expect(executeImport).toMatch(
      /const\s+allSucceeded\s*=[\s\S]*if\s*\(\s*allSucceeded\s*\)\s*this\.progress\s*=\s*100\s*this\.isLoading\s*=\s*false\s*this\.isSuccess\s*=\s*true/
    )
    expect(source).toContain('v-if=\'userStage === "failed"\'')
    expect(source).toContain('v-if=\'contentStage === "failed"\'')
    expect(source).toContain("v-model='isSuccess'")
  })
})
