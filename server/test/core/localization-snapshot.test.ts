import path from 'node:path'
import { createInstance } from 'i18next'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
const originalWiki = globalThis.WIKI
afterEach(() => { vi.unmockModule('i18next', import.meta.url); vi.resetModules(); globalThis.WIKI = originalWiki })
describe('Locale resource snapshot activation', () => {
  it('refreshes retired keys while retaining bundled English fallback and script resources', async () => {
    const engine = createInstance()
    await engine.init({ load: 'all', fallbackLng: 'en', lng: 'en', ns: ['common'], defaultNS: 'common' })
    vi.mockModule('i18next', import.meta.url, () => ({ default: engine }))
    const lang = { code: 'sr-latn', namespaces: ['fr'], namespacing: true, revision: 'one' }
    const packages: Record<string, unknown> = { 'sr-latn': { common: { greeting: 'Zdravo', retired: 'Old phrase' } }, fr: { common: { greeting: 'Bonjour' } } }
    globalThis.WIKI = { IS_DEBUG: false, SERVERPATH: path.join(process.cwd(), 'server'), config: { lang }, data: { localeNamespaces: ['admin', 'auth', 'common'] }, models: { locales: { query: () => ({ select: async () => [{ code: 'en' }, { code: 'sr-latn' }, { code: 'fr' }], findOne: async (_: string, code: string) => packages[code] ? { strings: packages[code] } : null }) } } } as never
    const localization = (await vi.importFresh('../../core/localization.ts', import.meta.url)).default
    await localization.refreshNamespaces()
    expect(engine.t('greeting')).toBe('Zdravo')
    expect(engine.t('header.admin')).toBe('Administration')
    expect(engine.t('retired')).toBe('Old phrase')
    expect(engine.hasResourceBundle('fr', 'common')).toBe(true)
    expect(await localization.getByNamespace('sr-latn', 'common')).toContainEqual({ key: 'greeting', value: 'Zdravo' })
    packages['sr-latn'] = { common: { greeting: 'Novi pozdrav' } }; lang.namespacing = false; lang.revision = 'two'
    await localization.refreshNamespaces()
    expect(engine.t('greeting')).toBe('Novi pozdrav'); expect(engine.exists('retired')).toBe(false)
    expect(engine.t('header.admin')).toBe('Administration')
    expect(localization.appliedRevision).toBe('two')
    expect(localization.appliedLocale).toBe('sr-latn')
  })
  it('retains the complete previous resources when any enabled package cannot be read', async () => {
    const engine = createInstance()
    await engine.init({ load: 'all', fallbackLng: 'en', lng: 'en', ns: ['common'], defaultNS: 'common' })
    vi.mockModule('i18next', import.meta.url, () => ({ default: engine }))
    const lang = { code: 'en', namespaces: [] as string[], namespacing: false, revision: 'one' }
    globalThis.WIKI = { IS_DEBUG: false, SERVERPATH: path.join(process.cwd(), 'server'), config: { lang }, data: { localeNamespaces: ['common'] }, models: { locales: { query: () => ({ select: async () => [{ code: 'en' }], findOne: async () => null }) } } } as never
    const localization = (await vi.importFresh('../../core/localization.ts', import.meta.url)).default
    await localization.refreshNamespaces()
    lang.code = 'fr'; lang.revision = 'two'
    await expect(localization.refreshNamespaces()).rejects.toThrow('not installed')
    expect(engine.t('header.admin')).toBe('Administration'); expect(engine.language).toBe('en')
    expect(localization.appliedRevision).toBe('one')
    lang.code = 'en'; lang.revision = 'three'
    await localization.refreshNamespaces()
    expect(localization.appliedRevision).toBe('three')
  })
})
