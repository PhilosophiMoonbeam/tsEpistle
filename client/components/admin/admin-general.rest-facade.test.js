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

describe('admin-general site REST facade migration guard', () => {
  const componentPath = path.join(process.cwd(), 'client/components/admin/admin-general.vue')
  const source = fs.readFileSync(componentPath, 'utf8')
  const script = extractScript(source)
  const save = script && extractMethod(script, 'save')
  const loadConfig = script && extractMethod(script, 'loadConfig')
  const siteConfigPayload = script && extractMethod(script, 'siteConfigPayload')

  test('admin-general imports typed site REST, root UI, and wiki store facades instead of Apollo', () => {
    expect(script).not.toBeNull()
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toMatch(/import\s+\{(?=[^}]*\bfetchSiteConfig\b)(?=[^}]*\bsaveSiteConfig\b)(?=[^}]*\btype SiteConfig\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/site-api['"]/)
    expect(script).toMatch(/import\s+\{(?=[^}]*\bloadingStart\b)(?=[^}]*\bloadingStop\b)(?=[^}]*\bpushGraphError\b)(?=[^}]*\bsetLoading\b)(?=[^}]*\bshowNotification\b)[^}]*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/root-ui-store['"]/)
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toContain('this.$apollo')
    expect(script).not.toContain('apollo:')
  })

  test('loadConfig fetches site config by REST with refresh loading and error facade', () => {
    expect(loadConfig).not.toBeNull()
    expect(loadConfig).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-site-refresh['"]\s*,\s*true\s*\)/)
    expect(loadConfig).toMatch(/fetchSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*\)/)
    expect(loadConfig).toMatch(/this\.config\s*=\s*_\.cloneDeep\s*\(/)
    expect(loadConfig).toMatch(/pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/)
    expect(loadConfig).toMatch(/setLoading\s*\(\s*wikiStore\s*,\s*['"]admin-site-refresh['"]\s*,\s*false\s*\)/)
  })

  test('save preserves title validation, REST save payload, success notification, and root field updates', () => {
    expect(save).not.toBeNull()
    expect(save).toMatch(/titleRegex\.test\s*\(\s*title\s*\)/)
    expect(save).toMatch(/showNotification\s*\(\s*wikiStore\s*,\s*\{\s*style:\s*['"]error['"][\s\S]*admin:general\.siteTitleInvalidChars[\s\S]*icon:\s*['"]alert['"]\s*\}/)
    expect(save).toMatch(/loadingStart\s*\(\s*wikiStore\s*,\s*['"]admin-site-update['"]\s*\)/)
    expect(save).toMatch(/await\s+saveSiteConfig\s*\(\s*window\.fetch\.bind\s*\(\s*window\s*\)\s*,\s*this\.siteConfigPayload\s*\(\s*\)\s*\)/)
    expect(save).toMatch(/showNotification\s*\(\s*wikiStore\s*,\s*\{\s*style:\s*['"]success['"][\s\S]*message:\s*this\.\$t\s*\(\s*['"]admin:general\.saveSuccess['"]\s*\)[\s\S]*icon:\s*['"]check['"]\s*\}/)
    expect(save).toMatch(/this\.siteTitle\s*=\s*this\.config\.title/)
    expect(save).toMatch(/this\.company\s*=\s*this\.config\.company/)
    expect(save).toMatch(/this\.contentLicense\s*=\s*this\.config\.contentLicense/)
    expect(save).toMatch(/this\.footerOverride\s*=\s*this\.config\.footerOverride/)
    expect(save).toMatch(/wikiStore\.site\.banner\s*=\s*_\.cloneDeep\s*\(\s*this\.config\.banner\s*\)/)
    expect(save).toMatch(/this\.logoUrl\s*=\s*this\.config\.logoUrl/)
    expect(save).toMatch(/pushGraphError\s*\(\s*wikiStore\s*,\s*err\s*\)/)
    expect(save).toMatch(/loadingStop\s*\(\s*wikiStore\s*,\s*['"]admin-site-update['"]\s*\)/)
  })

  test('general payload preserves the former site update config fields', () => {
    expect(siteConfigPayload).not.toBeNull()
    for (const field of ['host', 'title', 'description', 'robots', 'analyticsService', 'analyticsId', 'company', 'contentLicense', 'footerOverride', 'banner', 'logoUrl', 'pageExtensions', 'featurePageRatings', 'featurePageComments', 'featurePersonalWikis', 'editFab', 'editMenuBar', 'editMenuBtn', 'editMenuExternalBtn', 'editMenuExternalName', 'editMenuExternalIcon', 'editMenuExternalUrl']) {
      expect(siteConfigPayload).toContain(field)
    }
  })

  test('editor insert behavior stays unchanged', () => {
    expect(script).toContain('this.loadConfig()')
    expect(script).toContain('onEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('offEditorInsert(this.handleEditorInsert)')
    expect(script).toContain('this.config.logoUrl = opts.path')
  })
})
