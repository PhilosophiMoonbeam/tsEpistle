import _ from 'lodash'
import chalk from 'chalk'
import cfgHelper from '../helpers/config.ts'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import regex from '../app/regex.ts'
import packageJson from '../../package.json' with { type: 'json' }

interface AppConfig {
  [key: string]: unknown
  db: { pass: string | number }
  flags: { sqllog: boolean }
  port: number | string
  setup?: boolean
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

interface WikiContext {
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
const packageInfo = packageJson as { dev?: boolean; releaseDate: string; version: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAppConfig(value: unknown): value is AppConfig {
  if (!isRecord(value) || !isRecord(value.db) || !isRecord(value.flags)) return false
  return (typeof value.db.pass === 'string' || typeof value.db.pass === 'number') &&
    typeof value.flags.sqllog === 'boolean' &&
    (typeof value.port === 'string' || typeof value.port === 'number')
}

function isAppData(value: unknown): value is AppData {
  return isRecord(value) &&
    isRecord(value.defaults) &&
    isAppConfig(value.defaults.config)
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
      const loadedConfig = yaml.load(
        cfgHelper.parseConfigValue(fs.readFileSync(confPaths.config, 'utf8'))
      )
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
    wiki.version = packageInfo.version
    wiki.releaseDate = packageInfo.releaseDate
    wiki.devMode = packageInfo.dev === true
  },

  async loadFromDb() {
    const wiki = getWiki()
    const conf = await wiki.models.settings.getConfig()
    if (conf) {
      wiki.config = _.defaultsDeep(conf, wiki.config)
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
    wiki.events.inbound.on('reloadConfig', async () => {
      await wiki.configSvc.loadFromDb()
      await wiki.configSvc.applyFlags()
    })
  }
}

export default configService
