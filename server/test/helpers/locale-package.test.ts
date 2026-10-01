import { describe, it, expect } from '../bun-test.mts'
import { LocaleCodeSchema, LocalePolicySchema, localeReadingPath } from '../../../shared/locale-policy.ts'
import { parseLocaleStrings, mergeLocaleCatalog, flattenLocaleStrings, LocaleCatalogResponseSchema } from '../../helpers/locale-package.ts'
const response = (strings: { key: string; value: string }[]) => ({ data: { localization: { strings } } })
const row = (key: string, value = 'Translated') => ({ key, value })
describe('Locale package boundary', () => {
  it('keeps translated strings and omits blanks so English fallback can work', () => {
    const strings = parseLocaleStrings(response([row('common:actions.save', 'Enregistrer'), row('admin:title', ''), row('admin::malformed'), row('common:message', '  Preserve source spacing  ')]))
    expect(JSON.parse(JSON.stringify(strings))).toEqual({ common: { actions: { save: 'Enregistrer' }, message: '  Preserve source spacing  ' } })
    const flattened = flattenLocaleStrings(strings)
    expect(flattened.size).toBe(2)
    expect(flattened.get('common.actions.save')).toBe('Enregistrer')
    expect(flattened.get('common.message')).toBe('  Preserve source spacing  ')
  })
  it('rejects prototype keys, conflicting leaves, duplicate keys and empty packages', () => {
    for (const strings of [[], [row('common:__proto__.value')], [row('common:constructor.prototype')], [row('common:message'), row('common:message.child')], [row('common:message.child'), row('common:message')], [row('common:message'), row('common:message')], [row('common:message', ' ')], [row('common:.message')]]) expect(() => parseLocaleStrings(response(strings))).toThrow()
    expect(Reflect.get({}, 'value')).toBeUndefined()
  })
  it('retains installed packages absent from the current remote catalog', () => {
    const en = { code: 'en', name: 'English', nativeName: 'English', availability: 100, isRTL: false }, fr = { ...en, code: 'fr', name: 'French' }
    expect(mergeLocaleCatalog([fr], [en])).toEqual([{ ...en, availableRemotely: false }, { ...fr, availableRemotely: true }])
    expect(LocaleCatalogResponseSchema.safeParse({ data: { localization: { locales: [en, en] } } }).success).toBe(false)
  })
  it('retains disabled language choices, includes the default when multilingual, and explains URL behavior', () => {
    const single = LocalePolicySchema.parse({ locale: 'en', autoUpdate: true, namespacing: false, namespaces: ['fr', 'fr'] })
    expect(LocaleCodeSchema.safeParse('en-12').success).toBe(false)
    expect(single.namespaces).toEqual(['fr']); expect(localeReadingPath(single)).toBe('/home'); expect(localeReadingPath(single, 'fr')).toBe('/fr/home')
    const multiple = LocalePolicySchema.parse({ ...single, namespacing: true })
    expect(multiple.namespaces).toEqual(['en', 'fr']); expect(localeReadingPath(multiple)).toBe('/en/home')
  })
})
