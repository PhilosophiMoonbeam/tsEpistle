import { describe, expect, it } from '../../server/test/bun-test.mts'
import { glossaryDraft, glossaryWrite } from './glossary-form.ts'

describe('glossary write drafts', () => {
  it('omits withheld documentation fields independently until each control is dirty', () => {
    const draft = glossaryDraft('en')
    draft.term = 'Authorization'
    draft.definition = 'Updated text with a protected documentation association.'
    const untouched = glossaryWrite(draft, { page: false, label: false })
    expect(Object.hasOwn(untouched, 'documentationPageId')).toBe(false)
    expect(Object.hasOwn(untouched, 'documentationLabel')).toBe(false)
    draft.documentationLabel = 'Read more'
    const labelOnly = glossaryWrite(draft, { page: false, label: true })
    expect(Object.hasOwn(labelOnly, 'documentationPageId')).toBe(false)
    expect(labelOnly.documentationLabel).toBe('Read more')
    draft.documentationPageId = 19
    const pageOnly = glossaryWrite(draft, { page: true, label: false })
    expect(pageOnly.documentationPageId).toBe(19)
    expect(Object.hasOwn(pageOnly, 'documentationLabel')).toBe(false)
    draft.documentationPageId = null
    draft.documentationLabel = ''
    const unlinked = glossaryWrite(draft, { page: true, label: true })
    expect(unlinked.documentationPageId).toBeNull()
    expect(unlinked.documentationLabel).toBe('')
  })

  it('rejects canonical alias collisions and unsafe references without changing the draft', () => {
    const draft = glossaryDraft('en')
    draft.term = 'Café'
    draft.aliasesText = 'cafe\u0301'
    expect(() => glossaryWrite(draft, { page: false, label: false })).toThrow('distinct names')
    expect(draft.aliasesText).toBe('cafe\u0301')
    draft.aliasesText = 'Coffee'
    draft.references = [{ label: 'Unsafe', url: 'https://user:secret@example.test/private' }]
    expect(() => glossaryWrite(draft, { page: false, label: false })).toThrow('safe HTTP(S)')
    draft.references = [{ label: 'Allowed', url: 'https://example.test/docs' }]
    expect(glossaryWrite(draft, { page: false, label: false }).aliases).toEqual(['Coffee'])
  })
})
