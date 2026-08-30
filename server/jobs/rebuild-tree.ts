import _ from 'lodash'
import database from '../core/db.ts'

const TREE_REBUILD_LOCK_ID = 0x574b5452

interface PageRow {
  id: number
  path: string
  localeCode: string
  title: string
  visibility: 'public' | 'private'
  ownerId: number | null
}
interface PageTreeRow {
  id: number
  localeCode: string
  path: string
  depth: number
  title: string
  isFolder: boolean
  visibility: 'public' | 'private'
  ownerId: number | null
  parent: number | null
  pageId: number | null
  ancestors: string
}
interface PagesQuery extends PromiseLike<PageRow[]> {
  select(...columns: string[]): PagesQuery
  orderBy(columns: string[]): PagesQuery
}
interface TableQuery {
  truncate(): Promise<void>
  insert(rows: PageTreeRow[]): Promise<unknown>
}
interface Transaction {
  raw(sql: string, bindings: unknown[]): Promise<unknown>
  table(name: string): TableQuery
}
interface KnexClient extends Transaction {
  transaction<T>(callback: (trx: Transaction) => Promise<T>): Promise<T>
  destroy(): Promise<void>
}
interface Models {
  pages: { query(transaction?: Transaction): PagesQuery }
  knex: KnexClient
}
interface WikiContext {
  models: Models
  config: { db: { type: string } }
  configSvc: { loadFromDb(): Promise<void>; applyFlags(): Promise<void> }
  logger: { info(message: string): void; error(message: string): void }
}
const wiki = WIKI as unknown as WikiContext

export default async function rebuildTree(_pageId?: number): Promise<void> {
  void _pageId
  wiki.logger.info('Rebuilding page tree...')
  let models: Models | undefined
  try {
    const initializedModels = (await database.init()) as unknown as Models
    models = initializedModels
    wiki.models = initializedModels
    await wiki.configSvc.loadFromDb()
    await wiki.configSvc.applyFlags()
    await initializedModels.knex.transaction(async trx => {
      // Deliberately hold one PostgreSQL-owned rebuild generation from the source
      // read through replacement so a stale builder can never commit after a newer one.
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [TREE_REBUILD_LOCK_ID])
      const pages = await initializedModels.pages
        .query(trx)
        .select('id', 'path', 'localeCode', 'title', 'visibility', 'ownerId')
        .orderBy(['visibility', 'ownerId', 'localeCode', 'path'])
      const tree: PageTreeRow[] = []
      let nextId = 0

      for (const page of pages) {
        const pagePaths = page.path.split('/')
        let currentPath = ''
        let depth = 0
        let parentId: number | null = null
        const ancestors: number[] = []
        for (const part of pagePaths) {
          depth++
          const isFolder = depth < pagePaths.length
          currentPath = currentPath ? `${currentPath}/${part}` : part
          const found = tree.find(
            row => row.visibility === page.visibility && row.ownerId === page.ownerId && row.localeCode === page.localeCode && row.path === currentPath
          )
          if (!found) {
            nextId++
            tree.push({
              id: nextId,
              localeCode: page.localeCode,
              path: currentPath,
              depth,
              title: isFolder ? part : page.title,
              isFolder,
              visibility: page.visibility,
              ownerId: page.ownerId,
              parent: parentId,
              pageId: isFolder ? null : page.id,
              ancestors: JSON.stringify(ancestors)
            })
            parentId = nextId
          } else {
            if (isFolder && !found.isFolder) found.isFolder = true
            parentId = found.id
          }
          ancestors.push(parentId)
        }
      }

      await trx.table('pageTree').truncate()
      if (tree.length > 0) {
        for (const chunk of _.chunk(tree, 100)) await trx.table('pageTree').insert(chunk)
      }
    })
    wiki.logger.info('Rebuilding page tree: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Rebuilding page tree: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    throw error
  } finally {
    await models?.knex.destroy()
  }
}
