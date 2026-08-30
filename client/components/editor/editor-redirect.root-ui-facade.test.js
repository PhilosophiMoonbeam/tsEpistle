import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'client/components/editor/editor-redirect.vue'), 'utf8')

describe('editor redirect REST migration guard', () => {
  test('loads group options through the REST helper and loading facade', () => {
    expect(source).toMatch(/<script\s+lang=['"]ts['"]>/)
    expect(source).toMatch(/import\s+\{\s*fetchGroupOptions,\s*type\s+GroupOption\s*\}\s+from\s+['"]\.\.\/\.\.\/helpers\/groups-api['"]/)
    expect(source).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(source).toContain("setLoading(wikiStore, 'editor-redirect-groups', true)")
    expect(source).toContain('this.groups = await fetchGroupOptions(window.fetch.bind(window))')
    expect(source).toContain("setLoading(wikiStore, 'editor-redirect-groups', false)")
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves redirect editor initialization and independent rule and fallback controls', () => {
    expect(source).toContain("wikiStore.editor.editorKey = 'redirect'")
    expect(source).toContain("wikiStore.editor.content = '<h1>Title</h1>\\n\\n<p>Some text here</p>'")
    expect(source).toContain('v-system-bar.editor-status-bar.editor-redirect-sysbar(absolute, status, color="grey-darken-3")')
    expect(source).toMatch(
      /v-for=['"]\(rule, index\) in conditionalRules['"][\s\S]*?v-select\.editor-redirect-groups\([\s\S]*?v-model=['"]rule\.groups['"][\s\S]*?v-btn-toggle\.editor-redirect-toggle\([\s\S]*?v-model=['"]rule\.mode['"][\s\S]*?v-text-field\.editor-redirect-url\([\s\S]*?v-model=['"]rule\.url['"]/
    )
    expect(source).toMatch(
      /Otherwise, redirect to[\s\S]*?v-btn-toggle\.editor-redirect-toggle\([\s\S]*?v-model=['"]fallbackMode['"][\s\S]*?v-text-field\.editor-redirect-url\([\s\S]*?v-model=['"]fallbackUrl['"]/
    )
  })
})
