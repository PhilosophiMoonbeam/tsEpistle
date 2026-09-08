import fs from 'node:fs'
import path from 'node:path'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import _ from 'lodash'
import type { ProductMetadata } from '../../shared/product.ts'
import regex from '../app/regex.ts'
import cfgHelper from '../helpers/config.ts'
import { loadProductMetadata } from './product.ts'

interface AppConfig {
  [key: string]: unknown
  db: { pass: string | number }
  flags: { ldapdebug: boolean; sqllog: boolean }
  security?: { securityTrustProxy?: boolean }
  port: number | string
  setup?: boolean
  title?: string
  logoUrl?: string
}

interface AppData {
  [key: string]: unknown
  defaults: { config: AppConfig }
  regex: unknown
}

interface SettingsQuery {
  patch(value: { value: unknown }): SettingsQuery
  where(column: string, value: string): Promise<number>
  insert(value: { key: string; value: unknown }): Promise<unknown>
}

interface WikiApplication {
  set(setting: 'trust proxy', value: 1 | false): void
}

interface WikiContext {
  lang?: { refreshNamespaces(): Promise<void> }
  app?: WikiApplication
  auth?: { jwtAudience: string | null; strategyHost?: string | null; activateStrategies(): Promise<void> }
  ROOTPATH: string
  SERVERPATH: string
  config: AppConfig
  configSvc: ConfigService
  data: AppData
  devMode: boolean
  events: {
    inbound: { on(event: string, listener: () => Promise<void>): void }
    outbound: { emit(event: string): void }
  }
  logger: { error(message: string): void; warn(message: string): void }
  models: {
    knex: { client: { config: { debug: boolean } } }
    settings: {
      getConfig(): Promise<AppConfig | null>
      query(): SettingsQuery
    }
  }
  product: ProductMetadata
  releaseDate: string
  version: string
}

interface ConfigService {
  init(): void
  loadFromDb(): Promise<void>
  saveToDb(keys: string[], propagate?: boolean): Promise<boolean>
  applyFlags(): Promise<void>
  subscribeToEvents(): void
}

const getWiki = (): WikiContext => WIKI as unknown as WikiContext

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const INSTALLATION_CONFIGURATION_KEYS = ['auth', 'certs', 'sessionSecret', 'title'] as const

function hasSigningConfiguration(config: Record<string, unknown>): boolean {
  if (typeof config.sessionSecret !== 'string' || config.sessionSecret.length === 0 || !isRecord(config.certs)) return false
  return (
    typeof config.certs.public === 'string' && config.certs.public.length > 0 && typeof config.certs.private === 'string' && config.certs.private.length > 0
  )
}

function isAppConfig(value: unknown): value is AppConfig {
  if (!isRecord(value) || !isRecord(value.db) || !isRecord(value.flags)) return false
  return (
    (typeof value.db.pass === 'string' || typeof value.db.pass === 'number') &&
    typeof value.flags.ldapdebug === 'boolean' &&
    typeof value.flags.sqllog === 'boolean' &&
    (typeof value.port === 'string' || typeof value.port === 'number')
  )
}

function isAppData(value: unknown): value is AppData {
  return isRecord(value) && isRecord(value.defaults) && isAppConfig(value.defaults.config)
}
const LEGACY_PRODUCT_TITLES = new Set(['Wiki.js', 'Wiki.ts Preview', 'tsFranki'])
const LEGACY_PRODUCT_LOGOS = new Set(['https://static.requarks.io/logo/wikijs-butterfly.svg', '/_assets/svg/logo-wikijs.svg', '/_assets/svg/icon-tsfranki.svg'])
const DEFAULT_PRODUCT_LOGO = '/_assets/svg/icon-tsepistle.svg'

export function normalizeLegacyProductDefaults(config: Record<string, unknown>, productName: string): string[] {
  const changed: string[] = []
  if (typeof config.title === 'string' && LEGACY_PRODUCT_TITLES.has(config.title)) {
    config.title = productName
    changed.push('title')
  }
  if (typeof config.logoUrl === 'string' && LEGACY_PRODUCT_LOGOS.has(config.logoUrl)) {
    config.logoUrl = DEFAULT_PRODUCT_LOGO
    changed.push('logoUrl')
  }
  return changed
}

// Persisted arrays are complete values: defaults must not resurrect removed entries.
const mergeSavedConfiguration = (saved: unknown, fallback: unknown): unknown => {
  if (saved === undefined) return _.cloneDeep(fallback)
  if (!_.isPlainObject(saved)) return _.cloneDeep(saved)
  const source = saved as Record<string, unknown>
  const defaults = _.isPlainObject(fallback) ? (fallback as Record<string, unknown>) : {}
  return Object.fromEntries(
    [...new Set([...Object.keys(defaults), ...Object.keys(source)])]
      .filter(key => !['__proto__', 'constructor', 'prototype'].includes(key))
      .map(key => [key, mergeSavedConfiguration(source[key], defaults[key])])
  )
}

const configService: ConfigService = {
  init() {
    const wiki = getWiki()
    const confPaths = {
      config: path.join(wiki.ROOTPATH, 'config.yml'),
      data: path.join(wiki.SERVERPATH, 'app/data.yml')
    }

    if (process.env.dockerdev) {
      confPaths.config = path.join(wiki.ROOTPATH, 'dev/containers/config.yml')
    }
    if (process.env.CONFIG_FILE) {
      confPaths.config = path.resolve(wiki.ROOTPATH, process.env.CONFIG_FILE)
    }

    process.stdout.write(chalk.blue(`Loading configuration from ${confPaths.config}... `))

    let appconfig: AppConfig
    let appdata: AppData
    try {
      const loadedConfig = yaml.load(cfgHelper.parseConfigValue(fs.readFileSync(confPaths.config, 'utf8')))
      const loadedData = yaml.load(fs.readFileSync(confPaths.data, 'utf8'))
      if (!isRecord(loadedConfig)) throw new Error('Configuration file must contain a mapping')
      if (!isAppData(loadedData)) throw new Error('Application data contains invalid configuration defaults')
      const mergedConfig = _.defaultsDeep(loadedConfig, loadedData.defaults.config)
      if (!isAppConfig(mergedConfig)) throw new Error('Configuration file contains invalid values')
      appconfig = mergedConfig
      appdata = loadedData
      appdata.regex = regex
      console.info(chalk.green.bold('OK'))
    } catch (error) {
      console.error(chalk.red.bold('FAILED'))
      console.error(errorMessage(error))
      console.error(chalk.red.bold('>>> Unable to read configuration file! Did you create the config.yml file?'))
      process.exit(1)
    }

    if (Number(appconfig.port) < 1 || process.env.HEROKU) {
      appconfig.port = process.env.PORT || 80
    }

    if (process.env.DB_PASS_FILE) {
      console.info(chalk.blue('DB_PASS_FILE is defined. Will use secret from file.'))
      try {
        appconfig.db.pass = fs.readFileSync(process.env.DB_PASS_FILE, 'utf8').trim()
      } catch (error) {
        console.error(chalk.red.bold('>>> Failed to read Docker Secret File using path defined in DB_PASS_FILE env variable!'))
        console.error(errorMessage(error))
        process.exit(1)
      }
    }

    wiki.config = appconfig
    wiki.data = appdata
    wiki.product = loadProductMetadata(wiki.ROOTPATH)
    wiki.version = wiki.product.version
    wiki.releaseDate = wiki.product.date
    wiki.devMode = false
  },

  async loadFromDb() {
    const wiki = getWiki()
    const conf = await wiki.models.settings.getConfig()
    if (conf && INSTALLATION_CONFIGURATION_KEYS.some(key => Object.hasOwn(conf, key))) {
      if (!hasSigningConfiguration(conf)) {
        throw new Error('Database configuration is incomplete: authentication signing material is missing.')
      }
      const canonicalConfig = wiki.config
      const reloadedConfig = mergeSavedConfiguration(conf, canonicalConfig) as AppConfig
      // An omitted publication-window field means no schedule, not the previous notice’s window.
      if (Object.hasOwn(conf, 'banner')) reloadedConfig.banner = _.cloneDeep(conf.banner)
      Object.assign(canonicalConfig, reloadedConfig)
      const migratedKeys = normalizeLegacyProductDefaults(canonicalConfig, wiki.product.name)
      if (migratedKeys.length > 0) await this.saveToDb(migratedKeys, false)
    } else {
      wiki.logger.warn('DB Configuration is empty or incomplete. Switching to Setup mode...')
      wiki.config.setup = true
    }
  },

  async saveToDb(keys: string[], propagate = true) {
    const wiki = getWiki()
    try {
      for (const key of keys) {
        let value = _.get(wiki.config, key, null)
        if (!_.isPlainObject(value)) value = { v: value }
        const affectedRows = await wiki.models.settings.query().patch({ value }).where('key', key)
        if (affectedRows === 0 && value) {
          await wiki.models.settings.query().insert({ key, value })
        }
      }
      if (propagate) wiki.events.outbound.emit('reloadConfig')
    } catch (error) {
      wiki.logger.error(`Failed to save configuration to DB: ${errorMessage(error)}`)
      return false
    }
    return true
  },

  async applyFlags() {
    const wiki = getWiki()
    wiki.models.knex.client.config.debug = wiki.config.flags.sqllog
  },

  subscribeToEvents() {
    const wiki = getWiki()
    let reloadQueue = Promise.resolve()
    wiki.events.inbound.on('reloadConfig', () => {
      const reload = reloadQueue.then(async () => {
        const previousLanguage = JSON.stringify(wiki.config.lang)
        await wiki.configSvc.loadFromDb()
        if (wiki.lang && previousLanguage !== JSON.stringify(wiki.config.lang)) await wiki.lang.refreshNamespaces()
        await wiki.configSvc.applyFlags()
        wiki.app?.set('trust proxy', wiki.config.security?.securityTrustProxy === true ? 1 : false)
        const audience = isRecord(wiki.config.auth) ? wiki.config.auth.audience : undefined
        if (wiki.auth && typeof audience === 'string' && (wiki.auth.jwtAudience !== audience || wiki.auth.strategyHost !== wiki.config.host))
          await wiki.auth.activateStrategies()
      })
      reloadQueue = reload.catch(() => undefined)
      return reload
    })
  }
}

export default configService
