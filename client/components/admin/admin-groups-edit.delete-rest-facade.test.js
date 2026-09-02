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

  let bodyDepth = 0
  for (let idx = bodyStart; idx < script.length; idx++) {
    if (script[idx] === '{') {
      bodyDepth++
    } else if (script[idx] === '}') {
      bodyDepth--
      if (bodyDepth === 0) {
        return script.slice(methodStart, idx + 1)
      }
    }
  }

  return null
}

describe('admin-groups-edit delete REST migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups-edit.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const deleteGroupMethod = script && extractMethod(script, 'deleteGroup')

  test('admin-groups-edit imports the delete REST helper and typed wiki store', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{(?=[^}]*\bdeleteGroup\b)(?=[^}]*\bfetchGroupDetails\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(script).toMatch(/import\s+\{\s*wikiStore\s*\}\s+from\s+['"]@\/store\/index\.ts['"]/)
  })

  test('deleteGroup() guards readiness and stale request ownership while preserving the REST contract and cleanup', () => {
    expect(deleteGroupMethod).not.toBeNull()
    expect(deleteGroupMethod).toMatch(/if\s*\(\s*!this\.groupReady\s*\|\|\s*this\.groupAction\s*!==\s*['"]['"]\s*\)\s*return/)
    expect(deleteGroupMethod).toMatch(
      /const\s+requestId\s*=\s*this\.groupLoadRequestId\s*[\s\S]*const\s+groupId\s*=\s*this\.group\.id\s*[\s\S]*const\s+groupName\s*=\s*this\.group\.name\s*[\s\S]*this\.groupAction\s*=\s*['"]delete['"]/
    )
    expect(deleteGroupMethod).toMatch(/this\.deleteGroupDialog\s*=\s*false/)
    expect(deleteGroupMethod).toMatch(/wikiStore\.startLoading\s*\(\s*['"]admin-groups-delete['"]\s*\)/)
    expect(deleteGroupMethod).toMatch(/await\s+deleteGroup\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*groupId\s*\)/)
    expect(deleteGroupMethod).toMatch(
      /if\s*\(\s*requestId\s*!==\s*this\.groupLoadRequestId\s*\|\|\s*groupId\s*!==\s*this\.group\.id\s*\)\s*return\s*[\s\S]*wikiStore\.showNotification/
    )
    expect(deleteGroupMethod).not.toMatch(/this\.\$apollo\.mutate/)
    expect(deleteGroupMethod).not.toMatch(/delete\s*\(\s*id:\s*\$id\s*\)/)
    expect(deleteGroupMethod).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`Group \$\{groupName\} has been deleted\.`\s*,\s*icon:\s*['"]delete['"]\s*\}\s*\)/
    )
    expect(deleteGroupMethod).toMatch(/this\.\$router\.replace\s*\(\s*['"]\/groups['"]\s*\)/)
    expect(deleteGroupMethod).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{\s*if\s*\(\s*requestId\s*===\s*this\.groupLoadRequestId\s*&&\s*groupId\s*===\s*this\.group\.id\s*\)\s*\{\s*wikiStore\.showError\s*\(\s*err\s*\)\s*\}\s*\}/
    )
    expect(deleteGroupMethod).toMatch(
      /finally\s*\{\s*wikiStore\.stopLoading\s*\(\s*['"]admin-groups-delete['"]\s*\)\s*if\s*\(\s*requestId\s*===\s*this\.groupLoadRequestId\s*&&\s*groupId\s*===\s*this\.group\.id\s*\)\s*\{\s*this\.groupAction\s*=\s*['"]['"]\s*\}\s*\}/
    )
    expect(deleteGroupMethod).not.toMatch(/\$store\.commit/)
  })
})
