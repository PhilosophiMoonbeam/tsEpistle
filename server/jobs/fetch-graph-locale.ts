import _ from 'lodash'
import { asRecord, asRecordArray, requestGraph } from './_graph.ts'

interface LocaleQuery extends PromiseLike<unknown> {
  where(column: string, value: unknown): LocaleQuery
  first(): Promise<unknown>
  patch(data: Record<string, unknown>): LocaleQuery
  insert(data: Record<string, unknown>): Promise<unknown>
}

interface WikiContext {
  config: { graphEndpoint: string }
  logger: { info(message: string): void, error(message: string): void }
  cache: { get(key: string): Promise<unknown> }
  models: { locales: { query(): LocaleQuery } }
  lang: { refreshNamespaces(): Promise<void> }
}

const wiki = WIKI as unknown as WikiContext

export default async function fetchGraphLocale (localeCode: string): Promise<void> {
  wiki.logger.info(`Fetching locale ${localeCode} from Graph endpoint...`)

  try {
    const response = asRecord(await requestGraph(
      wiki.config.graphEndpoint,
      `query ($code: String!) {
        localization {
          strings(code: $code) {
            key
            value
          }
        }
      }`,
      { code: localeCode }
    ))
    const data = asRecord(response.data)
    const localization = asRecord(data.localization)
    const strings = asRecordArray(localization.strings)
    const localeStrings: Record<string, unknown> = {}

    for (const row of strings) {
      const key = typeof row.key === 'string' ? row.key : ''
      if (!key || key.includes('::')) {
        continue
      }
      const value = typeof row.value === 'string' && row.value.length > 0 ? row.value : key
      _.set(localeStrings, key.replace(':', '.'), value)
    }

    const cachedLocales = await wiki.cache.get('locales')
    if (!Array.isArray(cachedLocales)) {
      throw new Error('Failed to fetch cached locales list! Restart server to resolve this issue.')
    }

    const currentLocale = asRecordArray(cachedLocales).find(locale => locale.code === localeCode) ?? {}
    const existingLocale = await wiki.models.locales.query().where('code', localeCode).first()
    if (existingLocale) {
      await wiki.models.locales.query().patch({ strings: localeStrings }).where('code', localeCode)
    } else {
      await wiki.models.locales.query().insert({
        code: localeCode,
        strings: localeStrings,
        isRTL: currentLocale.isRTL,
        name: currentLocale.name,
        nativeName: currentLocale.nativeName,
        availability: currentLocale.availability
      })
    }

    await wiki.lang.refreshNamespaces()
    wiki.logger.info(`Fetching locale ${localeCode} from Graph endpoint: [ COMPLETED ]`)
  } catch (error) {
    wiki.logger.error(`Fetching locale ${localeCode} from Graph endpoint: [ FAILED ]`)
    wiki.logger.error(error instanceof Error ? error.message : String(error))
  }
}
