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

describe('admin-groups load/refresh root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadGroups = script && extractMethod(script, 'loadGroups')
  const refresh = script && extractMethod(script, 'refresh')
  const createGroup = script && extractMethod(script, 'createGroup')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-groups.vue imports only the root UI facades needed by loadGroups() and refresh()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(script).toMatch(/import\s+createGroupMutation\s+from\s+['"]gql\/admin\/groups\/groups-mutation-create\.gql['"]/)
    expect(script).toMatch(/import\s+\{\s*fetchGroupsList\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
  })

  test('loadGroups() uses loading/notification facades while preserving fetch, local loading, returns, and cleanup order', () => {
    expect(loadGroups).not.toBeNull()

    expect(loadGroups).toMatch(/async\s+loadGroups\s*\(\s*\)\s*\{\s*this\.loading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-refresh['"]\s*\)\s*try\s*\{\s*this\.groups\s*=\s*await\s+fetchGroupsList\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Groups list response is invalid['"]\s*\)\s*return\s+true\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*err\.message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*return\s+false\s*\}\s*finally\s*\{\s*this\.loading\s*=\s*false\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-groups-refresh['"]\s*\)\s*\}\s*\}/)
    expect(loadGroups).not.toMatch(directRootUiCommit)

    expect(loadGroups.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadGroups.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadGroups.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadGroups.match(/\bfetchGroupsList\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh() keeps loadGroups() success gate and routes only the refresh success notification through the facade', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/async\s+refresh\s*\(\s*\)\s*\{\s*if\s*\(\s*await\s+this\.loadGroups\s*\(\s*\)\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Groups have been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)\s*\}\s*\}/)
    expect(refresh).not.toMatch(directRootUiCommit)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('createGroup() mutation, validation, Apollo loading, success notification, and graph error stay out of scope', () => {
    expect(createGroup).not.toBeNull()

    expect(createGroup).toMatch(/if\s*\(\s*_\.trim\s*\(\s*this\.newGroupName\s*\)\.length\s*<\s*1\s*\)\s*\{\s*this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*['"]Enter a group name\.['"]\s*,\s*icon:\s*['"]warning['"]\s*\}\s*\)\s*return\s*\}/)
    expect(createGroup).toMatch(/this\.newGroupDialog\s*=\s*false/)
    expect(createGroup).toMatch(/this\.\$apollo\.mutate\s*\(\s*\{[\s\S]*mutation:\s*createGroupMutation[\s\S]*variables:\s*\{\s*name:\s*this\.newGroupName\s*\}/)
    expect(createGroup).toMatch(/this\.\$store\.commit\s*\(\s*`loading\$\{isLoading \? 'Start' : 'Stop'\}`\s*,\s*['"]admin-groups-create['"]\s*\)/)
    expect(createGroup).toMatch(/const\s+data\s*=\s*_\.get\s*\(\s*resp\s*,\s*['"]data\.groups\.create['"]\s*,\s*\{\s*responseResult:\s*\{\}\s*\}\s*\)/)
    expect(createGroup).toMatch(/data\.responseResult\.succeeded\s*===\s*true/)
    expect(createGroup).toMatch(/this\.newGroupName\s*=\s*['"]['"]/)
    expect(createGroup).toMatch(/if\s*\(\s*await\s+this\.loadGroups\s*\(\s*\)\s*\)/)
    expect(createGroup).toMatch(/this\.\$store\.commit\s*\(\s*['"]showNotification['"]\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Group has been created successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(createGroup).toMatch(/throw\s+new\s+Error\s*\(\s*data\.responseResult\.message\s*\|\|\s*['"]An unexpected error occurred\.['"]\s*\)/)
    expect(createGroup).toMatch(/this\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
  })
})
