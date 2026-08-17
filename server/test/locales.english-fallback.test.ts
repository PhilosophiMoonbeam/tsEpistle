import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import englishLocale from '../locales/en.json'

const originalWiki = Reflect.get(globalThis, 'WIKI')

afterEach(() => {
  vi.doUnmock('i18next')
  vi.resetModules()
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
})

describe('bundled English locale fallback', () => {
  it('contains the critical setup, authentication, and administration labels', () => {
    expect(englishLocale).toMatchObject({
      common: {
        welcome: {
          title: 'Welcome to your wiki!',
          createhome: 'Create Home Page'
        },
        header: {
          admin: 'Administration',
          account: 'Account'
        }
      },
      auth: {
        actions: {
          login: 'Log In'
        }
      },
      admin: {
        dashboard: {
          title: 'Dashboard'
        }
      }
    })
  })

  it('loads bundled English before installed locale overrides', async () => {
    const engine = {
      addResourceBundle: vi.fn()
    }
    vi.doMock('i18next', () => ({ default: engine }))
    Reflect.set(globalThis, 'WIKI', {
      IS_DEBUG: false,
      SERVERPATH: path.join(process.cwd(), 'server'),
      config: { lang: { code: 'en', namespaces: [], namespacing: false } },
      data: { localeNamespaces: ['admin'] },
      logger: { info: vi.fn() },
      models: {
        locales: {
          query: () => ({
            findOne: vi.fn().mockResolvedValue({
              strings: { admin: { dashboard: { title: 'Installed Dashboard' } } }
            })
          })
        }
      }
    })

    const localization = (await import('../core/localization.ts')).default
    await localization.refreshNamespaces()

    const adminBundles = engine.addResourceBundle.mock.calls
      .filter(([, namespace]) => namespace === 'admin')
    expect(adminBundles[0]).toEqual([
      'en',
      'admin',
      expect.objectContaining({ agents: { title: 'Agents', subtitle: expect.any(String) } }),
      true,
      true
    ])
    expect(adminBundles.at(-1)).toEqual([
      'en',
      'admin',
      { dashboard: { title: 'Installed Dashboard' } },
      true,
      true
    ])
  })
})
