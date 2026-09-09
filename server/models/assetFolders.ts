import { Model } from 'objection'
import type { Knex } from 'knex'
import _ from 'lodash'

interface AssetFolderRow {
  id: number
  name: string
  slug: string
  parentId: number | null
}

export type AssetFolderHierarchyFailureKind = 'missing' | 'cycle' | 'incomplete' | 'disappeared'

export class AssetFolderHierarchyError extends Error {
  readonly kind: AssetFolderHierarchyFailureKind
  readonly folderId: number

  constructor (kind: AssetFolderHierarchyFailureKind, folderId: number) {
    super(`Asset folder hierarchy ${kind} at ${folderId}.`)
    this.name = 'AssetFolderHierarchyError'
    this.kind = kind
    this.folderId = folderId
  }
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

  static async getHierarchy (folderId: number, transaction?: Knex.Transaction): Promise<AssetFolderRow[]> {
    if (folderId === 0) return []
    if (!Number.isSafeInteger(folderId) || folderId < 1) throw new Error(`Asset folder ${folderId} is invalid.`)

    const database = transaction ?? wiki.models.knex
    const hierarchy: AssetFolderRow[] = []
    const seen = new Set<number>()
    let currentId: number | null = folderId

    while (currentId !== null) {
      if (seen.has(currentId)) throw new AssetFolderHierarchyError('cycle', currentId)
      seen.add(currentId)
      const row: AssetFolderRow | undefined = await database<AssetFolderRow>('assetFolders')
        .select('id', 'name', 'slug', 'parentId')
        .where('id', currentId)
        .first()
      if (!row) throw new AssetFolderHierarchyError('missing', currentId)
      if (
        row.id !== currentId ||
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        typeof row.slug !== 'string' ||
        row.slug.length === 0 ||
        (row.parentId !== null && (!Number.isSafeInteger(row.parentId) || row.parentId < 1))
      ) {
        throw new AssetFolderHierarchyError('incomplete', currentId)
      }
      hierarchy.push(row)
      currentId = row.parentId
    }

    hierarchy.reverse()
    return hierarchy
  }
  static async getAllPaths (): Promise<Record<number, string>> {
    const all = await wiki.models.assetFolders.query()
    const folders: Record<number, string> = {}
    for (const folder of all) {
      if (
        !folder ||
        !Number.isSafeInteger(folder.id) ||
        folder.id < 1 ||
        typeof folder.slug !== 'string' ||
        folder.slug.length === 0 ||
        (folder.parentId !== null && (!Number.isSafeInteger(folder.parentId) || folder.parentId < 1))
      ) {
        throw new AssetFolderHierarchyError('incomplete', Number.isSafeInteger(folder?.id) ? folder.id : 0)
      }
    }
    all.forEach(folder => {
      folders[folder.id] = folder.slug
      let parentId = folder.parentId
      const seen = new Set<number>([folder.id])
      while (parentId !== null) {
        if (seen.has(parentId)) throw new AssetFolderHierarchyError('cycle', parentId)
        seen.add(parentId)
        const parent = _.find(all, ['id', parentId])
        if (!parent) {
          throw new AssetFolderHierarchyError('missing', parentId)
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
