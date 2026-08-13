import { Model } from 'objection'
import type { Knex } from 'knex'
import fs from 'fs-extra'
import path from 'node:path'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import { readModuleDefinition, readModuleDirectories, readString, readYamlRecord, type LoadedModuleDefinition, type ModuleConfig } from './moduleTypes.ts'

interface CommentProviderDefinition extends LoadedModuleDefinition { title?: string, description?: string, logo?: string, website?: string, isAvailable?: boolean, codeTemplate?: boolean }
interface CommentRuntime extends Record<string, unknown> { config: ModuleConfig, head: string, bodyStart: string, bodyEnd: string, body?: string, main: string, init?: () => Promise<void> }
interface CommentModule extends Record<string, unknown> { init(): Promise<void> }

export default class CommentProvider extends Model {
  declare key: string
  declare isEnabled: boolean
  declare config: ModuleConfig
  static override get tableName () { return 'commentProviders' }
  static override get idColumn () { return 'key' }
  static override get jsonSchema () { return { type: 'object', required: ['key', 'isEnabled'], properties: { key: { type: 'string' }, isEnabled: { type: 'boolean' } } } }
  static override get jsonAttributes () { return ['config'] }
  static async getProvider (key: string): Promise<CommentProvider | undefined> { return wiki.models.commentProviders.query().findOne({ key }) }
  static async getProviders (isEnabled?: boolean): Promise<CommentProvider[]> { return _.sortBy(await wiki.models.commentProviders.query().where(_.isBoolean(isEnabled) ? { isEnabled } : {}), ['key']) }

  static async refreshProvidersFromDisk (): Promise<void> {
    let trx: Knex.Transaction | undefined
    try {
      const dbProviders = await wiki.models.commentProviders.query()
      const dirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/comments'))
      const definitions = []
      for (const dir of dirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/comments', dir, 'definition.yml')
        definitions.push(readModuleDefinition(yaml.load(await fs.readFile(definitionPath, 'utf8')), definitionPath))
      }
      wiki.data.commentProviders = definitions.map(provider => ({ ...provider, props: commonHelper.parseModuleProps(provider.props) }))
      const newProviders: Array<Pick<CommentProvider, 'key' | 'isEnabled' | 'config'>> = []
      for (const provider of wiki.data.commentProviders) {
        if (!_.some(dbProviders, ['key', provider.key])) {
          newProviders.push({ key: provider.key, isEnabled: provider.key === 'default', config: _.transform(provider.props, (result: ModuleConfig, value, key) => { _.set(result, key, value.default); return result }, {}) })
        } else {
          const config = _.get(_.find(dbProviders, ['key', provider.key]), 'config', {})
          await wiki.models.commentProviders.query().patch({ config: _.transform(provider.props, (result: ModuleConfig, value, key) => { if (!_.has(result, key)) _.set(result, key, value.default); return result }, config) }).where('key', provider.key)
        }
      }
      if (newProviders.length > 0) {
        trx = await wiki.models.Objection.transaction.start(wiki.models.knex)
        for (const provider of newProviders) await wiki.models.commentProviders.query(trx).insert(provider)
        await trx.commit()
        wiki.logger.info(`Loaded ${newProviders.length} new comment providers: [ OK ]`)
      } else wiki.logger.info('No new comment providers found: [ SKIPPED ]')
    } catch (err) {
      wiki.logger.error('Failed to scan or load new comment providers: [ FAILED ]')
      wiki.logger.error(err)
      if (trx) await trx.rollback()
    }
  }

  static async initProvider (): Promise<void> {
    const provider = await wiki.models.commentProviders.query().findOne('isEnabled', true)
    if (!provider) return
    const definition = _.find(wiki.data.commentProviders, ['key', provider.key])
    const base = { ...(definition ?? {}), config: provider.config, head: '', bodyStart: '', bodyEnd: '', main: '<comments></comments>' }
    if (definition?.codeTemplate) {
      const codePath = path.join(wiki.SERVERPATH, 'modules/comments', provider.key, 'code.yml')
      const record = readYamlRecord(yaml.load(await fs.readFile(codePath, 'utf8')), codePath)
      const code = { head: readString(record, 'head'), body: readString(record, 'body'), main: readString(record, 'main') }
      _.forOwn(provider.config, (value, key) => {
        const replacement = String(value)
        code.head = _.replace(code.head, new RegExp(`{{${key}}}`, 'g'), replacement)
        code.body = _.replace(code.body, new RegExp(`{{${key}}}`, 'g'), replacement)
        code.main = _.replace(code.main, new RegExp(`{{${key}}}`, 'g'), replacement)
      })
      wiki.data.commentProvider = { ...base, ...code }
    } else {
      const imported = await import(`../modules/comments/${provider.key}/comment.ts`) as unknown as { default: CommentModule }
      wiki.data.commentProvider = { ...base, ...imported.default, config: provider.config }
      await imported.default.init()
    }
    wiki.data.commentProvider.config = provider.config
  }
}

const wiki = globalThis.WIKI as unknown as { SERVERPATH: string, data: { commentProviders: CommentProviderDefinition[], commentProvider: CommentRuntime }, logger: { info(message: string): void, error(value: unknown): void }, models: { commentProviders: typeof CommentProvider, knex: Knex, Objection: { transaction: { start(knex: Knex): Promise<Knex.Transaction> } } } }
