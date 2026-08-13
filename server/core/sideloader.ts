import fs from 'fs-extra'
import path from 'node:path'
import _ from 'lodash'

interface Locale { code: string; name: string; nativeName: string; isRTL: boolean; availability?: number }
interface Query { select(column: string): Query; where(column: string, value: string): Query; first(): Promise<unknown>; update(value: Record<string, unknown>): Query; insert(value: Record<string, unknown>): Promise<unknown> }
interface WikiContext { ROOTPATH: string; config: { offline: boolean; dataPath: string }; logger: { info(message: string): void; warn(message: unknown): void }; models: { locales: { query(): Query } } }
const wiki = WIKI as unknown as WikiContext

function isLocale(value: unknown): value is Locale {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const availability: unknown = Reflect.get(value, 'availability')
  return typeof Reflect.get(value, 'code') === 'string' &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'nativeName') === 'string' &&
    typeof Reflect.get(value, 'isRTL') === 'boolean' &&
    (availability === undefined || typeof availability === 'number')
}

const sideloader = {
  async init() {
    if (!wiki.config.offline) return
    const root = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'sideload')
    if (!await fs.pathExists(root)) return
    wiki.logger.info('Sideload directory detected. Looking for packages...')
    try { await this.importLocales() } catch (error) { wiki.logger.warn(error) }
  },
  async importLocales() {
    const root = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'sideload')
    if (!await fs.pathExists(path.join(root, 'locales.json'))) return
    wiki.logger.info('Found locales master file. Importing locale packages...')
    let importedLocales = 0
    const payload: unknown = await fs.readJson(path.join(root, 'locales.json'))
    if (typeof payload !== 'object' || payload === null) return
    const data: unknown = Reflect.get(payload, 'data')
    if (typeof data !== 'object' || data === null) return
    const localization: unknown = Reflect.get(data, 'localization')
    if (typeof localization !== 'object' || localization === null) return
    const localeEntries: unknown = Reflect.get(localization, 'locales')
    if (!Array.isArray(localeEntries)) return
    const locales: unknown[] = localeEntries
    for (const locale of locales) {
      if (!isLocale(locale)) continue
      try {
        const localeData: unknown = await fs.readJson(path.join(root, `${locale.code}.json`))
        if (typeof localeData !== 'object' || localeData === null || Array.isArray(localeData)) continue
        const strings: Record<string, unknown> = {}
        _.forOwn(localeData, (value, key) => {
          if (_.includes(key, '::')) return
          _.set(strings, key.replace(':', '.'), _.isEmpty(value) ? key : value)
        })
        const values = { code: locale.code, strings, isRTL: locale.isRTL, name: locale.name, nativeName: locale.nativeName, availability: locale.availability || 0 }
        const query = wiki.models.locales.query()
        if (await query.select('code').where('code', locale.code).first()) await wiki.models.locales.query().update(values).where('code', locale.code)
        else await wiki.models.locales.query().insert(values)
        importedLocales++
      } catch (error) {
        void error
      }
    }
    wiki.logger.info(`Imported ${importedLocales} locale packages: [COMPLETED]`)
  }
}

export default sideloader
