import path from 'node:path'
import { createInstance } from 'i18next'
import { afterEach, describe, expect, it, vi } from './bun-test.mts'
import englishLocale from '../locales/en.json'

const originalWiki = Reflect.get(globalThis, 'WIKI')

afterEach(() => {
  vi.unmockModule('i18next', import.meta.url)
  vi.resetModules()
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
})

describe('bundled English locale fallback', () => {
  it('keeps installed English rows from overriding the bundled translation', async () => {
    const engine = createInstance()
    await engine.init({ load: 'all', fallbackLng: 'en', lng: 'fr', ns: ['admin'], defaultNS: 'admin' })
    vi.mockModule('i18next', import.meta.url, () => ({ default: engine }))
    Reflect.set(globalThis, 'WIKI', {
      IS_DEBUG: false,
      SERVERPATH: path.join(process.cwd(), 'server'),
      config: { lang: { code: 'en', namespaces: [], namespacing: false } },
      data: { localeNamespaces: ['admin'] },
      logger: { info: vi.fn() },
      models: {
        locales: {
          query: () => ({
            select: async () => [{ code: 'en' }],
            findOne: vi.fn().mockResolvedValue({
              strings: { admin: { dashboard: { title: 'Installed Dashboard' } } }
            })
          })
        }
      }
    })

    const localization = (await vi.importFresh('../core/localization.ts', import.meta.url)).default
    await localization.refreshNamespaces()

    expect(engine.t('dashboard.title', { lng: 'en', ns: 'admin' })).toBe(englishLocale.admin.dashboard.title)
    expect(engine.language).toBe('en')
  })
})
