import fs from 'node:fs'
import path from 'node:path'

const extractScript = source => {
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
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bfetchSiteConfig\b)(?=[^}]*\bsaveSiteConfig\b)(?=[^}]*\btype SiteConfig\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/site-api['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/
    )
    expect(script).toMatch(
      /import\s+\{(?=[^}]*\bonEditorInsert\b)(?=[^}]*\boffEditorInsert\b)(?=[^}]*\btype EditorInsertPayload\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/editor-insert-events['"]/
    )
    expect(script).not.toContain("store.registerModule('editor'")
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo')
  })

  test('save rejects unavailable or concurrent submissions and balances root loading state', () => {
    expect(save).not.toBeNull()
    expect(save).toMatch(
      /async\s+save\s*\(\s*\)\s*\{[\s\S]*?if\s*\(\s*!this\.configLoaded\s*\|\|\s*this\.configSaving\s*\)\s*return[\s\S]*?this\.configSaving\s*=\s*true[\s\S]*?loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-site-update['"]\s*\)/
    )
    expect(save).toMatch(/await\s+saveSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.siteConfigPayload\s*\(\s*\)\s*\)/)
    expect(save).toMatch(
      /showNotification\s*\(\s*wikiStore\s*,\s*\{\s*style:\s*['"]success['"]\s*,\s*message:\s*['"]Configuration saved successfully\.['"]\s*,\s*icon:\s*['"]check['"]\s*\}\s*\)/
    )
    expect(save).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)[\s\S]*?\}\s*finally\s*\{[\s\S]*?this\.configSaving\s*=\s*false[\s\S]*?loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-site-update['"]\s*\)[\s\S]*?\}/
    )
    expect(save).not.toMatch(/\$store\.commit\(\s*(?:`loading|['"]loading|['"]showNotification|['"]pushGraphError)/)
    expect(save.match(/\bloadingStart\s*\(/g) || []).toHaveLength(1)
    expect(save.match(/\bloadingStop\s*\(/g) || []).toHaveLength(1)
  })

  test('loadConfig ignores stale results while balancing every root loading request', () => {
    expect(loadConfig).not.toBeNull()
    expect(script).toContain('configLoadRequestId: 0')
    expect(loadConfig).toMatch(
      /const\s+requestId\s*=\s*\+\+this\.configLoadRequestId[\s\S]*?this\.configLoading\s*=\s*true[\s\S]*?this\.configLoadError\s*=\s*false[\s\S]*?setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-security-refresh['"]\s*,\s*true\s*\)/
    )
    expect(loadConfig).toMatch(
      /const\s+config\s*=\s*await\s+fetchSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)[\s\S]*?if\s*\(\s*requestId\s*!==\s*this\.configLoadRequestId\s*\)\s*return[\s\S]*?this\.config\s*=\s*_\.pick\s*\(\s*config\s*,\s*SECURITY_CONFIG_KEYS\s*\)\s+as\s+SecurityConfig[\s\S]*?this\.configLoaded\s*=\s*true/
    )
    expect(loadConfig).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?if\s*\(\s*requestId\s*!==\s*this\.configLoadRequestId\s*\)\s*return[\s\S]*?this\.configLoaded\s*=\s*false[\s\S]*?this\.configLoadError\s*=\s*true[\s\S]*?pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/
    )
    expect(loadConfig).toMatch(
      /finally\s*\{[\s\S]*?setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-security-refresh['"]\s*,\s*false\s*\)[\s\S]*?if\s*\(\s*requestId\s*===\s*this\.configLoadRequestId\s*\)\s*this\.configLoading\s*=\s*false[\s\S]*?\}/
    )
    expect(loadConfig.match(/\bsetLoading\s*\(/g) || []).toHaveLength(2)
  })

  test('the form and apply action preserve guarded submit prevention', () => {
    expect(source).toMatch(/v-form\.pt-3\((?=[^\n)]*\bv-else-if=['"]configLoaded['"])(?=[^\n)]*@submit\.prevent=['"]save['"])[^\n)]*\)/)
    expect(source).toMatch(
      /v-btn\((?=[^\n)]*@click=['"]save['"])(?=[^\n)]*:loading=['"]configSaving['"])(?=[^\n)]*:disabled=['"]!configLoaded \|\| configSaving['"])[^\n)]*\)/
    )
  })

  test('the form keeps scalar models numeric, HSTS values explicit, and the media modal conditional', () => {
    expect(script).toMatch(
      /const\s+SECURITY_CONFIG_KEYS\s*=\s*\[[\s\S]*?['"]uploadMaxFileSize['"][\s\S]*?['"]securityHSTSDuration['"][\s\S]*?['"]authJwtRenewablePeriod['"][\s\S]*?\]\s+as\s+const/
    )
    expect(script).toMatch(/type\s+SecurityConfig\s*=\s*Required<Pick<SiteConfig,\s*typeof\s+SECURITY_CONFIG_KEYS\[number\]>>/)
    expect(source).toMatch(
      /v-select\.mt-5\([\s\S]*?:items=['"]hstsDurations['"][\s\S]*?item-title=['"]text['"][\s\S]*?item-value=['"]value['"][\s\S]*?v-model=['"]config\.securityHSTSDuration['"][\s\S]*?\)/
    )
    expect(source).toMatch(/v-text-field\.mt-3\([\s\S]*?v-model\.number=['"]config\.uploadMaxFileSize['"][\s\S]*?\)/)
    expect(source).toMatch(/v-text-field\.mt-3\([\s\S]*?v-model\.number=['"]config\.uploadMaxFiles['"][\s\S]*?\)/)
    expect(source).toMatch(/component\(v-if=['"]activeModal['"],\s*:is=['"]activeModal['"]\)/)
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
    expect(script).toMatch(/mounted\s*\(\s*\)\s*\{[\s\S]*?this\.loadConfig\s*\(\s*\)[\s\S]*?onEditorInsert\s*\(\s*this\.handleEditorInsert\s*\)[\s\S]*?\}/)
    expect(script).toMatch(
      /beforeUnmount\s*\(\s*\)\s*\{[\s\S]*?this\.configLoadRequestId\+\+[\s\S]*?offEditorInsert\s*\(\s*this\.handleEditorInsert\s*\)[\s\S]*?\}/
    )
    expect(script).toContain('this.config.authLoginBgUrl = opts.path')
  })
})
