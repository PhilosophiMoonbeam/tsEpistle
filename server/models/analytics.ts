import { Model } from 'objection'
import type { Knex } from 'knex'
import fs from 'fs-extra'
import path from 'node:path'
import _ from 'lodash'
import yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import {
  readModuleDirectories,
  readModuleDefinition,
  readString,
  readYamlRecord,
  type LoadedModuleDefinition,
  type ModuleConfig
} from './moduleTypes.ts'

export default class Analytics extends Model {
  declare key: string
  declare isEnabled: boolean
  declare config: ModuleConfig

  static override get tableName () { return 'analytics' }
  static override get idColumn () { return 'key' }
  static override get jsonSchema () {
    return {
      type: 'object',
      required: ['key', 'isEnabled'],
      properties: {
        key: { type: 'string' },
        isEnabled: { type: 'boolean' }
      }
    }
  }
  static override get jsonAttributes () { return ['config'] }

  static async getProviders (isEnabled?: boolean): Promise<Analytics[]> {
    const providers = await wiki.models.analytics.query().where(_.isBoolean(isEnabled) ? { isEnabled } : {})
    return _.sortBy(providers, ['key'])
  }

  static async refreshProvidersFromDisk (): Promise<void> {
    let trx: Knex.Transaction | undefined
    try {
      const dbProviders = await wiki.models.analytics.query()
      const analyticsDirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/analytics'))
      const diskProviders = []
      for (const dir of analyticsDirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/analytics', dir, 'definition.yml')
        const raw = await fs.readFile(definitionPath, 'utf8')
        diskProviders.push(readModuleDefinition(yaml.load(raw), definitionPath))
      }
      wiki.data.analytics = diskProviders.map(provider => ({
        ...provider,
        props: commonHelper.parseModuleProps(provider.props)
      }))

      const newProviders: Array<Pick<Analytics, 'key' | 'isEnabled' | 'config'>> = []
      for (const provider of wiki.data.analytics) {
        if (!_.some(dbProviders, ['key', provider.key])) {
          newProviders.push({
            key: provider.key,
            isEnabled: false,
            config: _.transform(provider.props, (result: ModuleConfig, value, key) => {
              _.set(result, key, value.default)
              return result
            }, {})
          })
        } else {
          const providerConfig = _.get(_.find(dbProviders, ['key', provider.key]), 'config', {})
          await wiki.models.analytics.query().patch({
            config: _.transform(provider.props, (result: ModuleConfig, value, key) => {
              if (!_.has(result, key)) _.set(result, key, value.default)
              return result
            }, providerConfig)
          }).where('key', provider.key)
        }
      }
      if (newProviders.length > 0) {
        trx = await wiki.models.Objection.transaction.start(wiki.models.knex)
        for (const provider of newProviders) await wiki.models.analytics.query(trx).insert(provider)
        await trx.commit()
        wiki.logger.info(`Loaded ${newProviders.length} new analytics providers: [ OK ]`)
      } else {
        wiki.logger.info('No new analytics providers found: [ SKIPPED ]')
      }
    } catch (err) {
      wiki.logger.error('Failed to scan or load new analytics providers: [ FAILED ]')
      wiki.logger.error(err)
      if (trx) await trx.rollback()
    }
  }

  static async getCode ({ cache = false }: { cache?: boolean } = {}): Promise<AnalyticsCode> {
    if (cache) {
      const analyticsCached = await wiki.cache.get('analytics')
      if (isAnalyticsCode(analyticsCached)) return analyticsCached
    }
    try {
      const analyticsCode: AnalyticsCode = { head: '', bodyStart: '', bodyEnd: '' }
      const providers = await wiki.models.analytics.getProviders(true)
      for (const provider of providers) {
        const codePath = path.join(wiki.SERVERPATH, 'modules/analytics', provider.key, 'code.yml')
        const raw = await fs.readFile(codePath, 'utf8')
        const codeRecord = readYamlRecord(yaml.load(raw), codePath)
        const code: AnalyticsCode = {
          head: readString(codeRecord, 'head'),
          bodyStart: readString(codeRecord, 'bodyStart'),
          bodyEnd: readString(codeRecord, 'bodyEnd')
        }
        _.forOwn(provider.config, (value, key) => {
          const replacement = String(value)
          code.head = _.replace(code.head, new RegExp(`{{${key}}}`, 'g'), replacement)
          code.bodyStart = _.replace(code.bodyStart, `{{${key}}}`, replacement)
          code.bodyEnd = _.replace(code.bodyEnd, `{{${key}}}`, replacement)
        })
        analyticsCode.head += code.head
        analyticsCode.bodyStart += code.bodyStart
        analyticsCode.bodyEnd += code.bodyEnd
      }
      await wiki.cache.set('analytics', analyticsCode, 300)
      return analyticsCode
    } catch (err) {
      wiki.logger.warn('Error while getting analytics code: ', err)
      return { head: '', bodyStart: '', bodyEnd: '' }
    }
  }
}

interface AnalyticsCode { head: string, bodyStart: string, bodyEnd: string }

function isAnalyticsCode (value: unknown): value is AnalyticsCode {
  return typeof value === 'object' && value !== null &&
    typeof Reflect.get(value, 'head') === 'string' &&
    typeof Reflect.get(value, 'bodyStart') === 'string' &&
    typeof Reflect.get(value, 'bodyEnd') === 'string'
}

const wiki = globalThis.WIKI as unknown as {
  SERVERPATH: string
  cache: { get(key: string): Promise<unknown>, set(key: string, value: AnalyticsCode, ttl: number): Promise<unknown> }
  data: { analytics: LoadedModuleDefinition[] }
  logger: { info(message: string): void, error(value: unknown): void, warn(message: string, err: unknown): void }
  models: {
    analytics: typeof Analytics
    knex: Knex
    Objection: { transaction: { start(knex: Knex): Promise<Knex.Transaction> } }
  }
}
