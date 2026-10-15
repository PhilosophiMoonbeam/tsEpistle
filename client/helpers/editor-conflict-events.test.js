import fs from 'node:fs'
import path from 'node:path'
import { babelParse } from '@vue/compiler-sfc'
import { describe, expect, test, vi } from '../../server/test/bun-test.mts'

import * as editorConflictEvents from './editor-conflict-events.ts'

const { EDITOR_SAVE_CONFLICT_EVENT, EDITOR_CONTENT_OVERWRITE_EVENT, EDITOR_CONFLICT_RESET_EVENT } = editorConflictEvents

const repoRoot = path.resolve(import.meta.dirname, '../..')
const conflictEventCases = [
  ['EditorSaveConflict', EDITOR_SAVE_CONFLICT_EVENT],
  ['EditorContentOverwrite', EDITOR_CONTENT_OVERWRITE_EVENT],
  ['EditorConflictReset', EDITOR_CONFLICT_RESET_EVENT]
]

function visitSyntax(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'comments') continue
    if (Array.isArray(value))
      value.forEach(child => {
        visitSyntax(child, visit)
      })
    else if (value && typeof value === 'object') visitSyntax(value, visit)
  }
}

describe('editor conflict events', () => {
  test('editor conflict transport has no Vue runtime or instance-bus dependency', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'client/helpers/editor-conflict-events.ts'), 'utf8')
    const violations = []
    visitSyntax(babelParse(source, { sourceType: 'module', plugins: ['typescript'] }), node => {
      if (node.type === 'ImportDeclaration' && /^vue(?:\/|$)/.test(node.source.value) && node.importKind !== 'type') {
        if (node.specifiers.length === 0 || node.specifiers.some(specifier => specifier.importKind !== 'type')) violations.push('Vue runtime import')
      }
      if (
        node.type === 'CallExpression' &&
        (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require')) &&
        node.arguments[0]?.type === 'StringLiteral' &&
        /^vue(?:\/|$)/.test(node.arguments[0].value)
      )
        violations.push('Vue runtime load')
      if (node.type === 'ImportExpression' && /^vue(?:\/|$)/.test(node.source.value ?? '')) violations.push('Vue runtime load')
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        const name = node.computed ? node.property.value : node.property.name
        if (['$emit', '$on', '$off'].includes(name)) violations.push('Vue instance bus')
      }
    })
    expect(violations).toEqual([])
  })

  test.each(conflictEventCases)('emit%s delivers only to its private %s channel', suffix => {
    const listeners = conflictEventCases.map(([name]) => ({ name, handler: vi.fn() }))
    for (const { name, handler } of listeners) editorConflictEvents[`on${name}`](handler)
    try {
      editorConflictEvents[`emit${suffix}`]()
      for (const { name, handler } of listeners) expect(handler).toHaveBeenCalledTimes(name === suffix ? 1 : 0)
    } finally {
      for (const { name, handler } of listeners) editorConflictEvents[`off${name}`](handler)
    }
  })

  test('emitEditorConflictResolved emits overwrite before reset', () => {
    const calls = []
    const overwriteHandler = vi.fn(() => calls.push(EDITOR_CONTENT_OVERWRITE_EVENT))
    const resetHandler = vi.fn(() => calls.push(EDITOR_CONFLICT_RESET_EVENT))

    editorConflictEvents.onEditorContentOverwrite(overwriteHandler)
    editorConflictEvents.onEditorConflictReset(resetHandler)
    editorConflictEvents.emitEditorConflictResolved()
    editorConflictEvents.offEditorContentOverwrite(overwriteHandler)
    editorConflictEvents.offEditorConflictReset(resetHandler)

    expect(calls).toEqual([EDITOR_CONTENT_OVERWRITE_EVENT, EDITOR_CONFLICT_RESET_EVENT])
    expect(overwriteHandler).toHaveBeenCalledTimes(1)
    expect(resetHandler).toHaveBeenCalledTimes(1)
  })

  test.each(conflictEventCases)('off%s removes only its handler from the private %s channel', suffix => {
    const removed = vi.fn()
    const remaining = vi.fn()
    editorConflictEvents[`on${suffix}`](removed)
    editorConflictEvents[`on${suffix}`](remaining)
    try {
      editorConflictEvents[`off${suffix}`](removed)
      editorConflictEvents[`emit${suffix}`]()
      expect(removed).not.toHaveBeenCalled()
      expect(remaining).toHaveBeenCalledTimes(1)
    } finally {
      editorConflictEvents[`off${suffix}`](removed)
      editorConflictEvents[`off${suffix}`](remaining)
    }
  })

  test.each(conflictEventCases)('off%s does not broadly unsubscribe without a handler', suffix => {
    const handler = vi.fn()

    editorConflictEvents[`on${suffix}`](handler)
    editorConflictEvents[`off${suffix}`]()
    editorConflictEvents[`emit${suffix}`]()
    editorConflictEvents[`off${suffix}`](handler)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})
