const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, 'editor-redirect.vue'), 'utf8')

describe('editor redirect REST migration guard', () => {
  test('loads group options through the REST helper and loading facade', () => {
    expect(source).toContain("import { fetchGroupOptions } from '../../helpers/groups-api'")
    expect(source).toContain("setLoading(this.$store, 'editor-redirect-groups', true)")
    expect(source).toContain('this.groups = await fetchGroupOptions(window.fetch.bind(window))')
    expect(source).toContain("setLoading(this.$store, 'editor-redirect-groups', false)")
    expect(source).not.toMatch(/graphql-tag|\$apollo/)
  })

  test('preserves redirect editor initialization and template', () => {
    expect(source).toContain("this.$store.set('editor/editorKey', 'redirect')")
    expect(source).toContain("this.$store.set('editor/content', '<h1>Title</h1>\\n\\n<p>Some text here</p>')")
    expect(source).toContain("v-system-bar.editor-redirect-sysbar(dark, status, color='grey darken-3')")
    expect(source).toContain('v-select.ml-3(')
  })
})
