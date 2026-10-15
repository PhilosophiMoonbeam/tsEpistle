import fs from 'fs-extra'
import { fileURLToPath } from 'node:url'
import { flattenLocaleStrings } from '../helpers/locale-package.ts'
import type { LocalePackage } from '../../shared/locale-policy.ts'

/** Compare installed nonblank keys with this fork's source, never with fallback-expanded resources. */
export const readForkLocaleKeys = async (): Promise<Set<string>> => {
  const source: unknown = await fs.readJson(fileURLToPath(new URL('../locales/en.json', import.meta.url)))
  const keys = new Set(flattenLocaleStrings(source).keys())
  if (!keys.size) throw new Error('The bundled English locale has no source keys.')
  return keys
}

export const installedLocaleCoverage = (keys: ReadonlySet<string>, strings: unknown): LocalePackage['installedCoverage'] => {
  if (typeof strings === 'string') {
    try {
      strings = JSON.parse(strings) as unknown
    } catch {
      return null
    }
  }
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) return null
  const installed = flattenLocaleStrings(strings)
  let presentKeys = 0
  for (const key of keys) if (installed.has(key)) presentKeys++
  return { presentKeys, totalKeys: keys.size, missingKeys: keys.size - presentKeys, percent: Math.floor((presentKeys * 100) / keys.size) }
}
