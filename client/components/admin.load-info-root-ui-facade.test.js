const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${name}\\s*\\(`))

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

describe('admin.vue loadInfo root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const created = script && extractMethod(script, 'created')
  const loadInfo = script && extractMethod(script, 'loadInfo')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"])\s*,/

  test('admin.vue imports only the facades needed for loadInfo() and keeps existing data imports', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{\s*get\s*,\s*sync\s*\}\s+from\s+['"]vuex-pathify['"]/
    )
    expect(script).toMatch(
      /import\s+\{\s*fetchSystemSummary\s*\}\s+from\s+['"]\.\.\/helpers\/system-api['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/helpers\/root-ui-store['"]/
    )
  })

  test('created() preserves the page mode direct commit and still triggers loadInfo()', () => {
    expect(created).not.toBeNull()

    expect(created).toMatch(/created\s*\(\s*\)\s*\{\s*this\.\$store\.commit\s*\(\s*['"]page\/SET_MODE['"]\s*,\s*['"]admin['"]\s*\)\s*this\.loadInfo\s*\(\s*\)\s*\}/)
    expect(created).toMatch(/this\.\$store\.commit\s*\(\s*['"]page\/SET_MODE['"]\s*,\s*['"]admin['"]\s*\)/)
    expect(created).not.toMatch(directRootUiCommit)
  })

  test('computed bindings remain the admin info sync and user permissions getter', () => {
    expect(script).not.toBeNull()

    expect(script).toMatch(/computed:\s*\{\s*info:\s*sync\s*\(\s*['"]admin\/info['"]\s*\)\s*,\s*permissions:\s*get\s*\(\s*['"]user\/permissions['"]\s*\)/)
  })

  test('loadInfo() uses root-ui-store facades while preserving fetch, assignment, notification payload, and non-finally cleanup order', () => {
    expect(loadInfo).not.toBeNull()

    expect(loadInfo).toMatch(/async\s+loadInfo\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-stats-refresh['"]\s*\)\s*try\s*\{\s*this\.info\s*=\s*await\s+fetchSystemSummary\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]System summary response is invalid['"]\s*\)\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]red['"]\s*,\s*message:\s*err\.message\s*,\s*icon:\s*['"]alert['"]\s*\}\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-stats-refresh['"]\s*\)\s*\}/)
    expect(loadInfo).not.toMatch(/\bfinally\b/)
    expect(loadInfo).not.toMatch(directRootUiCommit)

    expect(loadInfo.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(loadInfo.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })
})
