import { Model } from 'objection'
import Page from './pages.ts'

/**
 * Users model
 */
export default class PageLink extends Model { declare id: number
declare path: string
declare localeCode: string
declare pageId: number
static override get tableName() { return 'pageLinks' } static override get jsonSchema() { return {
  type: 'object',
  required: ['path', 'localeCode'],

  properties: {
    id: {type: 'integer'},
    path: {type: 'string'},
    localeCode: {type: 'string'}
  }
} } static override get relationMappings() { return {
  page: {
    relation: Model.BelongsToOneRelation,
    modelClass: Page,
    join: {
      from: 'pageLinks.pageId',
      to: 'pages.id'
    }
  }
} }  }
