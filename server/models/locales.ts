import { Model } from 'objection'

/* global WIKI */

/**
 * Locales model
 */
export default class Locale extends Model { declare code: string
declare isRTL: boolean
declare name: string
declare nativeName: string
declare createdAt: string
declare updatedAt: string
declare availability: number
declare strings: Record<string, string>
static override get tableName() { return 'locales' } static override get idColumn() { return 'code' } static override get jsonSchema() { return {
  type: 'object',
  required: ['code', 'name'],

  properties: {
    code: {type: 'string'},
    isRTL: {type: 'boolean', default: false},
    name: {type: 'string'},
    nativeName: {type: 'string'},
    createdAt: {type: 'string'},
    updatedAt: {type: 'string'},
    availability: {type: 'integer'}
  }
} } static override get jsonAttributes() { return ['strings'] } override $beforeUpdate() { this.updatedAt = new Date().toISOString() } override $beforeInsert() { this.createdAt = new Date().toISOString()
this.updatedAt = new Date().toISOString() } static async getNavLocales({ cache = false }: { cache?: boolean } = {}): Promise<Array<{ code: string, name: string }>> {
  if (!wiki.config.lang.namespacing) {
    return []
  }

  if (cache) {
    const navLocalesCached = await wiki.cache.get('nav:locales')
    if (navLocalesCached) {
      return navLocalesCached
    }
  }
  const navLocales = await wiki.models.locales.query().select('code', 'nativeName AS name').whereIn('code', wiki.config.lang.namespaces).orderBy('code')
  if (navLocales) {
    if (cache) {
      await wiki.cache.set('nav:locales', navLocales, 300)
    }
    return navLocales
  } else {
    wiki.logger.warn('Site Locales for navigation are missing or corrupted.')
    return []
  }
} }

const wiki = WIKI as unknown as {
  config: { lang: { namespacing: boolean, namespaces: string[] } }
  cache: {
    get: (key: string) => Promise<Array<{ code: string, name: string }> | null>
    set: (key: string, value: Locale[], ttl: number) => Promise<void>
  }
  logger: { warn: (message: string) => void }
  models: { locales: typeof Locale }
}
