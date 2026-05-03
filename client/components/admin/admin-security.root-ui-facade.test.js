const fs = require('fs')
const path = require('path')

const extractScript = (source) => {
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  return match && match[1]
}

const extractMethod = (script, name) => {
  const methodStart = script.search(new RegExp('(?:^|\\n)\\s*(?:async\\s+)?' + name + '\\s*\\('))
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

describe('admin-security site REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-security.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const save = script && extractMethod(script, 'save')
  const loadConfig = script && extractMethod(script, 'loadConfig')
  const siteConfigPayload = script && extractMethod(script, 'siteConfigPayload')

  test('admin-security imports site REST and root UI facades while preserving editor dependencies', () => {
    expect(script).not.toBeNull()
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchSiteConfig\b)(?=[^}]*\bsaveSiteConfig\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/site-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toContain("import { onEditorInsert, offEditorInsert } from '../../helpers/editor-insert-events'")
    expect(script).toContain("import store from '../../store'")
    expect(script).toContain("import editorStore from '../../store/editor'")
    expect(script).toContain("store.registerModule('editor', editorStore)")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo')
  })

  test('save routes REST save loading, success, and errors through root UI facades', () => {
    expect(save).not.toBeNull()
    expect(save).toMatch(/loadingStart\s*\(\s*this\.\$store\s*,\s*['"]admin-site-update['"]\s*\)/)
    expect(save).toMatch(/await\s+saveSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.siteConfigPayload\s*\(\s*\)\s*\)/)
    expect(save).toMatch(/showNotification\s*\(\s*this\.\$store\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Configuration saved successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*this\.\$store\s*,\s*['"]admin-site-update['"]\s*\)/)
    expect(save).not.toMatch(/\$store\.commit\(\s*(?:`loading|['"]loading|['"]showNotification|['"]pushGraphError)/)
  })

  test('loadConfig routes REST refresh loading and errors through root UI facade', () => {
    expect(loadConfig).not.toBeNull()
    expect(loadConfig).toMatch(/setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-security-refresh['"]\s*,\s*true\s*\)/)
    expect(loadConfig).toMatch(/fetchSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(loadConfig).toMatch(/pushGraphError\s*\(\s*this\.\$store\s*,\s*err\s*\)/)
    expect(loadConfig).toMatch(/setLoading\s*\(\s*this\.\$store\s*,\s*['"]admin-security-refresh['"]\s*,\s*false\s*\)/)
  })

  test('security payload preserves numeric coercion and config fields', () => {
    expect(siteConfigPayload).not.toBeNull()
    expect(siteConfigPayload).toContain("authAutoLogin: _.get(this.config, 'authAutoLogin', false)")
    expect(siteConfigPayload).toContain("uploadMaxFileSize: _.toSafeInteger(_.get(this.config, 'uploadMaxFileSize', 0))")
    expect(siteConfigPayload).toContain("uploadMaxFiles: _.toSafeInteger(_.get(this.config, 'uploadMaxFiles', 0))")
    expect(siteConfigPayload).toContain("securityCSPDirectives: _.get(this.config, 'securityCSPDirectives', '')")
  })

  test('non-root-ui store and editor insert behavior stay unchanged', () => {
    expect(script).toContain("this.$store.set('editor/editorKey', 'common')")
    expect(script).toContain('this.loadConfig()')
    expect(script).toContain('onEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('offEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('this.config.authLoginBgUrl = opts.path')
  })
})
