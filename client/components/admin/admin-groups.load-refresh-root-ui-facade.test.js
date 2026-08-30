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

describe('admin-groups root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-groups.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadGroups = script && extractMethod(script, 'loadGroups')
  const refresh = script && extractMethod(script, 'refresh')
  const createGroup = script && extractMethod(script, 'createGroup')
  const directRootUiCommit =
    /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|`loading\$\{[^}]+\}`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-groups.vue imports the typed store singleton and REST helpers needed by loadGroups(), refresh(), and createGroup()', () => {
    expect(script).not.toBeNull()
    expect(source).toContain("<script lang='ts'>")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{\s*getErrorMessage\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+_\s+from\s+['"]lodash['"]/)
    expect(script).not.toMatch(/groups-mutation-create\.gql/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bcreateGroup\b)(?=[^}]*\bfetchGroupsList\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(source).toMatch(/async-state\(v-if=['"]loading['"],?\s+state=['"]loading['"]/)
    expect(source).toMatch(/async-state\(v-else-if=['"]errorMessage['"],?\s+state=['"]error['"]/)
    expect(source).toMatch(/:loading=['"]loading['"]\s+:disabled=['"]loading['"]/)
    expect(source).toMatch(/:loading=['"]creating['"]\s+:disabled=['"]creating['"]/)
  })

  test('loadGroups() owns truthful list state while preserving fetch, returns, error notification, and cleanup order', () => {
    expect(loadGroups).not.toBeNull()

    expect(loadGroups).toMatch(
      /this\.loading\s*=\s*true[\s\S]*?this\.errorMessage\s*=\s*['"]['"][\s\S]*?wikiStore\.startLoading\s*\(\s*['"]admin-groups-refresh['"]\s*\)[\s\S]*?this\.groups\s*=\s*await\s+fetchGroupsList\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Groups list response is invalid['"]\s*\)[\s\S]*?return\s+true/
    )
    expect(loadGroups).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?this\.errorMessage\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*this\.errorMessage\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)[\s\S]*?return\s+false/
    )
    expect(loadGroups).toMatch(/finally\s*\{[\s\S]*?this\.loading\s*=\s*false[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-groups-refresh['"]\s*\)\s*\}/)
    expect(loadGroups).not.toMatch(directRootUiCommit)

    expect(loadGroups.match(/\bstartLoading\s*\(/g) || []).toHaveLength(1)
    expect(loadGroups.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadGroups.match(/\bstopLoading\s*\(/g) || []).toHaveLength(1)
    expect(loadGroups.match(/\bfetchGroupsList\s*\(/g) || []).toHaveLength(1)
  })

  test('refresh() keeps the reload success gate and reports success only after that reload', () => {
    expect(refresh).not.toBeNull()

    expect(refresh).toMatch(/if\s*\(\s*await\s+this\.loadGroups\s*\(\s*\)\s*\)/)
    expect(refresh).toMatch(
      /wikiStore\.showNotification\s*\(\s*\{\s*message:\s*['"]Groups have been refreshed\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]cached['"]\s*\}\s*\)/
    )
    expect(refresh.indexOf('await this.loadGroups()')).toBeLessThan(refresh.indexOf('wikiStore.showNotification'))
    expect(refresh).not.toMatch(directRootUiCommit)
    expect(refresh.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
  })

  test('createGroup() keeps inline validation, action busy state, REST success gating, reload, and cleanup', () => {
    expect(createGroup).not.toBeNull()

    expect(createGroup).toMatch(
      /if\s*\(\s*_\.trim\s*\(\s*this\.newGroupName\s*\)\.length\s*<\s*1\s*\)\s*\{\s*this\.createError\s*=\s*['"]Enter a group name\.['"]\s*return\s*\}/
    )
    expect(createGroup).toMatch(
      /this\.creating\s*=\s*true[\s\S]*?this\.createError\s*=\s*['"]['"][\s\S]*?wikiStore\.startLoading\s*\(\s*['"]admin-groups-create['"]\s*\)/
    )
    expect(createGroup).toMatch(/await\s+createGroup\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*this\.newGroupName\s*\)/)
    expect(createGroup).not.toMatch(/this\.\$apollo\.mutate|createGroupMutation/)
    expect(createGroup).toMatch(
      /if\s*\(\s*data\.succeeded\s*!==\s*true\s*\)\s*throw\s+new\s+Error\s*\(\s*data\.message\s*\|\|\s*['"]An unexpected error occurred\.['"]\s*\)/
    )
    expect(createGroup).toMatch(/this\.newGroupName\s*=\s*['"]['"][\s\S]*?this\.newGroupDialog\s*=\s*false/)
    expect(createGroup).toMatch(
      /if\s*\(\s*await\s+this\.loadGroups\s*\(\s*\)\s*\)\s*wikiStore\.showNotification\s*\(\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Group has been created successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(createGroup).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?this\.createError\s*=\s*getErrorMessage\s*\(\s*err\s*\)[\s\S]*?wikiStore\.showError\s*\(\s*err\s*\)/
    )
    expect(createGroup).toMatch(/finally\s*\{[\s\S]*?this\.creating\s*=\s*false[\s\S]*?wikiStore\.stopLoading\s*\(\s*['"]admin-groups-create['"]\s*\)\s*\}/)
    expect(createGroup).not.toMatch(directRootUiCommit)

    expect(createGroup.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(createGroup.match(/\bstartLoading\s*\(/g) || []).toHaveLength(1)
    expect(createGroup.match(/\bstopLoading\s*\(/g) || []).toHaveLength(1)
    expect(createGroup.match(/\bshowError\s*\(/g) || []).toHaveLength(1)
    expect(createGroup.match(/\bthis\.loadGroups\s*\(/g) || []).toHaveLength(1)
  })
})
