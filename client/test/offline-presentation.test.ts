import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { forgetReaderDates, offlinePresentation, rememberOfflinePresentation, rememberReaderDates, savedReaderDates } from '../helpers/offline-presentation.ts'
import { OFFLINE_DEFAULT_LOGO_PATH } from '../helpers/offline-branding.ts'

const origin = 'https://wiki.example.test'
const key = 'tsepistle.offline.presentation.v1'
const logo = `/_site-logo/${'a'.repeat(64)}/logo.png`
afterEach(() => vi.unstubAllGlobals())

function presentationStorage(value = '{}') {
  const values = new Map([[key, value]])
  vi.stubGlobal('localStorage', { getItem: (name: string) => values.get(name), setItem: (name: string, next: string) => values.set(name, next) })
  vi.stubGlobal('window', { location: { origin } })
  vi.stubGlobal('document', { querySelector: () => null })
  vi.stubGlobal('caches', undefined)
  return values
}

describe('offline presentation branding allowlist', () => {
  it('remembers only normalized public presentation data without bootstrap credentials, user state, or logo effects', () => {
    const values = presentationStorage()
    vi.stubGlobal('siteConfig', {
      title: 'Reading\u0000 room',
      logoUrl: logo,
      logoEffect: { private: 'never persisted' },
      agentCsrfToken: 'secret',
      user: { authenticated: true, privatePageTitle: 'secret page' },
      lang: 'en',
      rtl: false
    })
    rememberOfflinePresentation('dark')
    const stored = values.get(key)!
    expect(JSON.parse(stored).title).toBe('Reading room')
    expect(JSON.parse(stored).logoUrl).toBe(logo)
    expect(stored).not.toMatch(/secret|authenticated|private|logoEffect/u)
    expect(offlinePresentation().config.logoUrl).toBe(logo)
    expect(offlinePresentation().config.logoEffect).toBeNull()
  })

  it('revalidates local presentation data and permits the exact bundled default', () => {
    const values = presentationStorage()
    for (const logoUrl of ['https://other.test/logo.png', '/uploads/logo.png', `${logo}?token=secret`, 'data:image/png;base64,abc']) {
      values.set(key, JSON.stringify({ logoUrl }))
      expect(offlinePresentation().config.logoUrl).toBe('')
    }
    values.set(key, JSON.stringify({ logoUrl: OFFLINE_DEFAULT_LOGO_PATH }))
    expect(offlinePresentation().config.logoUrl).toBe(OFFLINE_DEFAULT_LOGO_PATH)
  })
})

describe('saved reader dates', () => {
  const datesKey = 'tsepistle.offline.dates.v1'
  function datesStorage() {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, next: string) => values.set(name, next),
      removeItem: (name: string) => values.delete(name)
    })
    return values
  }

  it('keeps only the validated time zone and formats, and forgets them on request', () => {
    const values = datesStorage()
    rememberReaderDates({ timezone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '24h', email: 'reader@example.test', id: 7 } as never)
    expect(JSON.parse(values.get(datesKey)!)).toEqual({ timezone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })
    expect(savedReaderDates()).toEqual({ timezone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })
    forgetReaderDates()
    expect(values.has(datesKey)).toBe(false)
    expect(savedReaderDates()).toBeNull()
  })

  it('does not keep or trust an unknown time zone or format', () => {
    const values = datesStorage()
    rememberReaderDates({ timezone: 'America/New_York' })
    rememberReaderDates({ timezone: '', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })
    expect(values.has(datesKey)).toBe(false)
    values.set(datesKey, JSON.stringify({ timezone: 'Not/AZone', dateFormat: '', timeFormat: 'locale' }))
    expect(savedReaderDates()).toBeNull()
    values.set(datesKey, JSON.stringify({ timezone: 'Europe/Berlin', dateFormat: '<b>', timeFormat: 'sometimes' }))
    expect(savedReaderDates()).toEqual({ timezone: 'Europe/Berlin', dateFormat: '', timeFormat: 'locale' })
    values.set(datesKey, '{broken')
    expect(savedReaderDates()).toBeNull()
  })
})
