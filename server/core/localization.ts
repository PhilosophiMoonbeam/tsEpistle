import _ from 'lodash'
import dotize from 'dotize'
import * as i18nMiddleware from 'i18next-http-middleware'
import i18next from 'i18next'
import fs from 'fs-extra'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Express } from 'express'

interface LocaleRow { strings?: unknown }
type WikiSource = typeof WIKI
type WikiContext = WikiSource & {
  IS_DEBUG: boolean
  SERVERPATH: string
  config: { lang: { code: string; namespaces: string[]; namespacing: boolean } }
  data: { localeNamespaces: string[] }
  logger: { info(message: string): void }
  models: { locales: { query(): { findOne(column: string, value: string): Promise<LocaleRow | null> } } }
}
const wiki = WIKI as WikiContext

const localization = {
  engine: i18next,
  namespaces: [] as string[],
  init() {
    this.namespaces = wiki.data.localeNamespaces
    void this.engine.init({ load: 'languageOnly', ns: this.namespaces, defaultNS: 'common', saveMissing: false, lng: wiki.config.lang.code, fallbackLng: 'en' })
    void this.refreshNamespaces(true)
    return this
  },
  attachMiddleware(app: Express) {
    const middleware = i18nMiddleware.handle(this.engine)
    app.use((req, res, next) => Reflect.apply(middleware, undefined, [req, res, next]))
  },
  async getByNamespace(locale: string, namespace: string) {
    if (!this.engine.hasResourceBundle(locale, namespace)) throw new Error('Invalid locale or namespace')
    const data = this.engine.getResourceBundle(locale, namespace) as Record<string, unknown>
    return _.map(dotize.convert(data), (value, key) => ({ key, value }))
  },
  async loadLocale(locale: string, opts = { silent: false }) {
    const res = await wiki.models.locales.query().findOne('code', locale)
    if (res) {
      if (_.isPlainObject(res.strings)) {
        _.forOwn(res.strings as Record<string, unknown>, (data, ns) => {
          this.namespaces.push(ns)
          this.engine.addResourceBundle(locale, ns, data, true, true)
        })
      }
    } else if (!opts.silent) {
      throw new Error('No such locale in local store.')
    }
    if (wiki.IS_DEBUG) {
      try {
        const raw = await fs.readFile(path.join(wiki.SERVERPATH, `locales/${locale}.yml`), 'utf8')
        const entries = yaml.load(raw)
        if (_.isPlainObject(entries)) {
          _.forOwn(entries as Record<string, unknown>, (data, ns) => {
            this.namespaces.push(ns)
            this.engine.addResourceBundle(locale, ns, data, true, true)
          })
          wiki.logger.info(`Loaded dev locales from ${locale}.yml`)
        }
      } catch (error) {
        void error
      }
    }
  },
  async refreshNamespaces(silent = false) {
    await this.loadLocale(wiki.config.lang.code, { silent })
    if (wiki.config.lang.namespacing) {
      for (const ns of wiki.config.lang.namespaces) await this.loadLocale(ns, { silent })
    }
  },
  async setCurrentLocale(locale: string) {
    await this.engine.changeLanguage(locale)
  }
}

export default localization
