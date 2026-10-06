import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow } from '../test/browser-dom.mts'
import { goBackOrHome, safeEditorHref, searchQueryFromPath } from './state-page-actions.ts'

describe('searchQueryFromPath', () => {
  it('turns a missing page path into search words', () => {
    expect(searchQueryFromPath('/en/guides/getting-started', ['en', 'de'])).toBe('guides getting started')
    expect(searchQueryFromPath('/_private/en/team_notes', ['en'])).toBe('team notes')
    expect(searchQueryFromPath('/release-notes.html', ['en'])).toBe('release notes')
  })

  for (const action of ['e', 'h', 's']) {
    it(`removes the /${action} action before the private scope and locale`, () => {
      expect(searchQueryFromPath(`/${action}/en/missing-guide`, ['en', 'de'])).toBe('missing guide')
      expect(searchQueryFromPath(`/${action}/_private/en/missing-guide`, ['en', 'de'])).toBe('missing guide')
      expect(searchQueryFromPath(`/${action}/de/missing-guide.html`, ['en', 'de'])).toBe('missing guide')
      expect(searchQueryFromPath(`/${action}/_private/de/missing-guide.html`, ['en', 'de'])).toBe('missing guide')
      expect(searchQueryFromPath(`/${action}/missing-guide`, ['en', 'de'])).toBe('missing guide')
    })
  }

  it('keeps document segments instead of stripping arbitrary single-letter or action-like names', () => {
    expect(searchQueryFromPath('/x/missing-guide', ['en'])).toBe('x missing guide')
    expect(searchQueryFromPath('/guides/missing-guide', ['en'])).toBe('guides missing guide')
    expect(searchQueryFromPath('/history/missing-guide', ['en'])).toBe('history missing guide')
    expect(searchQueryFromPath('/en/h/missing-guide', ['en'])).toBe('h missing guide')
    expect(searchQueryFromPath('/_private/en/s/missing-guide', ['en'])).toBe('s missing guide')
    expect(searchQueryFromPath('/_private/de/missing-guide.html', ['en', 'de'])).toBe('missing guide')
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

describe('safeEditorHref', () => {
  it('keeps same-origin editor routes and drops anything else', () => {
    expect(safeEditorHref('/e/en/guides/new%20page')).toBe('/e/en/guides/new%20page')
    for (const value of [undefined, '', '/en/page', '//evil.example/e/x', '/e//evil.example', 'https://evil.example/e/x', '/e/en/a b', '/e/en\\x', 7]) {
      expect(safeEditorHref(value)).toBe('')
    }
  })
})
