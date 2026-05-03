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

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directRootEventPattern (eventName) {
  return new RegExp(
    '\\bthis\\s*\\.\\s*\\$root\\s*\\.\\s*\\$(?:emit|on|off)\\s*\\(\\s*([\'"`])' + eventName + '\\1',
    'g'
  )
}

function helperRootArgumentPattern () {
  return /\b(?:emit|on|off)Editor(?:SaveConflict|ContentOverwrite|ConflictReset|ConflictResolved)\s*\(\s*this\.\$root\b/g
}

describe('editor conflict events', () => {
  test('editor conflict helper uses the shared non-Vue event bus', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'client/helpers/editor-conflict-events.ts'), 'utf8')

    expect(source).toContain("import { createEventBus } from './simple-event-bus'")
    expect(source).not.toMatch(/require\(\s*['"]vue['"]\s*\)/)
    expect(source).not.toMatch(/new\s+Vue\s*\(/)
    expect(source).not.toMatch(/\.\$(?:emit|on|off)\s*\(/)
  })

  test.each(conflictEventCases)('emit%s emits the shared %s event on the private bus', (suffix) => {
    const handler = jest.fn()

    editorConflictEvents[`on${suffix}`](handler)
    editorConflictEvents[`emit${suffix}`]()
    editorConflictEvents[`off${suffix}`](handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('emitEditorConflictResolved emits overwrite before reset', () => {
    const calls = []
    const overwriteHandler = jest.fn(() => calls.push(EDITOR_CONTENT_OVERWRITE_EVENT))
    const resetHandler = jest.fn(() => calls.push(EDITOR_CONFLICT_RESET_EVENT))

    editorConflictEvents.onEditorContentOverwrite(overwriteHandler)
    editorConflictEvents.onEditorConflictReset(resetHandler)
    editorConflictEvents.emitEditorConflictResolved()
    editorConflictEvents.offEditorContentOverwrite(overwriteHandler)
    editorConflictEvents.offEditorConflictReset(resetHandler)

    expect(calls).toEqual([EDITOR_CONTENT_OVERWRITE_EVENT, EDITOR_CONFLICT_RESET_EVENT])
    expect(overwriteHandler).toHaveBeenCalledTimes(1)
    expect(resetHandler).toHaveBeenCalledTimes(1)
  })

  test.each(conflictEventCases)('off%s unsubscribes from the private %s event with the same handler', (suffix) => {
    const handler = jest.fn()

    editorConflictEvents[`on${suffix}`](handler)
    editorConflictEvents[`off${suffix}`](handler)
    editorConflictEvents[`emit${suffix}`]()

    expect(handler).not.toHaveBeenCalled()
  })

  test.each(conflictEventCases)('off%s does not broadly unsubscribe without a handler', (suffix) => {
    const handler = jest.fn()

    editorConflictEvents[`on${suffix}`](handler)
    editorConflictEvents[`off${suffix}`]()
    editorConflictEvents[`emit${suffix}`]()
    editorConflictEvents[`off${suffix}`](handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('editor conflict event usage', () => {
  test('markdown and code editors keep save-conflict and content-overwrite subscriptions wired to existing handlers', () => {
    const markdown = fs.readFileSync(path.join(repoRoot, 'client/components/editor/editor-markdown.vue'), 'utf8')
    const code = fs.readFileSync(path.join(repoRoot, 'client/components/editor/editor-code.vue'), 'utf8')

    expect(markdown).toContain('onEditorSaveConflict(this.handleEditorSaveConflict)')
    expect(markdown).toContain('onEditorContentOverwrite(this.handleEditorContentOverwrite)')
    expect(markdown).toContain('offEditorSaveConflict(this.handleEditorSaveConflict)')
    expect(markdown).toContain('offEditorContentOverwrite(this.handleEditorContentOverwrite)')
    expect(markdown).not.toContain('onEditorConflictReset(this.handleEditorConflictReset)')

    expect(code).toContain('onEditorSaveConflict(this.handleEditorSaveConflict)')
    expect(code).toContain('onEditorContentOverwrite(this.handleEditorContentOverwrite)')
    expect(code).toContain('offEditorSaveConflict(this.handleEditorSaveConflict)')
    expect(code).toContain('offEditorContentOverwrite(this.handleEditorContentOverwrite)')
    expect(code).not.toContain('onEditorConflictReset(this.handleEditorConflictReset)')
  })

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

      const helperPattern = helperRootArgumentPattern()
      let helperMatch
      while ((helperMatch = helperPattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, helperMatch.index)}: helper called with this.$root`)
      }
    }

    expect(offenders).toEqual([])
  })
})
