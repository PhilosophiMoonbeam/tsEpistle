const fs = require('fs')
const path = require('path')

const extractScript = source => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
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

  test('admin-groups-edit imports the delete REST helper and root UI facades', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{(?=[^}]*\bdeleteGroup\b)(?=[^}]*\bfetchGroupDetails\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
  })

  test('deleteGroup() calls REST while preserving loading, notification, navigation, and error behavior', () => {
    expect(deleteGroupMethod).not.toBeNull()
    expect(deleteGroupMethod).toMatch(/this\.deleteGroupDialog\s*=\s*false/)
    expect(deleteGroupMethod).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-delete['"]\s*\)/)
    expect(deleteGroupMethod).toMatch(/await\s+deleteGroup\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.group\.id\s*\)/)
    expect(deleteGroupMethod).not.toMatch(/this\.\$apollo\.mutate/)
    expect(deleteGroupMethod).not.toMatch(/delete\s*\(\s*id:\s*\$id\s*\)/)
    expect(deleteGroupMethod).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`Group \$\{this\.group\.name\} has been deleted\.`\s*,\s*icon:\s*['"]delete['"]\s*\}\s*\)/)
    expect(deleteGroupMethod).toMatch(/this\.\$router\.replace\s*\(\s*['"]\/groups['"]\s*\)/)
    expect(deleteGroupMethod).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(deleteGroupMethod).toMatch(/finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-delete['"]\s*\)\s*\}/)
  })
})
