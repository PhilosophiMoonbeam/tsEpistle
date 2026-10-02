import fs from 'node:fs'
import path from 'node:path'
import i18next from 'i18next'

/** Test-only `$t` that resolves keys against the bundled English locale, including plurals and interpolation. */
const resources = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8')) as Record<string, Record<string, unknown>>
const engine = i18next.createInstance()
await engine.init({
  lng: 'en',
  fallbackLng: 'en',
  ns: Object.keys(resources),
  defaultNS: 'common',
  resources: { en: resources },
  interpolation: { escapeValue: false },
  initAsync: false
})

export const translateEnglish = (key: string, options: Record<string, unknown> = {}): string => {
  const separator = key.indexOf(':')
  const namespace = separator < 0 ? 'common' : key.slice(0, separator)
  const keyPath = separator < 0 ? key : key.slice(separator + 1)
  if (!engine.exists(keyPath, { ns: namespace, ...options })) throw new Error(`Missing English string ${key}`)
  return engine.t(keyPath, { ns: namespace, ...options }) as string
}
