import { randomUUID } from 'node:crypto'
import _ from 'lodash'
import fs from 'fs-extra'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

import {
  projectCommentExport,
  projectGroupExport,
  projectHistoryExport,
  projectPageExport,
  projectSettingsExport,
  projectUserExport
} from '../repositories/utility-export-projection.ts'
type QueryRow = Record<string, unknown>

interface QueryBuilder {
  count(expression: string): QueryBuilder
  first(): Promise<{ total: string | number }>
  where(column: string, value: unknown): QueryBuilder
  orderBy(column: string): QueryBuilder
  offset(value: number): QueryBuilder
  limit(value: number): QueryBuilder
  withGraphJoined(graph: Record<string, boolean>): QueryBuilder
  withGraphFetched(graph: Record<string, boolean>): QueryBuilder
  modifyGraph(name: string, callback: (builder: { select(...columns: string[]): void }) => void): QueryBuilder
  then<TResult>(resolve: (value: QueryRow[]) => TResult): Promise<TResult>
}

interface QueryModel {
  query(): QueryBuilder
}

interface AssetChunk {
  filename: string
  folderId?: number
  data: string | NodeJS.ArrayBufferView
}

interface ExportOptions {
  path: string
  entities: string[]
}

interface ExportStatus {
  status: 'notrunning' | 'running' | 'success' | 'error'
  progress: number
  message: string
  updatedAt: null
  startedAt?: Date
}

interface WikiModels {
  assetFolders: { getAllPaths(): Promise<Record<string, string>> }
  assets: QueryModel
  comments: QueryModel
  groups: QueryModel
  pageHistory: QueryModel
  navigation: QueryModel
  pages: QueryModel
  analytics: QueryModel
  authentication: QueryModel
  commentProviders: QueryModel
  renderers: QueryModel
  searchEngines: QueryModel
  storage: QueryModel
  apiKeys: QueryModel
  users: QueryModel
  knex: {
    select(...columns: string[]): {
      from(table: string): {
        join(
          table: string,
          left: string,
          operator: string,
          right: string
        ): {
          stream(): Readable
        }
      }
    }
    raw?(statement: string): Promise<{ rows?: unknown[] } | unknown[]>
  }
}

interface WikiContext {
  ROOTPATH: string
  config: Record<string, unknown> & { dataPath: string }
  logger: { info(message: string): void; warn(message: unknown): void }
  models: WikiModels
  version: string
  releaseDate: string
}

const wiki = WIKI as unknown as WikiContext

const exportStatus: ExportStatus = {
  status: 'notrunning',
  progress: 0,
  message: '',
  updatedAt: null
}

async function* serializeJsonBatches(
  batchSize: number,
  fetchBatch: (offset: number) => Promise<QueryRow[]>,
  onBatch: () => void,
  project: (row: QueryRow) => QueryRow | null = row => row
): AsyncGenerator<string> {
  let isFirst = true
  for (let offset = 0; ; offset += batchSize) {
    const rows = await fetchBatch(offset)
    if (rows.length === 0) break
    for (const row of rows) {
      const value = project(row)
      if (value === null) continue
      yield `${isFirst ? '[\n' : ',\n'}${JSON.stringify(value, null, 2)}`
      isFirst = false
    }
    onBatch()
  }
  yield '\n]'
}

const privateDirectory = async (directory: string): Promise<void> => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
}

const temporaryPath = (destination: string): string => `${destination}.${process.pid}.${randomUUID()}.tmp`

const writeFileAtomic = async (destination: string, data: string | Uint8Array): Promise<void> => {
  await privateDirectory(path.dirname(destination))
  const temporary = temporaryPath(destination)
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, destination)
  } catch (error) {
    await fs.remove(temporary)
    throw error
  }
}

const writeJsonAtomic = async (destination: string, value: unknown): Promise<void> => {
  await writeFileAtomic(destination, `${JSON.stringify(value, null, 2)}\n`)
}

const writeGzipJsonAtomic = async (destination: string, values: AsyncIterable<string>): Promise<void> => {
  await privateDirectory(path.dirname(destination))
  const temporary = temporaryPath(destination)
  try {
    await pipeline(Readable.from(values), zlib.createGzip(), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    await fs.rename(temporary, destination)
  } catch (error) {
    await fs.remove(temporary)
    throw error
  }
}

const childPath = (directory: string, relativePath: string): string => {
  const destination = path.resolve(directory, relativePath)
  if (destination === directory || !destination.startsWith(`${directory}${path.sep}`)) throw new Error(`Export path escapes assets directory: ${relativePath}`)
  return destination
}

const protectedAssetPaths = async (): Promise<Set<string>> => {
  if (!wiki.models.knex.raw) return new Set()
  const result = await wiki.models.knex.raw('SELECT "assetPath" FROM "pageProtectedAssets"')
  const rows = Array.isArray(result) ? result : Array.isArray(result.rows) ? result.rows : []
  return new Set(
    rows
      .map(row => (row !== null && typeof row === 'object' ? Reflect.get(row, 'assetPath') : undefined))
      .filter((value): value is string => typeof value === 'string')
  )
}

const system = {
  updates: {
    status: 'unavailable',
    version: null,
    releaseDate: null
  },
  exportStatus,
  init() {
    // Clear content cache
    fs.emptyDir(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'cache'))

    return this
  },
  /**
   * Export Wiki to Disk
   */
  async export(opts: ExportOptions): Promise<void> {
    this.exportStatus.status = 'running'
    this.exportStatus.progress = 0
    this.exportStatus.message = ''
    this.exportStatus.startedAt = new Date()

    wiki.logger.info(`Export started to path ${opts.path}`)
    wiki.logger.info(`Entities to export: ${opts.entities.join(', ')}`)

    const progressMultiplier = 1 / opts.entities.length

    try {
      await privateDirectory(opts.path)
      for (const entity of opts.entities) {
        switch (entity) {
          // -----------------------------------------
          // ASSETS
          // -----------------------------------------
          case 'assets': {
            wiki.logger.info('Exporting assets...')
            const [assetFolders, protectedPaths] = await Promise.all([wiki.models.assetFolders.getAllPaths(), protectedAssetPaths()])
            const assetsCountRaw = await wiki.models.assets.query().count('* as total').first()
            const assetsCount = Number.parseInt(String(assetsCountRaw.total), 10)
            if (assetsCount < 1) {
              wiki.logger.warn('There are no assets to export! Skipping...')
              break
            }
            const assetsDirectory = path.resolve(opts.path, 'assets')
            await privateDirectory(assetsDirectory)
            const assetsProgressMultiplier = progressMultiplier / assetsCount
            wiki.logger.info(`Found ${assetsCount} assets to export. Streaming to disk...`)

            await pipeline(
              wiki.models.knex.select('filename', 'folderId', 'data').from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream(),
              async (assets: AsyncIterable<AssetChunk>) => {
                for await (const asset of assets) {
                  const filename = asset.folderId && asset.folderId > 0 ? `${_.get(assetFolders, asset.folderId)}/${asset.filename}` : asset.filename
                  if (protectedPaths.has(filename)) {
                    this.exportStatus.progress += assetsProgressMultiplier * 100
                    continue
                  }
                  const outputPath = childPath(assetsDirectory, filename)
                  await writeFileAtomic(outputPath, asset.data as string | Uint8Array)
                  this.exportStatus.progress += assetsProgressMultiplier * 100
                }
              }
            )
            wiki.logger.info('Export: assets saved to disk successfully.')
            break
          }
          // -----------------------------------------
          // COMMENTS
          // -----------------------------------------
          case 'comments': {
            wiki.logger.info('Exporting comments...')
            const outputPath = path.join(opts.path, 'comments.json.gz')
            const commentsCountRaw = await wiki.models.comments.query().count('* as total').first()
            const commentsCount = Number.parseInt(String(commentsCountRaw.total), 10)
            if (commentsCount < 1) {
              wiki.logger.warn('There are no comments to export! Skipping...')
              break
            }
            const commentsProgressMultiplier = progressMultiplier / Math.ceil(commentsCount / 50)
            wiki.logger.info(`Found ${commentsCount} comments to export. Streaming to file...`)

            const comments = serializeJsonBatches(
              50,
              async offset =>
                await wiki.models.comments
                  .query()
                  .orderBy('comments.id')
                  .offset(offset)
                  .limit(50)
                  .withGraphJoined({
                    author: true,
                    page: true
                  })
                  .modifyGraph('author', builder => {
                    builder.select('users.id', 'users.name')
                  })
                  .modifyGraph('page', builder => {
                    builder.select('pages.id', 'pages.path', 'pages.localeCode', 'pages.title', 'pages.visibility')
                  }),
              () => {
                this.exportStatus.progress += commentsProgressMultiplier * 100
              },
              projectCommentExport
            )
            await writeGzipJsonAtomic(outputPath, comments)
            wiki.logger.info('Export: comments.json.gz created successfully.')
            break
          }
          // -----------------------------------------
          // GROUPS
          // -----------------------------------------
          case 'groups': {
            wiki.logger.info('Exporting groups...')
            const outputPath = path.join(opts.path, 'groups.json')
            const groups = await wiki.models.groups.query()
            await writeJsonAtomic(outputPath, groups.map(projectGroupExport))
            wiki.logger.info('Export: groups.json created successfully.')
            this.exportStatus.progress += progressMultiplier * 100
            break
          }
          // -----------------------------------------
          // HISTORY
          // -----------------------------------------
          case 'history': {
            wiki.logger.info('Exporting pages history...')
            const outputPath = path.join(opts.path, 'pages-history.json.gz')
            const pagesCountRaw = await wiki.models.pageHistory.query().where('visibility', 'public').count('* as total').first()
            const pagesCount = Number.parseInt(String(pagesCountRaw.total), 10)
            if (pagesCount < 1) {
              wiki.logger.warn('There are no pages history to export! Skipping...')
              break
            }
            const pagesProgressMultiplier = progressMultiplier / Math.ceil(pagesCount / 10)
            wiki.logger.info(`Found ${pagesCount} pages history to export. Streaming to file...`)

            const pages = serializeJsonBatches(
              10,
              async offset =>
                await wiki.models.pageHistory
                  .query()
                  .where('visibility', 'public')
                  .orderBy('pageHistory.id')
                  .offset(offset)
                  .limit(10)
                  .withGraphFetched({
                    author: true,
                    tags: true
                  })
                  .modifyGraph('author', builder => {
                    builder.select('users.id', 'users.name')
                  })
                  .modifyGraph('tags', builder => {
                    builder.select('tags.id', 'tags.tag', 'tags.title')
                  }),
              () => {
                this.exportStatus.progress += pagesProgressMultiplier * 100
              },
              projectHistoryExport
            )
            await writeGzipJsonAtomic(outputPath, pages)
            wiki.logger.info('Export: pages-history.json.gz created successfully.')
            break
          }
          // -----------------------------------------
          // NAVIGATION
          // -----------------------------------------
          case 'navigation': {
            wiki.logger.info('Exporting navigation...')
            const outputPath = path.join(opts.path, 'navigation.json')
            const navigationRaw = await wiki.models.navigation.query()
            const navigation: Record<string, unknown> = {}
            for (const entry of navigationRaw) {
              if (typeof entry.key === 'string') navigation[entry.key] = entry.config
            }
            await writeJsonAtomic(outputPath, navigation)
            wiki.logger.info('Export: navigation.json created successfully.')
            this.exportStatus.progress += progressMultiplier * 100
            break
          }
          // -----------------------------------------
          case 'pages': {
            wiki.logger.info('Exporting pages...')
            const outputPath = path.join(opts.path, 'pages.json.gz')
            const pagesCountRaw = await wiki.models.pages.query().where('visibility', 'public').count('* as total').first()
            const pagesCount = Number.parseInt(String(pagesCountRaw.total), 10)
            if (pagesCount < 1) {
              wiki.logger.warn('There are no pages to export! Skipping...')
              break
            }
            const pagesProgressMultiplier = progressMultiplier / Math.ceil(pagesCount / 10)
            wiki.logger.info(`Found ${pagesCount} pages to export. Streaming to file...`)

            const pages = serializeJsonBatches(
              10,
              async offset =>
                await wiki.models.pages
                  .query()
                  .where('visibility', 'public')
                  .orderBy('pages.id')
                  .offset(offset)
                  .limit(10)
                  .withGraphFetched({
                    author: true,
                    creator: true,
                    tags: true
                  })
                  .modifyGraph('author', builder => {
                    builder.select('users.id', 'users.name')
                  })
                  .modifyGraph('creator', builder => {
                    builder.select('users.id', 'users.name')
                  })
                  .modifyGraph('tags', builder => {
                    builder.select('tags.id', 'tags.tag', 'tags.title')
                  }),
              () => {
                this.exportStatus.progress += pagesProgressMultiplier * 100
              },
              projectPageExport
            )
            await writeGzipJsonAtomic(outputPath, pages)
            wiki.logger.info('Export: pages.json.gz created successfully.')
            break
          }
          // -----------------------------------------
          // SETTINGS
          case 'settings': {
            wiki.logger.info('Exporting settings...')
            const outputPath = path.join(opts.path, 'settings.json')
            const [analytics, authentication, commentProviders, renderers, searchEngines, storage, apiKeys] = await Promise.all([
              wiki.models.analytics.query(),
              wiki.models.authentication.query(),
              wiki.models.commentProviders.query(),
              wiki.models.renderers.query(),
              wiki.models.searchEngines.query(),
              wiki.models.storage.query(),
              wiki.models.apiKeys.query()
            ])
            const config = projectSettingsExport({
              config: wiki.config,
              analytics,
              authentication,
              commentProviders,
              renderers,
              searchEngines,
              storage,
              apiKeys
            })
            await writeJsonAtomic(outputPath, config)
            wiki.logger.info('Export: settings.json created successfully.')
            this.exportStatus.progress += progressMultiplier * 100
            break
          }
          // -----------------------------------------
          // USERS
          // -----------------------------------------
          case 'users': {
            wiki.logger.info('Exporting users...')
            const outputPath = path.join(opts.path, 'users.json.gz')
            const usersCountRaw = await wiki.models.users.query().count('* as total').first()
            const usersCount = Number.parseInt(String(usersCountRaw.total), 10)
            if (usersCount < 1) {
              wiki.logger.warn('There are no users to export! Skipping...')
              break
            }
            const usersProgressMultiplier = progressMultiplier / Math.ceil(usersCount / 50)
            wiki.logger.info(`Found ${usersCount} users to export. Streaming to file...`)

            const users = serializeJsonBatches(
              50,
              async offset =>
                await wiki.models.users
                  .query()
                  .orderBy('users.id')
                  .offset(offset)
                  .limit(50)
                  .withGraphFetched({
                    groups: true,
                    provider: true
                  })
                  .modifyGraph('groups', builder => {
                    builder.select('groups.id', 'groups.name')
                  })
                  .modifyGraph('provider', builder => {
                    builder.select('authentication.key', 'authentication.strategyKey', 'authentication.displayName')
                  }),
              () => {
                this.exportStatus.progress += usersProgressMultiplier * 100
              },
              projectUserExport
            )
            await writeGzipJsonAtomic(outputPath, users)

            wiki.logger.info('Export: users.json.gz created successfully.')
            break
          }
        }
      }
      this.exportStatus.status = 'success'
      this.exportStatus.progress = 100
    } catch (err) {
      this.exportStatus.status = 'error'
      this.exportStatus.message = err instanceof Error ? err.message : String(err)
    }
  }
}

export default system
