import { Model } from 'objection'
import type { Knex } from 'knex'
import _ from 'lodash'

interface AssetFolderRow {
  id: number
  name: string
  slug: string
  parentId: number | null
}

export default class AssetFolder extends Model {
  declare id: number
  declare name: string
  declare slug: string
  declare parentId: number | null

  static override get tableName () { return 'assetFolders' }

  static override get jsonSchema () {
    return {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        slug: { type: 'string' }
      }
    }
  }

  static override get relationMappings () {
    return {
      parent: {
        relation: Model.BelongsToOneRelation,
        modelClass: AssetFolder,
        join: {
          from: 'assetFolders.folderId',
          to: 'assetFolders.id'
        }
      }
    }
  }

  static async getHierarchy (folderId: number): Promise<AssetFolderRow[]> {
    const hierarchy = await wiki.models.knex.withRecursive('ancestors', (qb: Knex.QueryBuilder) => {
      qb.select('id', 'name', 'slug', 'parentId').from('assetFolders').where('id', folderId).union((sqb: Knex.QueryBuilder) => {
        sqb.select('a.id', 'a.name', 'a.slug', 'a.parentId').from('assetFolders AS a').join('ancestors', 'ancestors.parentId', 'a.id')
      })
    }).select('*').from('ancestors')
    return _.reverse(hierarchy)
  }

  static async getAllPaths (): Promise<Record<number, string>> {
    const all = await wiki.models.assetFolders.query()
    const folders: Record<number, string> = {}
    all.forEach(folder => {
      folders[folder.id] = folder.slug
      let parentId = folder.parentId
      while (parentId !== null) {
        const parent = _.find(all, ['id', parentId])
        if (!parent) {
          throw new Error(`Asset folder ${parentId} does not exist.`)
        }
        folders[folder.id] = `${parent.slug}/${folders[folder.id]}`
        parentId = parent.parentId
      }
    })
    return folders
  }
}

const wiki = WIKI as unknown as {
  config: { db: { type: string } }
  models: {
    assetFolders: typeof AssetFolder
    knex: Knex
  }
}
