import fs from 'node:fs'
import path from 'node:path'

const readScript = relativePath => {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  expect(source).toContain("<script lang='ts'>")
  const match = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)
  expect(match).not.toBeNull()
  return match[1]
}

describe('editor conflict REST migration guard', () => {
  test('Tiptap conflict fetches the latest page through the REST helper', () => {
    const script = readScript('client/components/editor/tiptap/conflict.vue')

    expect(script).toMatch(/import\s*\{(?=[^}]*\bdefineComponent\b)(?=[^}]*\bmarkRaw\b)[^}]*\}\s*from\s*['"]vue['"]/)
    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { fetchPageConflictLatest, type PageConflictLatest } from '../../../helpers/pages-api'")
    expect(script).toMatch(
      /const\s+requestController\s*=\s*markRaw\s*\(\s*new\s+AbortController\s*\(\s*\)\s*\)[\s\S]*?this\.requestController\s*=\s*requestController/
    )
    expect(script).toMatch(
      /fetchPageConflictLatest\s*\(\s*\(\s*url\s*,\s*init\s*\)\s*=>\s*window\.fetch\s*\(\s*url\s*,\s*\{\s*\.\.\.init\s*,\s*signal:\s*requestController\.signal\s*\}\s*\)\s*,\s*wikiStore\.page\.id\s*\)/
    )
    expect(script).toMatch(
      /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?requestController\.signal\.aborted[\s\S]*?err\.name\s*===\s*['"]AbortError['"][\s\S]*?return[\s\S]*?\}/
    )
    expect(script).toMatch(
      /if\s*\(\s*!resp\s*\)\s*\{\s*return\s+showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*?message:\s*['"]Failed to fetch latest version\.['"][\s\S]*?style:\s*['"]warning['"][\s\S]*?icon:\s*['"]warning['"]/
    )
    expect(script).toMatch(/beforeUnmount\s*\(\s*\)\s*\{\s*this\.requestController\?\.abort\s*\(\s*\)[\s\S]*?this\.requestController\s*=\s*null\s*\}/)
    expect(script).toContain('this.latest = resp')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(
      /useLocal\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictReset\s*\(\s*\)[\s\S]*this\.close\s*\(\s*\)/
    )
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.content\s*=\s*this\.latest\.content[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
  })

  test('merge conflict modal fetches REST data and preserves typed merge setup', () => {
    const script = readScript('client/components/editor/editor-modal-conflict.vue')

    expect(script).toContain("import { wikiStore } from '@/store/index.ts'")
    expect(script).toContain("import { fetchPageConflictLatest, type PageConflictLatest } from '../../helpers/pages-api'")
    expect(script).toContain("import { unifiedMergeView } from '@codemirror/merge'")
    expect(script).toContain('fetchPageConflictLatest(window.fetch.bind(window), wikiStore.page.id)')
    expect(script).toContain('showNotification(wikiStore, {')
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(
      /overwriteAndClose\s*\(\s*\)\s*\{[\s\S]*this\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictResolved\s*\(\s*\)/
    )
    expect(script).toContain('this.cm = new TextEditor({')
    expect(script).toMatch(/value:\s*wikiStore\.editor\.content[\s\S]*unifiedMergeView\s*\(\s*\{[\s\S]*original:\s*resp\.content[\s\S]*collapseUnchanged:/)
  })
})
