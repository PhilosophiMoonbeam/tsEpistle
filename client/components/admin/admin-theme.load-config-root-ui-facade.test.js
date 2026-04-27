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

describe('admin-theme loadConfig root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-theme.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadConfig = script && extractMethod(script, 'loadConfig')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-theme.vue imports only the root UI facades required by loadConfig()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{\s*fetchThemeConfig\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/theming-api['"]/
    )
    expect(script).toMatch(/import\s+themeSaveMutation\s+from\s+['"]gql\/admin\/theme\/theme-mutation-save\.gql['"]/)
  })

  test('loadConfig() uses loading and error facades while preserving REST fetch assignment, rethrow, and cleanup', () => {
    expect(loadConfig).not.toBeNull()

    expect(loadConfig).toMatch(/async\s+loadConfig\s*\(\s*\)\s*\{\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-theme-refresh['"]\s*\)\s*try\s*\{\s*this\.config\s*=\s*await\s+fetchThemeConfig\s*\(\s*window\.fetch\.bind\(\s*window\s*\)\s*,\s*['"]Theme config response is invalid['"]\s*\)\s*\}\s*catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*throw\s+err\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-theme-refresh['"]\s*\)\s*\}\s*\}/)
    expect(loadConfig).not.toMatch(directRootUiCommit)

    expect(loadConfig.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(loadConfig.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(loadConfig.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(loadConfig.match(/\bfetchThemeConfig\s*\(/g) || []).toHaveLength(1)
  })

  test('save() GraphQL mutation, loading boolean, injection variables, and direct commits stay out of scope', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/this\.loading\s*=\s*true/)
    expect(save).toMatch(/this\.loading\s*=\s*false/)
    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStart`\s*,\s*['"]admin-theme-save['"]\s*\)/)
    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*['"]pushGraphError['"]\s*,\s*err\s*\)/)
    expect(save).toMatch(/this\.\$store\.commit\s*\(\s*`loadingStop`\s*,\s*['"]admin-theme-save['"]\s*\)/)
    expect(save).toMatch(/mutation:\s*themeSaveMutation/)
    expect(save).toMatch(/variables:\s*\{[\s\S]*theme:\s*this\.config\.theme[\s\S]*iconset:\s*this\.config\.iconset[\s\S]*darkMode:\s*this\.darkMode[\s\S]*tocPosition:\s*this\.config\.tocPosition[\s\S]*injectCSS:\s*this\.config\.injectCSS[\s\S]*injectHead:\s*this\.config\.injectHead[\s\S]*injectBody:\s*this\.config\.injectBody[\s\S]*\}/)
  })

  test('dark mode lifecycle/watchers, v-html template, and load button binding remain present', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/darkMode:\s*sync\s*\(\s*['"]site\/dark['"]\s*\)/)
    expect(script).toMatch(/'darkMode'\s*\(\s*newValue\s*,\s*oldValue\s*\)\s*\{\s*this\.\$vuetify\.theme\.dark\s*=\s*newValue\s*\}/)
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{\s*this\.darkModeInitial\s*=\s*this\.darkMode\s*this\.loadConfig\s*\(\s*\)\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\s*\}/)
    expect(script).toMatch(/beforeDestroy\s*\(\s*\)\s*\{\s*this\.darkMode\s*=\s*this\.darkModeInitial\s*this\.\$vuetify\.theme\.dark\s*=\s*this\.darkModeInitial\s*\}/)
    expect(source).toMatch(/:loading='loading'/)
    expect(source).toMatch(/v-html='data\.item\.text'/)
    expect(source).toMatch(/v-html='data\.item\.author'/)
  })
})
