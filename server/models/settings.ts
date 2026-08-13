import { Model } from 'objection'
import _ from 'lodash'

/* global WIKI */

/**
 * Settings model
 */
export default class Setting extends Model { declare key: string
declare value: unknown
declare createdAt: string
declare updatedAt: string
static override get tableName() { return 'settings' } static override get idColumn() { return 'key' } static override get jsonSchema() { return {
  type: 'object',
  required: ['key'],

  properties: {
    key: {type: 'string'},
    createdAt: {type: 'string'},
    updatedAt: {type: 'string'}
  }
} } static override get jsonAttributes() { return ['value'] } override $beforeUpdate() { this.updatedAt = new Date().toISOString() } override $beforeInsert() { this.updatedAt = new Date().toISOString() } static async getConfig(): Promise<Record<string, unknown> | false> {
  const settings = await wiki.models.settings.query()
  if (settings.length > 0) {
    return _.reduce(settings, (result: Record<string, unknown>, setting) => {
      const value = setting.value
      _.set(result, setting.key, value && typeof value === 'object' && 'v' in value ? value.v : value)
      return result
    }, {})
  } else {
    return false
  }
} }

const wiki = WIKI as unknown as {
  models: { settings: typeof Setting }
}
