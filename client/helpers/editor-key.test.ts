import { describe, expect, it } from 'vitest'
import { getEditorComponentName } from './editor-key.ts'

describe('getEditorComponentName', () => {
  it.each([
    ['markdown', 'editorMarkdown'],
    ['ckeditor', 'editorCkeditor'],
    ['visual-markdown', 'editorVisualMarkdown']
  ])('maps editor key %s to component %s', (editorKey, componentName) => {
    expect(getEditorComponentName(editorKey)).toBe(componentName)
  })
})
