const fs = require('fs')
const path = require('path')

const sourcePath = path.join(__dirname, 'editor-redirect.vue')
const source = fs.readFileSync(sourcePath, 'utf8')

describe('editor redirect root UI facade migration guard', () => {
  test('imports the root UI loading facade for the groups watcher', () => {
    expect(source).toContain("import { setLoading } from '../../helpers/root-ui-store'")
  })

  test('routes groups query loading through the root UI facade', () => {
    expect(source).toContain("watchLoading (isLoading) {\n        setLoading(this.$store, 'editor-redirect-groups', isLoading)\n      }")
    expect(source).not.toMatch(/this\.\$store\.commit\([\s\S]{0,200}['"]editor-redirect-groups['"]/)
  })

  test('preserves the groups query and fetch behavior', () => {
    expect(source).toContain('groups {')
    expect(source).toContain('list {')
    expect(source).toContain('id\n              name')
    expect(source).toContain("fetchPolicy: 'network-only'")
    expect(source).toContain('update: (data) => data.groups.list')
  })

  test('keeps editor setup and template behavior out of this slice', () => {
    expect(source).toContain("this.$store.set('editor/editorKey', 'redirect')")
    expect(source).toContain("this.$store.set('editor/content', '<h1>Title</h1>\\n\\n<p>Some text here</p>')")
    expect(source).toContain("v-system-bar.editor-redirect-sysbar(dark, status, color='grey darken-3')")
    expect(source).toContain('v-select.ml-3(')
  })
})
