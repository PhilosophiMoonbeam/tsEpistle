import fs from 'node:fs'
import path from 'node:path'

const extractScript = (source) => {
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
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

  test('admin-security imports typed site REST, root UI, wiki store, and editor dependencies', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchSiteConfig\b)(?=[^}]*\bsaveSiteConfig\b)(?=[^}]*\btype SiteConfig\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/site-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bonEditorInsert\b)(?=[^}]*\boffEditorInsert\b)(?=[^}]*\btype EditorInsertPayload\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/editor-insert-events['"]/)
    expect(script).not.toContain("store.registerModule('editor'")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo')
  })

  test('save routes REST save loading, success, and errors through root UI facades', () => {
    expect(save).not.toBeNull()
    expect(save).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-site-update['"]\s*\)/)
    expect(save).toMatch(/await\s+saveSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.siteConfigPayload\s*\(\s*\)\s*\)/)
    expect(save).toMatch(/showNotification\s*\(\s*wikiStore\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Configuration saved successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/)
    expect(save).toMatch(/catch\s*\(\s*err\s*\)\s*\{\s*pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)\s*\}\s*finally\s*\{\s*loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-site-update['"]\s*\)/)
    expect(save).not.toMatch(/\$store\.commit\(\s*(?:`loading|['"]loading|['"]showNotification|['"]pushGraphError)/)
  })

  test('loadConfig routes REST refresh loading and errors through root UI facade', () => {
    expect(loadConfig).not.toBeNull()
    expect(loadConfig).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-security-refresh['"]\s*,\s*true\s*\)/)
    expect(loadConfig).toMatch(/this\.config\s*=\s*_\.cloneDeep\s*\(\s*await\s+fetchSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)\s*\)\s+as\s+SecurityConfig/)
    expect(loadConfig).toMatch(/pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/)
    expect(loadConfig).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-security-refresh['"]\s*,\s*false\s*\)/)
  })

  test('security payload preserves its typed return, numeric coercion, and config fields', () => {
    expect(siteConfigPayload).not.toBeNull()
    expect(siteConfigPayload).toMatch(/siteConfigPayload\s*\(\s*\)\s*:\s*Record<string,\s*unknown>/)
    expect(siteConfigPayload).toContain("authAutoLogin: _.get(this.config, 'authAutoLogin', false)")
    expect(siteConfigPayload).toContain("uploadMaxFileSize: _.toSafeInteger(_.get(this.config, 'uploadMaxFileSize', 0))")
    expect(siteConfigPayload).toContain("uploadMaxFiles: _.toSafeInteger(_.get(this.config, 'uploadMaxFiles', 0))")
    expect(siteConfigPayload).toContain("securityCSPDirectives: _.get(this.config, 'securityCSPDirectives', '')")
  })

  test('Pinia editor state and typed editor insert behavior stay unchanged', () => {
    expect(script).toContain("wikiStore.editor.editorKey = 'common'")
    expect(script).toContain("this.activeModal = 'editorModalMedia'")
    expect(script).toMatch(/handleEditorInsert\s*\(\s*opts:\s*EditorInsertPayload\s*\)/)
    expect(script).toContain('this.loadConfig()')
    expect(script).toContain('onEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('offEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('this.config.authLoginBgUrl = opts.path')
  })
})
