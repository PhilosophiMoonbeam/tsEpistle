import { Model } from 'objection'
import type { Knex } from 'knex'
import _ from 'lodash'
import Page from './pages.ts'

/* global WIKI */

/**
 * Tags model
 */
export default class Tag extends Model {
  declare id: number
  declare tag: string
  declare title: string
  declare createdAt: string
  declare updatedAt: string
  static override get tableName() {
    return 'tags'
  }
  static override get jsonSchema() {
    return {
      type: 'object',
      required: ['tag'],

      properties: {
        id: { type: 'integer' },
        tag: { type: 'string' },
        title: { type: 'string' },

        createdAt: { type: 'string' },
        updatedAt: { type: 'string' }
      }
    }
  }
  static override get relationMappings() {
    return {
      pages: {
        relation: Model.ManyToManyRelation,
        modelClass: Page,
        join: {
          from: 'tags.id',
          through: {
            from: 'pageTags.tagId',
            to: 'pageTags.pageId'
          },
          to: 'pages.id'
        }
      }
    }
  }
  override $beforeUpdate() {
    this.updatedAt = new Date().toISOString()
  }
  override $beforeInsert() {
    this.createdAt = new Date().toISOString()
    this.updatedAt = new Date().toISOString()
  }
  static async associateTags({ tags, page, transaction }: { tags: string[]; page: Page; transaction?: Knex.Transaction }) {
    // Format tags

    tags = _.uniq(tags.map(t => _.trim(t).toLowerCase()))
    const existingTags = await wiki.models.tags.query(transaction).column('id', 'tag').whereIn('tag', tags)

    // Create missing tags

    const newTags = _.filter(tags, t => !_.some(existingTags, ['tag', t])).map(t => ({
      tag: t,
      title: t
    }))
    if (newTags.length > 0) {
      await wiki.models.tags.query(transaction).insert(newTags).onConflict('tag').ignore()
    }

    // Fetch current page tags

    const targetTags = await wiki.models.tags.query(transaction).column('id', 'tag').whereIn('tag', tags)
    const currentTags = await page.$relatedQuery('tags', transaction)

    // Tags to relate

    const tagsToRelate = _.differenceBy(targetTags, currentTags, 'id')
    if (tagsToRelate.length > 0) {
      await page.$relatedQuery('tags', transaction).relate(tagsToRelate)
    }

    // Tags to unrelate

    const tagsToUnrelate = _.differenceBy(currentTags, targetTags, 'id')
    const changed = tagsToRelate.length > 0 || tagsToUnrelate.length > 0
    if (tagsToUnrelate.length > 0) {
      await page.$relatedQuery('tags', transaction).unrelate().whereIn('tags.id', _.map(tagsToUnrelate, 'id'))
    }

    page.tags = targetTags
    return changed
  }
}

const wiki = WIKI as unknown as {
  models: { tags: typeof Tag }
}
