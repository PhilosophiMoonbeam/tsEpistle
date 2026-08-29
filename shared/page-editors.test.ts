import { describe, expect, it } from '../server/test/bun-test.mts'
import {
  defaultAvailableEditors,
  isPageEditorKey,
  normalizeAvailableEditors,
  validateAvailableEditors
} from './page-editors.ts'

describe('page editor availability', () => {
  it('defaults legacy or unusable configuration to every page editor', () => {
    expect(normalizeAvailableEditors(undefined)).toEqual(defaultAvailableEditors())
    expect(normalizeAvailableEditors([])).toEqual(defaultAvailableEditors())
    expect(normalizeAvailableEditors(['unsupported'])).toEqual(defaultAvailableEditors())
  })

  it('normalizes valid selections into the stable product order', () => {
    expect(normalizeAvailableEditors(['code', 'markdown', 'code'])).toEqual(['markdown', 'code'])
  })

  it('accepts a non-empty unique selection and canonicalizes its order', () => {
    expect(validateAvailableEditors(['code', 'visual-markdown'])).toEqual({
      ok: true,
      value: ['visual-markdown', 'code']
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
