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

describe('admin-groups-edit-users unassign REST migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups-edit-users.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const unassignUser = script && extractMethod(script, 'unassignUser')

  test('admin-groups-edit-users imports the REST helper and root UI facades for unassign', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{\s*unassignGroupUser\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).not.toMatch(/groups-mutation-unassign\.gql/)
    expect(script).not.toMatch(/unassignUserMutation/)
  })

  test('unassignUser() calls REST while preserving loading, notifications, and refresh behavior', () => {
    expect(unassignUser).not.toBeNull()
    expect(unassignUser).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-unassign['"]\s*\)/)
    expect(unassignUser).toMatch(/await\s+unassignGroupUser\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.group\.id\s*,\s*id\s*\)/)
    expect(unassignUser).not.toMatch(/this\.\$apollo\.mutate/)
    expect(unassignUser).not.toMatch(/unassignUserMutation/)
    expect(unassignUser).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`User has been unassigned from \$\{this\.group\.name\}\.`\s*,\s*icon:\s*['"]assignment_ind['"]\s*\}\s*\)/)
    expect(unassignUser).toMatch(/this\.\$emit\s*\(\s*['"]refresh['"]\s*\)/)
    expect(unassignUser).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*err\.message\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)/)
    expect(unassignUser).toMatch(/finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-unassign['"]\s*\)\s*\}/)
  })
})
