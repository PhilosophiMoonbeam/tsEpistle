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

describe('admin-theme root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-theme.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const loadConfig = script && extractMethod(script, 'loadConfig')
  const save = script && extractMethod(script, 'save')
  const directRootUiCommit = /\bthis\.\$store\.commit\s*\(\s*(?:`loading(?:Start|Stop)`|['"]loading(?:Start|Stop)['"]|`showNotification`|['"]showNotification['"]|`pushGraphError`|['"]pushGraphError['"])\s*,/

  test('admin-theme.vue imports the root UI facades required by loadConfig() and save()', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bshowNotification\b)(?=[^}]*\bpushGraphError\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
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

  test('save() uses root UI facades while preserving mutation payload, response handling, dark mode state, fallback, and trailing cleanup', () => {
    expect(save).not.toBeNull()

    expect(save).toMatch(/async\s+save\s*\(\s*\)\s*\{\s*this\.loading\s*=\s*true\s*loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-theme-save['"]\s*\)\s*try\s*\{\s*const\s+respRaw\s*=\s*await\s+this\.\$apollo\.mutate\s*\(\s*\{\s*mutation:\s*themeSaveMutation/)
    expect(save).toMatch(/variables:\s*\{[\s\S]*theme:\s*this\.config\.theme[\s\S]*iconset:\s*this\.config\.iconset[\s\S]*darkMode:\s*this\.darkMode[\s\S]*tocPosition:\s*this\.config\.tocPosition[\s\S]*injectCSS:\s*this\.config\.injectCSS[\s\S]*injectHead:\s*this\.config\.injectHead[\s\S]*injectBody:\s*this\.config\.injectBody[\s\S]*\}/)
    expect(save).toMatch(/const\s+resp\s*=\s*_\.get\s*\(\s*respRaw\s*,\s*['"]data\.theming\.setConfig\.responseResult['"]\s*,\s*\{\s*\}\s*\)/)
    expect(save).toMatch(/if\s*\(\s*resp\.succeeded\s*\)\s*\{\s*this\.darkModeInitial\s*=\s*this\.darkMode\s*showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*message:\s*['"]Theme settings updated successfully\.['"]\s*,\s*style:\s*['"]success['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/throw\s+new\s+Error\s*\(\s*resp\.message\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-theme-save['"]\s*\)\s*this\.loading\s*=\s*false\s*\}/)
    expect(save).not.toMatch(directRootUiCommit)

    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bshowNotification\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bpushGraphError\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bthis\.\$apollo\.mutate\s*\(/g) || []).toHaveLength(1)
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
