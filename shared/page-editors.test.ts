import { describe, expect, it } from '../server/test/bun-test.mts'
import { defaultAvailableEditors, isPageEditorKey, normalizeAvailableEditors, validateAvailableEditors } from './page-editors.ts'

describe('page editor availability', () => {
  it('defaults legacy or unusable configuration to Markdown editors', () => {
    expect(defaultAvailableEditors()).toEqual(['markdown', 'visual-markdown'])
    expect(normalizeAvailableEditors(undefined)).toEqual(defaultAvailableEditors())
    expect(normalizeAvailableEditors([])).toEqual(defaultAvailableEditors())
    expect(normalizeAvailableEditors(['unsupported'])).toEqual(defaultAvailableEditors())
  })

  it('normalizes explicit non-default selections into the stable product order', () => {
    expect(normalizeAvailableEditors(['code', 'asciidoc', 'ckeditor'])).toEqual(['ckeditor', 'asciidoc', 'code'])
  })

  it('accepts explicit non-default editors and canonicalizes their order', () => {
    expect(validateAvailableEditors(['code', 'asciidoc', 'ckeditor'])).toEqual({
      ok: true,
      value: ['ckeditor', 'asciidoc', 'code']
    })
  })

  it.each([
    [null, 'Available editors must be an array.'],
    [[], 'At least one editor must remain available.'],
    [['markdown', 'unknown'], 'Available editors contains an unsupported editor.'],
    [['markdown', 'markdown'], 'Available editors must not contain duplicates.']
  ])('rejects invalid persisted selections', (value, message) => {
    expect(validateAvailableEditors(value)).toEqual({ ok: false, message })
  })

  it('recognizes only editors exposed by the page creation chooser', () => {
    expect(isPageEditorKey('markdown')).toBe(true)
    expect(isPageEditorKey('api')).toBe(false)
    expect(isPageEditorKey('redirect')).toBe(false)
  })
})
