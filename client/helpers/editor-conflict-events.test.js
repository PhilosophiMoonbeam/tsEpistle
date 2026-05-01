const fs = require('fs')
const path = require('path')

const editorConflictEvents = require('./editor-conflict-events')

const {
  EDITOR_SAVE_CONFLICT_EVENT,
  EDITOR_CONTENT_OVERWRITE_EVENT,
  EDITOR_CONFLICT_RESET_EVENT
} = editorConflictEvents

const repoRoot = path.resolve(__dirname, '../..')
const guardedFiles = [
  'client/components/editor.vue',
  'client/components/editor/editor-markdown.vue',
  'client/components/editor/editor-code.vue',
  'client/components/editor/editor-asciidoc.vue',
  'client/components/editor/editor-ckeditor.vue',
  'client/components/editor/editor-modal-conflict.vue',
  'client/components/editor/ckeditor/conflict.vue',
  'client/components/editor/editor-modal-drawio.vue'
]
const conflictEventNames = [
  EDITOR_SAVE_CONFLICT_EVENT,
  EDITOR_CONTENT_OVERWRITE_EVENT,
  EDITOR_CONFLICT_RESET_EVENT
]
const conflictEventCases = [
  ['EditorSaveConflict', EDITOR_SAVE_CONFLICT_EVENT],
  ['EditorContentOverwrite', EDITOR_CONTENT_OVERWRITE_EVENT],
  ['EditorConflictReset', EDITOR_CONFLICT_RESET_EVENT]
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

function directRootEventPattern (eventName) {
  return new RegExp(
    '\\bthis\\s*\\.\\s*\\$root\\s*\\.\\s*\\$(?:emit|on|off)\\s*\\(\\s*([\'"`])' + eventName + '\\1',
    'g'
  )
}

describe('editor conflict events', () => {
  test.each(conflictEventCases)('emit%s emits the shared %s event', (suffix, eventName) => {
    const root = createRoot()

    editorConflictEvents[`emit${suffix}`](root)

    expect(root.$emit).toHaveBeenCalledWith(eventName)
  })

  test('emitEditorConflictResolved emits overwrite before reset', () => {
    const root = createRoot()

    editorConflictEvents.emitEditorConflictResolved(root)

    expect(root.$emit).toHaveBeenNthCalledWith(1, EDITOR_CONTENT_OVERWRITE_EVENT)
    expect(root.$emit).toHaveBeenNthCalledWith(2, EDITOR_CONFLICT_RESET_EVENT)
  })

  test.each(conflictEventCases)('on%s subscribes to the shared %s event', (suffix, eventName) => {
    const root = createRoot()
    const handler = jest.fn()

    editorConflictEvents[`on${suffix}`](root, handler)

    expect(root.$on).toHaveBeenCalledWith(eventName, handler)
  })

  test.each(conflictEventCases)('off%s unsubscribes from the shared %s event with the same handler', (suffix, eventName) => {
    const root = createRoot()
    const handler = jest.fn()

    editorConflictEvents[`off${suffix}`](root, handler)

    expect(root.$off).toHaveBeenCalledWith(eventName, handler)
  })

  test.each(conflictEventCases)('off%s does not broadly unsubscribe without a handler', (suffix) => {
    const root = createRoot()

    editorConflictEvents[`off${suffix}`](root)

    expect(root.$off).not.toHaveBeenCalled()
  })
})

describe('editor conflict event usage', () => {
  test('editor conflict components use the helper instead of direct root bus conflict events', () => {
    const offenders = []

    for (const relPath of guardedFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')

      for (const eventName of conflictEventNames) {
        const pattern = directRootEventPattern(eventName)
        let match

        while ((match = pattern.exec(content)) !== null) {
          offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root event for ${eventName}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
