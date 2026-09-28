import path from 'node:path'
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
    const engine = {
      addResourceBundle: vi.fn(),
      removeResourceBundle: vi.fn(),
      changeLanguage: vi.fn()
    }
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

    const adminBundles = engine.addResourceBundle.mock.calls
      .filter(([, namespace]) => namespace === 'admin')
    expect(adminBundles).toHaveLength(1)
    expect(adminBundles[0]?.slice(0, 2)).toEqual(['en', 'admin'])
    expect(adminBundles[0]?.[2]).toMatchObject({ dashboard: { title: englishLocale.admin.dashboard.title } })
    expect(adminBundles[0]?.slice(3)).toEqual([true, true])
    expect(engine.changeLanguage).toHaveBeenCalledWith('en')
  })
})
