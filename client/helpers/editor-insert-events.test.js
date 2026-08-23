import fs from 'node:fs'
import path from 'node:path'

import { EDITOR_INSERT_EVENT,
emitEditorInsert,
onEditorInsert,
offEditorInsert } from './editor-insert-events.ts'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const guardedEmitterFiles = [
  'client/components/editor/editor-modal-media.vue',
  'client/components/editor/editor-modal-drawio.vue'
]
const guardedListenerFiles = [
  'client/components/admin/admin-general.vue',
  'client/components/admin/admin-security.vue',
  'client/components/editor/editor-api.vue',
  'client/components/editor/editor-code.vue',
  'client/components/editor/editor-ckeditor.vue',
  'client/components/editor/tiptap/editor.vue',
  'client/components/editor/editor-asciidoc.vue',
  'client/components/editor/editor-markdown.vue'
]

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directEditorInsertEmitPattern () {
  return /\bthis\s*\.\s*\$root\s*\.\s*\$emit\s*\(\s*(['"`])editorInsert\1/g
}

function directEditorInsertListenerPattern () {
  return /\bthis\s*\.\s*\$root\s*\.\s*\$(?:on|off)\s*\(\s*(['"`])editorInsert\1/g
}

function helperRootCallPattern () {
  return /\b(?:emit|on|off)EditorInsert\s*\(\s*this\s*\.\s*\$root/g
}

describe('editor insert events', () => {
  test('editor insert helper uses the shared non-Vue event bus', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'client/helpers/editor-insert-events.ts'), 'utf8')

    expect(source).toContain("import { createEventBus } from '" + "./simple-event-bus'")
    expect(source).not.toMatch(/requ\u0069re\(\s*['"]vue['"]\s*\)/)
    expect(source).not.toMatch(/new\s+Vue\s*\(/)
    expect(source).not.toMatch(/\.\$(?:emit|on|off)\s*\(/)
  })

  test('emitEditorInsert emits the shared editor insert event with the original payload', () => {
    const handler = vi.fn()
    const opts = {
      kind: 'IMAGE',
      path: '/asset.png',
      text: 'asset.png',
      align: 'center'
    }

    onEditorInsert(handler)
    emitEditorInsert(opts)
    offEditorInsert(handler)

    expect(handler).toHaveBeenCalledWith(opts)
  })

  test('offEditorInsert unsubscribes from the shared editor insert event with the same handler', () => {
    const handler = vi.fn()

    onEditorInsert(handler)
    offEditorInsert(handler)
    emitEditorInsert({ kind: 'IMAGE', path: '/asset.png' })

    expect(handler).not.toHaveBeenCalled()
  })

  test('offEditorInsert does not broadly unsubscribe without a handler', () => {
    const handler = vi.fn()

    onEditorInsert(handler)
    offEditorInsert()
    emitEditorInsert({ kind: 'IMAGE', path: '/asset.png' })
    offEditorInsert(handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('editor insert event emitter usage', () => {
  test('editor insert emitters avoid direct root bus emits and root-backed helper calls', () => {
    const offenders = []

    for (const relPath of guardedEmitterFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const directPattern = directEditorInsertEmitPattern()
      const helperPattern = helperRootCallPattern()
      let match

      while ((match = directPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root.$emit for ${EDITOR_INSERT_EVENT}`)
      }
      while ((match = helperPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: root-backed editor insert helper call`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('editor insert event listener usage', () => {
  test('migrated and cleaned-up listeners avoid direct root bus listeners and root-backed helper calls', () => {
    const offenders = []

    for (const relPath of guardedListenerFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const directPattern = directEditorInsertListenerPattern()
      const helperPattern = helperRootCallPattern()
      let match

      while ((match = directPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root listener for ${EDITOR_INSERT_EVENT}`)
      }
      while ((match = helperPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: root-backed editor insert helper call`)
      }
    }

    expect(offenders).toEqual([])
  })
})
