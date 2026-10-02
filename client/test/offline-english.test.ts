import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18next from 'i18next'
import { offlineEnglish } from '../helpers/offline-english.ts'

const english = JSON.parse(readFileSync(resolve('server/locales/en.json'), 'utf8')) as Record<string, Record<string, Record<string, string>>>
const components = [
  'client/offline-app.vue',
  'client/components/pwa/offline-library.vue',
  'client/components/pwa/offline-navigation.vue',
  'client/components/pwa/offline-settings.vue'
]

const sourceValue = (key: string): string | undefined => {
  const [namespace, path] = key.split(':')
  const [section, name] = path!.split('.')
  return english[namespace!]?.[section!]?.[name!]
}

const bundledValue = (key: string): string | undefined => {
  const [, path] = key.split(':')
  const [section, name] = path!.split('.')
  return (offlineEnglish as Record<string, Record<string, string>>)[section!]?.[name!]
}

describe('offline-only English shell', () => {
  test('every visible label matches online English, with no locale fetch', async () => {
    const visibleKeys = new Set(components.flatMap(path =>
      [...readFileSync(resolve(path), 'utf8').matchAll(/\$t\(\s*['"]([^'"]+)/g)].map(match => match[1]!)))
    expect(visibleKeys.size).toBeGreaterThan(90)
    const scriptKeys = new Set(components.flatMap(path =>
      [...readFileSync(resolve(path), 'utf8').matchAll(/(?<![\w$])t\(\s*['"]([^'"]+)/g)].map(match => match[1]!)))
    for (const key of new Set([...visibleKeys, ...scriptKeys])) {
      if (sourceValue(key)) expect(bundledValue(key)).toBe(sourceValue(key))
      else {
        expect(sourceValue(`${key}_other`)).toBeDefined()
        for (const suffix of ['one', 'other']) {
          expect(bundledValue(`${key}_${suffix}`)).toBe(sourceValue(`${key}_${suffix}`))
        }
      }
    }
    for (const [section, labels] of Object.entries(offlineEnglish)) {
      for (const [name, label] of Object.entries(labels)) {
        expect(label).toBe(english.common?.[section]?.[name])
      }
    }
    const offline = i18next.createInstance()
    await offline.init({ lng: 'en', fallbackLng: 'en', resources: { en: { common: offlineEnglish } } })
    for (const key of visibleKeys) {
      const online = sourceValue(key)
      if (online) {
        expect(bundledValue(key)).toBe(online)
        expect(offline.t(key)).toBe(online)
      } else {
        for (const suffix of ['one', 'other']) {
          expect(bundledValue(`${key}_${suffix}`)).toBe(sourceValue(`${key}_${suffix}`))
        }
      }
    }
    expect(offline.t('common:offlineSettings.offlineAccess')).toBe('Offline access')
    expect(offline.t('common:offlineLibrary.searchDevice')).toBe('Search this device')
    expect(offline.t('common:offlineLibrary.openSavedPage', { title: 'Example' })).toBe('Open saved page Example')
    expect(offline.t('common:offlineSettings.localDraftProtectedReconnect', { count: 2 })).toBe(sourceValue('common:offlineSettings.localDraftProtectedReconnect_other')?.replace('{{count}}', '2'))
  })
})
