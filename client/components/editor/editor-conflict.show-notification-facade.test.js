const fs = require('fs')
const path = require('path')

const readScript = (relativePath) => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const match = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  return match[1]
}

describe('editor conflict REST migration guard', () => {
  test('ckeditor conflict fetches the latest page through the REST helper', () => {
    const script = readScript('client/components/editor/ckeditor/conflict.vue')

    expect(script).toContain("import { fetchPageConflictLatest } from '../../../helpers/pages-api'")
    expect(script).toContain("fetchPageConflictLatest(window.fetch.bind(window), this.$store.get('page/id'))")
    expect(script).toContain("message: 'Failed to fetch latest version.'")
    expect(script).toContain('this.latest = resp')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(/useLocal\s*\(\s*\)\s*\{[\s\S]*emitEditorConflictReset\s*\(\s*\)[\s\S]*this\.close\s*\(\s*\)/)
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*this\.\$store\.set\s*\(\s*['"]editor\/content['"]\s*,\s*this\.latest\.content\s*\)[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
  })

  test('merge conflict modal fetches REST data and preserves merge setup', () => {
    const script = readScript('client/components/editor/editor-modal-conflict.vue')

    expect(script).toContain("import { fetchPageConflictLatest } from '../../helpers/pages-api'")
    expect(script).toContain("fetchPageConflictLatest(window.fetch.bind(window), this.$store.get('page/id'))")
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(/overwriteAndClose\s*\(\s*\)\s*\{[\s\S]*this\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
    expect(script).toMatch(/CodeMirror\.MergeView\s*\(\s*this\.\$refs\.cm\s*,\s*\{[\s\S]*orig:\s*resp\.content[\s\S]*mode:\s*textMode[\s\S]*collapseIdentical:\s*true/)
  })
})
