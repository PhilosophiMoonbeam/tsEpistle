import _ from 'lodash'
import { z } from 'zod'

import { requestGraph } from './_graph.ts'

const LocaleRowSchema = z
  .object({
    availability: z.number(),
    code: z.string(),
    name: z.string(),
    nativeName: z.string(),
    isRTL: z.boolean()
  })
  .passthrough()
type LocaleRow = z.infer<typeof LocaleRowSchema>
type LocaleUpdate = Pick<LocaleRow, 'availability' | 'code' | 'isRTL' | 'name' | 'nativeName'> & {
  strings: Record<string, unknown>
}

const LocaleListResponseSchema = z.object({
  data: z.object({
    localization: z.object({
      locales: z.array(LocaleRowSchema)
    })
  })
})

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

interface WikiContext {
  config: { graphEndpoint: string; lang: { autoUpdate: boolean; namespacing: boolean; namespaces: string[]; code: string } }
  logger: { info(message: string): void; error(message: string): void }
  cache: { set(key: string, value: unknown): unknown }
  models: {
    locales: {
      query(): {
        update(data: LocaleUpdate): {
          where(column: 'code', value: LocaleUpdate['code']): PromiseLike<unknown>
        }
      }
    }
  }
  lang: { refreshNamespaces(): Promise<void> }
}
const wiki = WIKI as unknown as WikiContext

export default async function syncGraphLocales(): Promise<void> {
  wiki.logger.info('Syncing locales with Graph endpoint...')
  try {
    const response = LocaleListResponseSchema.parse(
      await requestGraph(
        wiki.config.graphEndpoint,
        `{
      localization { locales { availability code name nativeName isRTL createdAt updatedAt } }
    }`
      )
    )
    const locales = _.sortBy(response.data.localization.locales, 'name').map(locale => ({
      ...locale,
      isInstalled: locale.code === 'en'
    }))
    const localeUpdates: Array<{ localeInfo: LocaleRow; strings: Record<string, unknown> }> = []

    if (wiki.config.lang.autoUpdate) {
      const activeLocales = wiki.config.lang.namespacing ? wiki.config.lang.namespaces : [wiki.config.lang.code]
      for (const currentLocale of activeLocales) {
        const localeInfo = locales.find(locale => locale.code === currentLocale)
        if (!localeInfo) throw new Error(`Locale ${currentLocale} is missing from the Graph response.`)
        const stringsResponse = LocaleStringsResponseSchema.parse(
          await requestGraph(
            wiki.config.graphEndpoint,
            `query ($code: String!) {
          localization { strings(code: $code) { key value } }
        }`,
            { code: currentLocale }
          )
        )
        const localeStrings: Record<string, unknown> = {}
        for (const row of stringsResponse.data.localization.strings) {
          if (!row.key || row.key.includes('::')) continue
          _.set(localeStrings, row.key.replace(':', '.'), row.value.length > 0 ? row.value : row.key)
        }
        localeUpdates.push({ localeInfo, strings: localeStrings })
      }
    }

    await wiki.cache.set('locales', locales)
    for (const { localeInfo, strings } of localeUpdates) {
      await wiki.models.locales
        .query()
        .update({
          code: localeInfo.code,
          strings,
          isRTL: localeInfo.isRTL,
          name: localeInfo.name,
          nativeName: localeInfo.nativeName,
          availability: localeInfo.availability
        })
        .where('code', localeInfo.code)
      wiki.logger.info(`Pulled latest locale updates for ${String(localeInfo.name)} from Graph endpoint: [ COMPLETED ]`)
    }
    await wiki.lang.refreshNamespaces()
    wiki.logger.info('Syncing locales with Graph endpoint: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Syncing locales with Graph endpoint: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.message : String(error))
    throw error
  }
}
