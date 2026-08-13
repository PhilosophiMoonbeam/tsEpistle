import _ from 'lodash'
import database from '../core/db.ts'

interface PageRow { id: number, path: string, localeCode: string, title: string, isPrivate: boolean, privateNS: string | null }
interface PageTreeRow {
  id: number
  localeCode: string
  path: string
  depth: number
  title: string
  isFolder: boolean
  isPrivate: boolean
  privateNS: string | null
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
interface Models {
  pages: { query(): PagesQuery }
  knex: { table(name: string): TableQuery, destroy(): Promise<void> }
}
interface WikiContext {
  models: Models
  config: { db: { type: string } }
  configSvc: { loadFromDb(): Promise<void>, applyFlags(): Promise<void> }
  logger: { info(message: string): void, error(message: string): void }
}
const wiki = WIKI as unknown as WikiContext

export default async function rebuildTree (_pageId?: number): Promise<void> {
  void _pageId
  wiki.logger.info('Rebuilding page tree...')
  try {
    wiki.models = await database.init() as unknown as Models
    await wiki.configSvc.loadFromDb()
    await wiki.configSvc.applyFlags()
    const pages = await wiki.models.pages.query().select('id', 'path', 'localeCode', 'title', 'isPrivate', 'privateNS').orderBy(['localeCode', 'path'])
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
        const found = tree.find(row => row.localeCode === page.localeCode && row.path === currentPath)
        if (!found) {
          nextId++
          tree.push({
            id: nextId,
            localeCode: page.localeCode,
            path: currentPath,
            depth,
            title: isFolder ? part : page.title,
            isFolder,
            isPrivate: !isFolder && page.isPrivate,
            privateNS: !isFolder ? page.privateNS : null,
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

    await wiki.models.knex.table('pageTree').truncate()
    if (tree.length > 0) {
      const chunkSize = wiki.config.db.type !== 'sqlite' ? 100 : 60
      for (const chunk of _.chunk(tree, chunkSize)) await wiki.models.knex.table('pageTree').insert(chunk)
    }
    await wiki.models.knex.destroy()
    wiki.logger.info('Rebuilding page tree: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Rebuilding page tree: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.stack ?? error.message : String(error))
    throw error
  }
}
