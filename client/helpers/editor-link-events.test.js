import fs from 'node:fs'
import path from 'node:path'

import { EDITOR_LINK_TO_PAGE_EVENT,
emitEditorLinkToPage,
onEditorLinkToPage,
offEditorLinkToPage } from './editor-link-events.ts'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const guardedLinkListenerFiles = [
  'client/components/editor/editor-ckeditor.vue',
  'client/components/editor/tiptap/editor.vue'
]

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directEditorLinkToPagePattern () {
  return /\bthis\s*\.\s*\$root\s*\.\s*\$(?:emit|on|off)\s*\(\s*(['"`])editorLinkToPage\1/g
}

function helperRootCallPattern () {
  return /\b(?:emit|on|off)EditorLinkToPage\s*\(\s*this\s*\.\s*\$root/g
}

describe('editor link events', () => {
  test('editor link helper uses the shared non-Vue event bus', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'client/helpers/editor-link-events.ts'), 'utf8')

    expect(source).toContain("import { createEventBus } from '" + "./simple-event-bus'")
    expect(source).not.toMatch(/requ\u0069re\(\s*['"]vue['"]\s*\)/)
    expect(source).not.toMatch(/new\s+Vue\s*\(/)
    expect(source).not.toMatch(/\.\$(?:emit|on|off)\s*\(/)
  })

  test('emitEditorLinkToPage emits the shared editor link event with the original payload', () => {
    const handler = vi.fn()
    const opts = {
      locale: 'en',
      path: 'docs/page'
    }

    onEditorLinkToPage(handler)
    emitEditorLinkToPage(opts)
    offEditorLinkToPage(handler)

    expect(handler).toHaveBeenCalledWith(opts)
  })

  test('offEditorLinkToPage unsubscribes from the shared editor link event with the same handler', () => {
    const handler = vi.fn()

    onEditorLinkToPage(handler)
    offEditorLinkToPage(handler)
    emitEditorLinkToPage({ locale: 'en', path: 'docs/page' })

    expect(handler).not.toHaveBeenCalled()
  })

  test('offEditorLinkToPage does not broadly unsubscribe without a handler', () => {
    const handler = vi.fn()

    onEditorLinkToPage(handler)
    offEditorLinkToPage()
    emitEditorLinkToPage({ locale: 'en', path: 'docs/page' })
    offEditorLinkToPage(handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('editor link event listener usage', () => {
  test('migrated link listeners avoid direct root bus listeners and root-backed helper calls', () => {
    const offenders = []

    for (const relPath of guardedLinkListenerFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const directPattern = directEditorLinkToPagePattern()
      const helperPattern = helperRootCallPattern()
      let match

      while ((match = directPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root listener for ${EDITOR_LINK_TO_PAGE_EVENT}`)
      }
      while ((match = helperPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: root-backed editor link helper call`)
      }
    }

    expect(offenders).toEqual([])
  })
})
