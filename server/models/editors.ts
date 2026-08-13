import { Model } from 'objection'
import type { Knex } from 'knex'
import fs from 'fs-extra'
import path from 'node:path'
import _ from 'lodash'
import yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import { readModuleDefinition, readModuleDirectories, type LoadedModuleDefinition, type ModuleConfig } from './moduleTypes.ts'

export default class Editor extends Model {
  declare key: string
  declare isEnabled: boolean
  declare config: ModuleConfig
  static override get tableName () { return 'editors' }
  static override get idColumn () { return 'key' }
  static override get jsonSchema () { return { type: 'object', required: ['key', 'isEnabled'], properties: { key: { type: 'string' }, isEnabled: { type: 'boolean' } } } }
  static override get jsonAttributes () { return ['config'] }
  static async getEditors (): Promise<Editor[]> { return wiki.models.editors.query() }

  static async refreshEditorsFromDisk (): Promise<void> {
    let trx: Knex.Transaction | undefined
    try {
      const dbEditors = await wiki.models.editors.query()
      const dirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/editor'))
      const definitions = []
      for (const dir of dirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/editor', dir, 'definition.yml')
        definitions.push(readModuleDefinition(yaml.load(await fs.readFile(definitionPath, 'utf8')), definitionPath))
      }
      wiki.data.editors = definitions.map(editor => ({ ...editor, props: commonHelper.parseModuleProps(editor.props) }))
      const newEditors: Array<Pick<Editor, 'key' | 'isEnabled' | 'config'>> = []
      for (const editor of wiki.data.editors) {
        if (!_.some(dbEditors, ['key', editor.key])) {
          newEditors.push({ key: editor.key, isEnabled: false, config: _.transform(editor.props, (result: ModuleConfig, value, key) => { _.set(result, key, value.default); return result }, {}) })
        } else {
          const config = _.get(_.find(dbEditors, ['key', editor.key]), 'config', {})
          await wiki.models.editors.query().patch({ config: _.transform(editor.props, (result: ModuleConfig, value, key) => { if (!_.has(result, key)) _.set(result, key, value.default); return result }, config) }).where('key', editor.key)
        }
      }
      if (newEditors.length > 0) {
        trx = await wiki.models.Objection.transaction.start(wiki.models.knex)
        for (const editor of newEditors) await wiki.models.editors.query(trx).insert(editor)
        await trx.commit()
        wiki.logger.info(`Loaded ${newEditors.length} new editors: [ OK ]`)
      } else wiki.logger.info('No new editors found: [ SKIPPED ]')
    } catch (err) {
      wiki.logger.error('Failed to scan or load new editors: [ FAILED ]')
      wiki.logger.error(err)
      if (trx) await trx.rollback()
    }
  }

  static async getDefaultEditor (contentType: string): Promise<string> {
    switch (contentType) {
      case 'markdown': return 'markdown'
      case 'html': return 'ckeditor'
      case 'asciidoc': return 'asciidoc'
      default: return 'code'
    }
  }
}

const wiki = globalThis.WIKI as unknown as { SERVERPATH: string, data: { editors: LoadedModuleDefinition[] }, logger: { info(message: string): void, error(value: unknown): void }, models: { editors: typeof Editor, knex: Knex, Objection: { transaction: { start(knex: Knex): Promise<Knex.Transaction> } } } }
