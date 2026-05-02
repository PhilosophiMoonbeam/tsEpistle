const fs = require('fs')
const path = require('path')

const {
  EDITOR_INSERT_EVENT,
  emitEditorInsert,
  onEditorInsert,
  offEditorInsert
} = require('./editor-insert-events')

const repoRoot = path.resolve(__dirname, '../..')
const guardedEmitterFiles = [
  'client/components/editor/editor-modal-media.vue',
  'client/components/editor/editor-modal-drawio.vue'
]
const guardedListenerFiles = [
  'client/components/admin/admin-general.vue',
  'client/components/admin/admin-security.vue',
  'client/components/editor/editor-api.vue',
  'client/components/editor/editor-code.vue',
  'client/components/editor/editor-ckeditor.vue'
]

function createRoot () {
  return {
    $emit: jest.fn(),
    $on: jest.fn(),
    $off: jest.fn()
  }
}

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directEditorInsertEmitPattern () {
  return /\bthis\s*\.\s*\$root\s*\.\s*\$emit\s*\(\s*(['"`])editorInsert\1/g
}

function directEditorInsertListenerPattern () {
  return /\bthis\s*\.\s*\$root\s*\.\s*\$(?:on|off)\s*\(\s*(['"`])editorInsert\1/g
}

describe('editor insert events', () => {
  test('emitEditorInsert emits the shared editor insert event with the original payload', () => {
    const root = createRoot()
    const opts = {
      kind: 'IMAGE',
      path: '/asset.png',
      text: 'asset.png',
      align: 'center'
    }

    emitEditorInsert(root, opts)

    expect(root.$emit).toHaveBeenCalledWith(EDITOR_INSERT_EVENT, opts)
  })

  test('onEditorInsert subscribes to the shared editor insert event', () => {
    const root = createRoot()
    const handler = jest.fn()

    onEditorInsert(root, handler)

    expect(root.$on).toHaveBeenCalledWith(EDITOR_INSERT_EVENT, handler)
  })

  test('offEditorInsert unsubscribes from the shared editor insert event with the same handler', () => {
    const root = createRoot()
    const handler = jest.fn()

    offEditorInsert(root, handler)

    expect(root.$off).toHaveBeenCalledWith(EDITOR_INSERT_EVENT, handler)
  })

  test('offEditorInsert does not broadly unsubscribe without a handler', () => {
    const root = createRoot()

    offEditorInsert(root)

    expect(root.$off).not.toHaveBeenCalled()
  })
})

describe('editor insert event emitter usage', () => {
  test('editor insert emitters use the helper instead of direct root bus emits', () => {
    const offenders = []

    for (const relPath of guardedEmitterFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const pattern = directEditorInsertEmitPattern()
      let match

      while ((match = pattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root.$emit for ${EDITOR_INSERT_EVENT}`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('editor insert event listener usage', () => {
  test('migrated and cleaned-up listeners avoid direct root bus listeners', () => {
    const offenders = []

    for (const relPath of guardedListenerFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const pattern = directEditorInsertListenerPattern()
      let match

      while ((match = pattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root listener for ${EDITOR_INSERT_EVENT}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
