import { Model } from 'objection'
import type { Knex } from 'knex'
import path from 'node:path'
import fs from 'fs-extra'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import { readModuleDefinition, readModuleDirectories, type LoadedModuleDefinition, type ModuleConfig } from './moduleTypes.ts'

interface LoggingDefinition extends LoadedModuleDefinition { defaultLevel?: string }
interface PageEvent { event: string, page: unknown }

export default class Logger extends Model {
  declare key: string
  declare isEnabled: boolean
  declare level: string
  declare config: ModuleConfig
  static override get tableName () { return 'loggers' }
  static override get idColumn () { return 'key' }
  static override get jsonSchema () { return { type: 'object', required: ['key', 'isEnabled'], properties: { key: { type: 'string' }, isEnabled: { type: 'boolean' }, level: { type: 'string' } } } }
  static override get jsonAttributes () { return ['config'] }
  static async getLoggers (): Promise<Logger[]> { return wiki.models.loggers.query() }

  static async refreshLoggersFromDisk (): Promise<void> {
    let trx: Knex.Transaction | undefined
    try {
      const dbLoggers = await wiki.models.loggers.query()
      const dirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/logging'))
      const definitions = []
      for (const dir of dirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/logging', dir, 'definition.yml')
        definitions.push(readModuleDefinition(yaml.load(await fs.readFile(definitionPath, 'utf8')), definitionPath))
      }
      wiki.data.loggers = definitions.map(logger => ({ ...logger, props: commonHelper.parseModuleProps(logger.props) }))
      const newLoggers: Array<Pick<Logger, 'key' | 'isEnabled' | 'level' | 'config'>> = []
      for (const logger of wiki.data.loggers) {
        if (!_.some(dbLoggers, ['key', logger.key])) {
          newLoggers.push({ key: logger.key, isEnabled: logger.key === 'console', level: logger.defaultLevel ?? 'warn', config: _.transform(logger.props, (result: ModuleConfig, value, key) => { _.set(result, key, value.default); return result }, {}) })
        } else {
          const config = _.get(_.find(dbLoggers, ['key', logger.key]), 'config', {})
          await wiki.models.loggers.query().patch({ config: _.transform(logger.props, (result: ModuleConfig, value, key) => { if (!_.has(result, key)) _.set(result, key, value.default); return result }, config) }).where('key', logger.key)
        }
      }
      if (newLoggers.length > 0) {
        trx = await wiki.models.Objection.transaction.start(wiki.models.knex)
        for (const logger of newLoggers) await wiki.models.loggers.query(trx).insert(logger)
        await trx.commit()
        wiki.logger.info(`Loaded ${newLoggers.length} new loggers: [ OK ]`)
      } else wiki.logger.info('No new loggers found: [ SKIPPED ]')
    } catch (err) {
      wiki.logger.error('Failed to scan or load new loggers: [ FAILED ]')
      wiki.logger.error(err)
      if (trx) await trx.rollback()
    }
  }

  static async pageEvent ({ event, page }: PageEvent): Promise<void> {
    const loggers = await wiki.models.storage.query().where('isEnabled', true)
    for (const logger of loggers) {
      wiki.queue.job.syncStorage.add({ event, logger, page }, { removeOnComplete: true })
    }
  }
}

const wiki = globalThis.WIKI as unknown as { SERVERPATH: string, data: { loggers: LoggingDefinition[] }, logger: { info(message: string): void, error(value: unknown): void }, queue: { job: { syncStorage: { add(data: { event: string, logger: StorageTarget, page: unknown }, options: { removeOnComplete: boolean }): unknown } } }, models: { loggers: typeof Logger, storage: { query(): { where(column: string, value: boolean): Promise<StorageTarget[]> } }, knex: Knex, Objection: { transaction: { start(knex: Knex): Promise<Knex.Transaction> } } } }
interface StorageTarget extends Record<string, unknown> { key: string }
