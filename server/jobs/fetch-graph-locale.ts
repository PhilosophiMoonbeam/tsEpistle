import _ from 'lodash'
import { z } from 'zod'

import { requestGraph } from './_graph.ts'

const LocaleStringsResponseSchema = z.object({
  data: z.object({
    localization: z.object({
      strings: z.array(
        z.object({
          key: z.string(),
          value: z.string()
        })
      )
    })
  })
})

const CachedLocalesSchema = z.array(z.record(z.string(), z.unknown()))

interface LocaleQuery extends PromiseLike<unknown> {
  where(column: string, value: unknown): LocaleQuery
  first(): Promise<unknown>
  patch(data: Record<string, unknown>): LocaleQuery
  insert(data: Record<string, unknown>): Promise<unknown>
}

interface WikiContext {
  config: { graphEndpoint: string }
  logger: { info(message: string): void; error(message: string): void }
  cache: { get(key: string): Promise<unknown> }
  models: { locales: { query(): LocaleQuery } }
  lang: { refreshNamespaces(): Promise<void> }
}

const wiki = WIKI as unknown as WikiContext

export default async function fetchGraphLocale(localeCode: string): Promise<void> {
  wiki.logger.info(`Fetching locale ${localeCode} from Graph endpoint...`)

  try {
    const response = LocaleStringsResponseSchema.parse(
      await requestGraph(
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
      )
    )
    const localeStrings: Record<string, unknown> = {}

    for (const row of response.data.localization.strings) {
      if (!row.key || row.key.includes('::')) {
        continue
      }
      const value = row.value.length > 0 ? row.value : row.key
      _.set(localeStrings, row.key.replace(':', '.'), value)
    }

    const cachedLocales = CachedLocalesSchema.parse(await wiki.cache.get('locales'))
    const currentLocale = cachedLocales.find(locale => locale.code === localeCode) ?? {}
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
    throw error
  }
}
