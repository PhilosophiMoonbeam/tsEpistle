import { z } from 'zod'
import { type LocaleCatalogEntry, LocaleCodeSchema } from '../../shared/locale-policy.ts'

export const LocaleCatalogEntrySchema = z.object({
  code: LocaleCodeSchema,
  name: z.string().trim().min(1).max(160),
  nativeName: z.string().trim().min(1).max(160),
  isRTL: z.boolean(),
  availability: z.number().int().min(0).max(100),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional()
})
export const LocaleCatalogSchema = z
  .array(LocaleCatalogEntrySchema)
  .max(300)
  .superRefine((rows, context) => {
    if (new Set(rows.map(row => row.code)).size !== rows.length) context.addIssue({ code: 'custom', message: 'The language catalog contains duplicate codes.' })
  })
export const LocaleCatalogResponseSchema = z.object({ data: z.object({ localization: z.object({ locales: LocaleCatalogSchema }) }) })
const LocaleStringsResponseSchema = z.object({ data: z.object({ localization: z.object({ strings: z.array(z.object({ key: z.string().max(500), value: z.string().max(100_000) })).min(1).max(30_000) }) }) })
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
export type LocaleStrings = Record<string, unknown>

/** Convert upstream namespace:key paths without allowing prototype or scalar/object collisions. */
export const parseLocaleStrings = (response: unknown): LocaleStrings => {
  const rows = LocaleStringsResponseSchema.parse(response).data.localization.strings
  const strings: LocaleStrings = Object.create(null)
  let count = 0
  for (const row of rows) {
    if (!row.key || row.key.includes('::')) continue
    const parts = row.key.replace(':', '.').split('.')
    if (parts.length < 2 || parts.length > 20 || parts.some(part => !part || forbidden.has(part))) throw new Error('The translation package contains an invalid key.')
    // Blank upstream translations must fall back to English rather than displaying a key.
    if (!row.value.trim()) continue
    let current = strings
    for (const part of parts.slice(0, -1)) {
      if (Object.hasOwn(current, part) && (!current[part] || typeof current[part] !== 'object')) throw new Error('The translation package contains conflicting keys.')
      if (!Object.hasOwn(current, part)) current[part] = Object.create(null)
      current = current[part] as LocaleStrings
    }
    const key = parts.at(-1)!
    if (Object.hasOwn(current, key)) throw new Error('The translation package contains duplicate or conflicting keys.')
    current[key] = row.value
    count++
  }
  if (!count) throw new Error('The translation package contains no translated strings.')
  return strings
}
export const mergeLocaleCatalog = (remote: LocaleCatalogEntry[], installed: LocaleCatalogEntry[]) => {
  const entries = new Map(remote.map(row => [row.code, { ...row, availableRemotely: true }]))
  for (const row of installed) if (!entries.has(row.code)) entries.set(row.code, { ...row, availableRemotely: false })
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
}
export const flattenLocaleStrings = (strings: unknown, prefix = ''): Map<string, string> => {
  const entries = new Map<string, string>()
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) return entries
  for (const [key, value] of Object.entries(strings)) {
    if (forbidden.has(key)) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string' && value.trim()) entries.set(path, value)
    else if (prefix.split('.').length < 20) for (const pair of flattenLocaleStrings(value, path)) entries.set(...pair)
  }
  return entries
}
