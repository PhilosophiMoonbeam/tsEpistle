import _ from 'lodash'
import cfgHelper from '../helpers/config.ts'
import fs from 'fs-extra'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { MongoClient, type MongoCursor } from 'mongodb'

type QueryRow = Record<string, unknown>

interface QueryBuilder {
  count(expression: string): QueryBuilder
  first(): Promise<{ total: string | number }>
  offset(value: number): QueryBuilder
  limit(value: number): QueryBuilder
  withGraphJoined(graph: Record<string, boolean>): QueryBuilder
  modifyGraph(name: string, callback: (builder: { select(...columns: string[]): void }) => void): QueryBuilder
  where(column: string, value: unknown): QueryBuilder
  then<TResult>(resolve: (value: QueryRow[]) => TResult): Promise<TResult>
}

interface QueryModel {
  query(): QueryBuilder
}

interface ImportedUser {
  email: string
  name: string
  password: string
  provider: string
  providerId: string
  role: 'user'
  createdAt?: Date | string
}

interface MongoUser {
  email: string
  name?: string
  password?: string
  provider?: string
  providerId?: string
  createdAt?: Date | string
}

interface AssetChunk {
  filename: string
  folderId?: number
  data: string | NodeJS.ArrayBufferView
}

interface UpgradeOptions {
  mongoCnStr: string
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
  User: { bulkCreate(users: ImportedUser[]): Promise<unknown> }
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

async function collectCursor<TDocument extends object>(cursor: MongoCursor<TDocument>): Promise<TDocument[]> {
  const documents: TDocument[] = []
  while (await cursor.hasNext()) {
    const document = await cursor.next()
    if (document !== null) documents.push(document)
  }
  return documents
}

async function* serializeJsonBatches(batchSize: number, fetchBatch: (offset: number) => Promise<QueryRow[]>, onBatch: () => void): AsyncGenerator<string> {
  let isFirst = true
  for (let offset = 0; ; offset += batchSize) {
    const rows = await fetchBatch(offset)
    if (rows.length === 0) break
    for (const row of rows) {
      yield `${isFirst ? '[\n' : ',\n'}${JSON.stringify(row, null, 2)}`
      isFirst = false
    }
    onBatch()
  }
  yield '\n]'
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
   * Upgrade from WIKI.js 1.x - MongoDB database
   *
   * @param {Object} opts Options object
   */
  async upgradeFromMongo(opts: UpgradeOptions): Promise<boolean> {
    wiki.logger.info('Upgrading from MongoDB...')

    const parsedMongoConStr = cfgHelper.parseConfigValue(opts.mongoCnStr)
    const client = await MongoClient.connect(parsedMongoConStr)

    try {
      const users = client.db().collection<MongoUser>('users')

      // Check if users table is populated
      const userCount = (await collectCursor(users.find())).length
      if (userCount < 2) {
        throw new Error('MongoDB Upgrade: Users table is empty!')
      }

      // Import all users
      const userData = await collectCursor(
        users.find({
          email: {
            $not: 'guest'
          }
        })
      )
      await wiki.models.User.bulkCreate(
        userData.map(
          (usr): ImportedUser => ({
            email: usr.email,
            name: usr.name || 'Imported User',
            password: usr.password || '',
            provider: usr.provider || 'local',
            providerId: usr.providerId || '',
            role: 'user',
            ...(usr.createdAt === undefined ? {} : { createdAt: usr.createdAt })
          })
        )
      )

      return true
    } finally {
      await client.close()
    }
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
      for (const entity of opts.entities) {
        switch (entity) {
          // -----------------------------------------
          // ASSETS
          // -----------------------------------------
          case 'assets': {
            wiki.logger.info('Exporting assets...')
            const assetFolders = await wiki.models.assetFolders.getAllPaths()
            const assetsCountRaw = await wiki.models.assets.query().count('* as total').first()
            const assetsCount = Number.parseInt(String(assetsCountRaw.total), 10)
            if (assetsCount < 1) {
              wiki.logger.warn('There are no assets to export! Skipping...')
              break
            }
            const assetsProgressMultiplier = progressMultiplier / Math.ceil(assetsCount / 50)
            wiki.logger.info(`Found ${assetsCount} assets to export. Streaming to disk...`)

            await pipeline(
              wiki.models.knex.select('filename', 'folderId', 'data').from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream(),
              async (assets: AsyncIterable<AssetChunk>) => {
                for await (const asset of assets) {
                  const filename = asset.folderId && asset.folderId > 0 ? `${_.get(assetFolders, asset.folderId)}/${asset.filename}` : asset.filename
                  wiki.logger.info(`Exporting asset ${filename}...`)
                  await fs.outputFile(path.join(opts.path, 'assets', filename), asset.data)
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
                  .offset(offset)
                  .limit(50)
                  .withGraphJoined({
                    author: true,
                    page: true
                  })
                  .modifyGraph('author', builder => {
                    builder.select('users.id', 'users.name', 'users.email', 'users.providerKey')
                  })
                  .modifyGraph('page', builder => {
                    builder.select('pages.id', 'pages.path', 'pages.localeCode', 'pages.title')
                  }),
              () => {
                this.exportStatus.progress += commentsProgressMultiplier * 100
              }
            )
            await pipeline(Readable.from(comments), zlib.createGzip(), fs.createWriteStream(outputPath))
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
            await fs.outputJSON(outputPath, groups, { spaces: 2 })
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
            const pagesCountRaw = await wiki.models.pageHistory.query().count('* as total').first()
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
                  .offset(offset)
                  .limit(10)
                  .withGraphJoined({
                    author: true,
                    page: true,
                    tags: true
                  })
                  .modifyGraph('author', builder => {
                    builder.select('users.id', 'users.name', 'users.email', 'users.providerKey')
                  })
                  .modifyGraph('page', builder => {
                    builder.select('pages.id', 'pages.title', 'pages.path', 'pages.localeCode')
                  })
                  .modifyGraph('tags', builder => {
                    builder.select('tags.tag', 'tags.title')
                  }),
              () => {
                this.exportStatus.progress += pagesProgressMultiplier * 100
              }
            )
            await pipeline(Readable.from(pages), zlib.createGzip(), fs.createWriteStream(outputPath))
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
            await fs.outputJSON(outputPath, navigation, { spaces: 2 })
            wiki.logger.info('Export: navigation.json created successfully.')
            this.exportStatus.progress += progressMultiplier * 100
            break
          }
          // -----------------------------------------
          // PAGES
          // -----------------------------------------
          case 'pages': {
            wiki.logger.info('Exporting pages...')
            const outputPath = path.join(opts.path, 'pages.json.gz')
            const pagesCountRaw = await wiki.models.pages.query().count('* as total').first()
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
                  .offset(offset)
                  .limit(10)
                  .withGraphJoined({
                    author: true,
                    creator: true,
                    tags: true
                  })
                  .modifyGraph('author', builder => {
                    builder.select('users.id', 'users.name', 'users.email', 'users.providerKey')
                  })
                  .modifyGraph('creator', builder => {
                    builder.select('users.id', 'users.name', 'users.email', 'users.providerKey')
                  })
                  .modifyGraph('tags', builder => {
                    builder.select('tags.tag', 'tags.title')
                  }),
              () => {
                this.exportStatus.progress += pagesProgressMultiplier * 100
              }
            )
            await pipeline(Readable.from(pages), zlib.createGzip(), fs.createWriteStream(outputPath))
            wiki.logger.info('Export: pages.json.gz created successfully.')
            break
          }
          // -----------------------------------------
          // SETTINGS
          // -----------------------------------------
          case 'settings': {
            wiki.logger.info('Exporting settings...')
            const outputPath = path.join(opts.path, 'settings.json')
            const config = {
              ...wiki.config,
              modules: {
                analytics: await wiki.models.analytics.query(),
                authentication: (await wiki.models.authentication.query()).map(a => ({
                  ...a,
                  domainWhitelist: _.get(a, 'domainWhitelist.v', []),
                  autoEnrollGroups: _.get(a, 'autoEnrollGroups.v', [])
                })),
                commentProviders: await wiki.models.commentProviders.query(),
                renderers: await wiki.models.renderers.query(),
                searchEngines: await wiki.models.searchEngines.query(),
                storage: await wiki.models.storage.query()
              },
              apiKeys: await wiki.models.apiKeys.query().where('isRevoked', false)
            }
            await fs.outputJSON(outputPath, config, { spaces: 2 })
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
                  .offset(offset)
                  .limit(50)
                  .withGraphJoined({
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
              }
            )
            await pipeline(Readable.from(users), zlib.createGzip(), fs.createWriteStream(outputPath))

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
