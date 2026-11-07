import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { LocaleCatalogEntry, LocaleEvent } from '../../shared/locale-policy.ts'
import { LocaleCatalogSchema, type LocaleStrings } from '../helpers/locale-package.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
export interface AutomaticLocaleUpdate {
  locale: LocaleCatalogEntry
  strings: LocaleStrings
  expectedUpdatedAt: string
}
export const publishLocaleSynchronization = async (
  db: Knex,
  input: { endpoint: string; catalog: LocaleCatalogEntry[]; updates: AutomaticLocaleUpdate[]; fallback: Record<string, unknown> }
) => {
  const catalog = LocaleCatalogSchema.parse(input.catalog)
  return db.transaction(async tx => {
    // Share the administration lock order; never overwrite a manual install fetched concurrently.
    await tx('groups').select('id').orderBy('id').forUpdate()
    const rows = await tx('settings').whereIn('key', ['lang', 'localeAdministration', 'localeCatalog', 'graphEndpoint', 'offline']).orderBy('key').forUpdate()
    const config = {
      ...input.fallback,
      ...Object.fromEntries(
        rows.map(row => [row.key, ['offline', 'graphEndpoint'].includes(row.key) && Object.hasOwn(record(row.value), 'v') ? record(row.value).v : row.value])
      )
    }
    if (config.offline === true || config.graphEndpoint !== input.endpoint) throw new Error('Language source or offline policy changed during synchronization.')
    const now = new Date().toISOString(),
      lang = record(config.lang),
      metadata = record(config.localeAdministration)
    const put = async (key: string, value: unknown) => {
      await tx('settings')
        .insert({ key, value: JSON.stringify(value), updatedAt: now })
        .onConflict('key')
        .merge(['value', 'updatedAt'])
    }
    await put('localeCatalog', { locales: catalog, observedAt: now })
    const active = new Set([lang.code, ...(lang.namespacing === true && Array.isArray(lang.namespaces) ? lang.namespaces : [])])
    const manualJob = await tx('durableJobs').where({ type: 'locale-package', version: 1 }).whereIn('state', ['pending', 'running']).first('id')
    const changed: string[] = []
    let rtl = lang.rtl
    if (lang.autoUpdate === true && !manualJob)
      for (const update of input.updates) {
        if (!active.has(update.locale.code)) continue
        const current = await tx('locales').where('code', update.locale.code).forUpdate().first()
        if (!current || current.updatedAt !== update.expectedUpdatedAt) continue
        const data = {
          name: update.locale.name,
          nativeName: update.locale.nativeName,
          availability: update.locale.availability,
          isRTL: update.locale.isRTL,
          strings: update.strings
        }
        const previous = {
          name: current.name,
          nativeName: current.nativeName,
          availability: current.availability,
          isRTL: current.isRTL,
          strings: current.strings
        }
        if (stable(data) === stable(previous)) continue
        await tx('locales')
          .where('code', update.locale.code)
          .update({ ...data, strings: JSON.stringify(data.strings), updatedAt: now })
        changed.push(update.locale.code)
        if (update.locale.code === lang.code) rtl = update.locale.isRTL
      }
    if (changed.length) {
      const event: LocaleEvent = {
        id: randomUUID(),
        actorId: null,
        kind: 'install',
        reason: 'Automatic interface package synchronization',
        fields: changed.map(code => `package:${code}`),
        createdAt: now,
        appliedAt: now
      }
      await put('lang', { ...lang, rtl, revision: event.id })
      await put('localeAdministration', {
        ...metadata,
        revision: event.id,
        history: [event, ...(Array.isArray(metadata.history) ? metadata.history : [])].slice(0, 50)
      })
    }
    return { changed }
  })
}
