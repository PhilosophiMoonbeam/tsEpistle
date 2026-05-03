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

  const bodyStart = script.indexOf('{', methodStart)
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

describe('admin-security root UI facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-security.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const save = script && extractMethod(script, 'save')

  test('admin-security imports root UI facades while preserving editor dependencies', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{(?=[^}]*\bpushGraphError\b)(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toContain("import { onEditorInsert, offEditorInsert } from '../../helpers/editor-insert-events'")
    expect(script).toContain("import store from '../../store'")
    expect(script).toContain("import editorStore from '../../store/editor'")
    expect(script).toContain("store.registerModule('editor', editorStore)")
  })

  test('save routes loading, success, and GraphQL errors through root UI facades', () => {
    expect(save).not.toBeNull()
    expect(save).toContain('await this.$apollo.mutate({')
    expect(save).toMatch(/watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-site-update['"]\s*,\s*isLoading\s*\)\s*\}/)
    expect(save).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Configuration saved successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}/)
    expect(save).not.toMatch(/\$store\.commit\(\s*(?:`loading|['"]loading|['"]showNotification|['"]pushGraphError)/)
  })

  test('apollo config refresh watcher routes loading through root UI facade', () => {
    expect(script).toMatch(/config:\s*\{[\s\S]*fetchPolicy:\s*['"]network-only['"][\s\S]*watchLoading\s*\(\s*isLoading\s*\)\s*\{\s*setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-security-refresh['"]\s*,\s*isLoading\s*\)\s*\}/)
    expect(script).not.toMatch(/\$store\.commit\(\s*`loading\$\{isLoading \? ['"]Start['"] : ['"]Stop['"]\}`\s*,\s*['"]admin-security-refresh['"]\s*\)/)
  })

  test('non-root-ui store and editor insert behavior stay unchanged', () => {
    expect(script).toContain("this.$store.set('editor/editorKey', 'common')")
    expect(script).toContain('onEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('offEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('this.config.authLoginBgUrl = opts.path')
  })
})
