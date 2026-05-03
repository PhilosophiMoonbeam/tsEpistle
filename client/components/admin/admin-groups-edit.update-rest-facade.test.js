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

describe('admin-groups-edit update REST migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups-edit.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const updateGroup = script && extractMethod(script, 'updateGroup')

  test('admin-groups-edit imports update REST helper and no longer imports graphql-tag', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{(?=[^}]*\bdeleteGroup\b)(?=[^}]*\bfetchGroupDetails\b)(?=[^}]*\bupdateGroup\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).not.toMatch(/graphql-tag/)
  })

  test('updateGroup() calls REST while preserving loading, notification, and error behavior', () => {
    expect(updateGroup).not.toBeNull()
    expect(updateGroup).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-update['"]\s*\)/)
    expect(updateGroup).toMatch(/await\s+updateGroup\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.group\.id\s*,\s*\{[\s\S]*name:\s*this\.group\.name[\s\S]*redirectOnLogin:\s*this\.group\.redirectOnLogin[\s\S]*permissions:\s*this\.group\.permissions[\s\S]*pageRules:\s*this\.group\.pageRules[\s\S]*\}\s*\)/)
    expect(updateGroup).not.toMatch(/this\.\$apollo\.mutate/)
    expect(updateGroup).not.toMatch(/groups\s*\{[\s\S]*update\s*\(/)
    expect(updateGroup).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*`Group changes have been saved\.`\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(updateGroup).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(updateGroup).toMatch(/finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-update['"]\s*\)\s*\}/)
  })
})
