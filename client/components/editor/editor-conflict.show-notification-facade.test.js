import fs from 'node:fs'
import path from 'node:path'

const readScript = (relativePath) => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  expect(source).toContain("<script lang='ts'>")
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  return match[1]
}

describe('editor conflict REST migration guard', () => {
  test('ckeditor conflict fetches the latest page through the REST helper', () => {
    const script = readScript('client/components/editor/ckeditor/conflict.vue')

    expect(script).toContain("import { defineComponent } from 'vue'")
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { fetchPageConflictLatest, type PageConflictLatest } from '../../../helpers/pages-api'")
    expect(script).toContain('fetchPageConflictLatest(window.fetch.bind(window), wikiStore.page.id)')
    expect(script).toContain("message: 'Failed to fetch latest version.'")
    expect(script).toContain('showNotification(wikiStore, {')
    expect(script).toContain('this.latest = resp')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(/useLocal\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictReset\s*\(\s*\)[\s\S]*this\.close\s*\(\s*\)/)
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.content\s*=\s*this\.latest\.content[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
  })

  test('merge conflict modal fetches REST data and preserves typed merge setup', () => {
    const script = readScript('client/components/editor/editor-modal-conflict.vue')

    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { fetchPageConflictLatest, type PageConflictLatest } from '../../helpers/pages-api'")
    expect(script).toContain("import type { MergeView, MergeViewConfiguration } from 'codemirror/addon/merge/merge'")
    expect(script).toContain('fetchPageConflictLatest(window.fetch.bind(window), wikiStore.page.id)')
    expect(script).toContain('showNotification(wikiStore, {')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(/overwriteAndClose\s*\(\s*\)\s*\{[\s\S]*this\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
    expect(script).toContain('const createMergeView = CodeMirror.MergeView as unknown as EditorMergeViewConstructor')
    expect(script).toMatch(/const\s+mergeView\s*=\s*createMergeView\s*\(\s*this\.\$refs\.cm\s+as\s+HTMLElement\s*,\s*\{[\s\S]*value:\s*wikiStore\.editor\.content[\s\S]*orig:\s*resp\.content[\s\S]*mode:\s*textMode[\s\S]*collapseIdentical:\s*true/)
    expect(script).toContain('this.cm = mergeView')
  })
})
