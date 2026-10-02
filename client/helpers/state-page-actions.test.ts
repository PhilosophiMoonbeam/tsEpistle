import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow } from '../test/browser-dom.mts'
import { goBackOrHome, searchQueryFromPath } from './state-page-actions.ts'

describe('searchQueryFromPath', () => {
  it('turns a missing page path into search words', () => {
    expect(searchQueryFromPath('/en/guides/getting-started', ['en', 'de'])).toBe('guides getting started')
    expect(searchQueryFromPath('/_private/en/team_notes', ['en'])).toBe('team notes')
    expect(searchQueryFromPath('/release-notes.html', ['en'])).toBe('release notes')
  })

  it('keeps a lone segment that looks like a locale', () => {
    expect(searchQueryFromPath('/de', ['de'])).toBe('de')
    expect(searchQueryFromPath('/', ['en'])).toBe('')
  })
})

describe('goBackOrHome', () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const override = (target: object, key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(target, key))
    Object.defineProperty(target, key, { configurable: true, get: () => value })
  }
  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      const target = key === 'referrer' ? browserWindow.document : browserWindow.history
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else Reflect.deleteProperty(target, key)
    }
    descriptors.clear()
    vi.restoreAllMocks()
  })

  it('returns to a previous page on this site', () => {
    override(browserWindow.document, 'referrer', `${browserWindow.location.origin}/en/home`)
    override(browserWindow.history, 'length', 3)
    const back = vi.spyOn(browserWindow.history, 'back').mockImplementation(() => {})
    goBackOrHome('/')
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('opens the fallback instead of leaving the site', () => {
    override(browserWindow.document, 'referrer', 'https://elsewhere.example/')
    override(browserWindow.history, 'length', 3)
    const back = vi.spyOn(browserWindow.history, 'back').mockImplementation(() => {})
    // jsdom cannot navigate; the fallback is location.assign('/') instead of history.back().
    goBackOrHome('/')
    expect(back).not.toHaveBeenCalled()
  })
})
