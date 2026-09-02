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
  test('Tiptap conflict owns cancellation independently of thrown error shape and names its dialogs', () => {
    const relativePath = 'client/components/editor/tiptap/conflict.vue'
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    const script = readScript(relativePath)

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
      /catch\s*\{[\s\S]*?if\s*\(\s*requestController\.signal\.aborted\s*\)\s*return[\s\S]*?\}\s*if\s*\(\s*requestController\.signal\.aborted\s*\)\s*return/
    )
    expect(script.match(/if\s*\(\s*requestController\.signal\.aborted\s*\)\s*return/g)).toHaveLength(2)
    expect(script).not.toMatch(/AbortError|(?:error|err)\.name/)
    expect(script).toMatch(
      /this\.requestController\s*=\s*null\s*[\s\S]*?if\s*\(\s*!resp\s*\)\s*\{\s*return\s+showNotification\s*\(\s*wikiStore\s*,\s*\{[\s\S]*?message:\s*['"]Failed to fetch latest version\.['"][\s\S]*?style:\s*['"]warning['"][\s\S]*?icon:\s*['"]warning['"][\s\S]*?\}\s*\)\s*\}[\s\S]*?this\.latest\s*=\s*resp/
    )
    expect(script).toMatch(/beforeUnmount\s*\(\s*\)\s*\{\s*this\.requestController\?\.abort\s*\(\s*\)[\s\S]*?this\.requestController\s*=\s*null\s*\}/)
    expect(script).not.toMatch(/graphql-tag|\$apollo/)
    expect(script).toMatch(
      /useLocal\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.checkoutDateActive\s*=\s*this\.latest\.updatedAt[\s\S]*emitEditorConflictReset\s*\(\s*\)[\s\S]*this\.close\s*\(\s*\)/
    )
    expect(script).toMatch(/useRemote\s*\(\s*\)\s*\{[\s\S]*wikiStore\.editor\.content\s*=\s*this\.latest\.content[\s\S]*emitEditorConflictResolved\s*\(\s*\)/)
    expect(source).toContain("aria-labelledby='editor-conflict-title'")
    expect(source).toContain("span#editor-conflict-title {{$t('editor:conflict.title')}}")
    expect(source).toContain("aria-labelledby='editor-conflict-overwrite-title'")
    expect(source).toContain("span#editor-conflict-overwrite-title {{$t('editor:conflict.overwrite.title')}}")
    expect(source).toMatch(/v-btn\.mt-2\([^)]*:href='`\/` \+ latest\.locale \+ `\/` \+ latest\.path'[^)]*target='_blank'[^)]*rel='noopener'/)
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
