import { describe, expect, it } from '../../server/test/bun-test.mts'
import { resolveTemplateEditorPath, templateEditorPath } from './editor-template.ts'
describe('template creation destination', () => {
  it('keeps private creation in the private namespace and escapes path/query syntax', () => {
    expect(templateEditorPath({ locale: 'en', path: 'notes/a?b#c', visibility: 'private', templateId: 7 })).toBe('/e/_private/en/notes/a%3Fb%23c?from=7')
    expect(templateEditorPath({ locale: 'fr', path: 'guides/start', visibility: 'public', templateId: 8 })).toBe('/e/fr/guides/start?from=8')
  })
  it('requires a concrete template identity', () => {
    expect(() => templateEditorPath({ locale: 'en', path: 'notes', visibility: 'private', templateId: 0 })).toThrow(Error)
  })
  it('prevents entering a template with an unavailable format and preserves metadata access failures', async () => {
    const input = { locale: 'en', path: 'notes/new', visibility: 'private' as const, templateId: 7 }
    await expect(resolveTemplateEditorPath(input, ['markdown'], async () => ({ editor: 'ckeditor' }))).rejects.toThrow(Error)
    const accessDenied = new Error('Access denied')
    await expect(resolveTemplateEditorPath(input, ['markdown'], async () => { throw accessDenied })).rejects.toBe(accessDenied)
    expect(await resolveTemplateEditorPath(input, ['markdown'], async () => ({ editor: 'markdown' }))).toBe('/e/_private/en/notes/new?from=7')
  })

})
