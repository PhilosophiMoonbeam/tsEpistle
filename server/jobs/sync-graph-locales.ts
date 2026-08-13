import _ from 'lodash'
import { asRecord, asRecordArray, requestGraph } from './_graph.ts'

interface LocaleQuery extends PromiseLike<unknown> {
  update(data: Record<string, unknown>): LocaleQuery
  where(column: string, value: unknown): LocaleQuery
}
interface LocaleRow extends Record<string, unknown> {
  availability: number
  code: string
  name: string
  nativeName: string
  isRTL: boolean
}

interface WikiContext {
  config: { graphEndpoint: string, lang: { autoUpdate: boolean, namespacing: boolean, namespaces: string[], code: string } }
  logger: { info(message: string): void, error(message: string): void }
  cache: { set(key: string, value: unknown): unknown }
  models: { locales: { query(): LocaleQuery } }
  lang: { refreshNamespaces(): Promise<void> }
}
const wiki = WIKI as unknown as WikiContext

export default async function syncGraphLocales (): Promise<void> {
  wiki.logger.info('Syncing locales with Graph endpoint...')
  try {
    const response = asRecord(await requestGraph(wiki.config.graphEndpoint, `{
      localization { locales { availability code name nativeName isRTL createdAt updatedAt } }
    }`))
    const locales = _.sortBy(
      asRecordArray(asRecord(asRecord(response.data).localization).locales).map(readLocaleRow),
      'name'
    ).map(locale => ({
      ...locale,
      isInstalled: locale.code === 'en'
    }))
    wiki.cache.set('locales', locales)

    if (wiki.config.lang.autoUpdate) {
      const activeLocales = wiki.config.lang.namespacing ? wiki.config.lang.namespaces : [wiki.config.lang.code]
      for (const currentLocale of activeLocales) {
        const localeInfo = locales.find(locale => locale.code === currentLocale)
        if (!localeInfo) throw new Error(`Locale ${currentLocale} is missing from the Graph response.`)
        const stringsResponse = asRecord(await requestGraph(wiki.config.graphEndpoint, `query ($code: String!) {
          localization { strings(code: $code) { key value } }
        }`, { code: currentLocale }))
        const strings = asRecordArray(asRecord(asRecord(stringsResponse.data).localization).strings)
        const localeStrings: Record<string, unknown> = {}
        for (const row of strings) {
          const key = typeof row.key === 'string' ? row.key : ''
          if (!key || key.includes('::')) continue
          _.set(localeStrings, key.replace(':', '.'), typeof row.value === 'string' && row.value.length > 0 ? row.value : key)
        }
        await wiki.models.locales.query().update({
          code: currentLocale,
          strings: localeStrings,
          isRTL: localeInfo.isRTL,
          name: localeInfo.name,
          nativeName: localeInfo.nativeName,
          availability: localeInfo.availability
        }).where('code', currentLocale)
        wiki.logger.info(`Pulled latest locale updates for ${String(localeInfo.name)} from Graph endpoint: [ COMPLETED ]`)
      }
    }
    await wiki.lang.refreshNamespaces()
    wiki.logger.info('Syncing locales with Graph endpoint: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Syncing locales with Graph endpoint: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.message : String(error))
  }
}

function readLocaleRow (value: Record<string, unknown>): LocaleRow {
  if (!isLocaleRow(value)) {
    throw new Error('Invalid locale returned by the Graph endpoint.')
  }
  return value
}

function isLocaleRow (value: Record<string, unknown>): value is LocaleRow {
  return typeof value.availability === 'number' &&
    typeof value.code === 'string' &&
    typeof value.name === 'string' &&
    typeof value.nativeName === 'string' &&
    typeof value.isRTL === 'boolean'
}
