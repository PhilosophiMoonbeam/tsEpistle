import type { StorageConfig, StorageContext, StoragePlugin, UnknownRecord } from '../../types.ts'
import { wiki } from '../../types.ts'
import fs from 'fs-extra'
import path from 'node:path'
import tar from 'tar-fs'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import moment from 'moment'

import pageHelper from '../../../helpers/page.ts'
import commonDisk from './common.ts'

interface DiskStorageContext extends StorageContext<StorageConfig> {
  sync(options?: { manual: boolean }): Promise<void>
}
interface PageExportRow {
  id: number
  path: string
  localeCode: string
  title: string
  description: string
  contentType: string
  content: string | Record<string, unknown>
  isPublished: boolean
  updatedAt: Date | string
  createdAt: Date | string
  editorKey: string
}

interface PageTag extends UnknownRecord {
  tag: string
}

interface AssetExportRow {
  filename: string
  folderId: number | null
  data: Buffer
}

function isPageExportRow (value: unknown): value is PageExportRow {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value && typeof value.id === 'number' &&
    'path' in value && typeof value.path === 'string' &&
    'localeCode' in value && typeof value.localeCode === 'string' &&
    'title' in value && typeof value.title === 'string' &&
    'description' in value && typeof value.description === 'string' &&
    'contentType' in value && typeof value.contentType === 'string' &&
    'content' in value &&
    (typeof value.content === 'string' ||
      (typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content))) &&
    'isPublished' in value && typeof value.isPublished === 'boolean' &&
    'updatedAt' in value && (value.updatedAt instanceof Date || typeof value.updatedAt === 'string') &&
    'createdAt' in value && (value.createdAt instanceof Date || typeof value.createdAt === 'string') &&
    'editorKey' in value && typeof value.editorKey === 'string'
}

function isAssetExportRow (value: unknown): value is AssetExportRow {
  return typeof value === 'object' &&
    value !== null &&
    'filename' in value && typeof value.filename === 'string' &&
    'folderId' in value && (value.folderId === null || typeof value.folderId === 'number') &&
    'data' in value && Buffer.isBuffer(value.data)
}

function serializeContent (content: string | Record<string, unknown>): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function toError (value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}


const plugin: StoragePlugin<StorageConfig, DiskStorageContext> = {
  async activated() {
    // not used
  },
  async deactivated() {
    // not used
  },
  async init() {
    wiki.logger.info('(STORAGE/DISK) Initializing...')
    await fs.ensureDir(this.config.path)
    wiki.logger.info('(STORAGE/DISK) Initialization completed.')
  },
  async sync({ manual } = { manual: false }) {
    if (this.config.createDailyBackups || manual) {
      const dirPath = path.join(this.config.path, manual ? '_manual' : '_daily')
      await fs.ensureDir(dirPath)

      const dateFilename = moment().format(manual ? 'YYYYMMDD-HHmmss' : 'DD')

      wiki.logger.info(`(STORAGE/DISK) Creating backup archive...`)
      await pipeline(
        tar.pack(this.config.path, {
          ignore: (filePath) => {
            return filePath.indexOf('_daily') >= 0 || filePath.indexOf('_manual') >= 0
          }
        }),
        zlib.createGzip(),
        fs.createWriteStream(path.join(dirPath, `wiki-${dateFilename}.tar.gz`))
      )
      wiki.logger.info('(STORAGE/DISK) Backup archive created successfully.')
    }
  },
  async created(page) {
    wiki.logger.info(`(STORAGE/DISK) Creating file [${page.localeCode}] ${page.path}...`)
    let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    if (wiki.config.lang.code !== page.localeCode) {
      fileName = `${page.localeCode}/${fileName}`
    }
    const filePath = path.join(this.config.path, fileName)
    await fs.outputFile(filePath, page.injectMetadata(), 'utf8')
  },
  async updated(page) {
    wiki.logger.info(`(STORAGE/DISK) Updating file [${page.localeCode}] ${page.path}...`)
    let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    if (wiki.config.lang.code !== page.localeCode) {
      fileName = `${page.localeCode}/${fileName}`
    }
    const filePath = path.join(this.config.path, fileName)
    await fs.outputFile(filePath, page.injectMetadata(), 'utf8')
  },
  async deleted(page) {
    wiki.logger.info(`(STORAGE/DISK) Deleting file [${page.localeCode}] ${page.path}...`)
    let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    if (wiki.config.lang.code !== page.localeCode) {
      fileName = `${page.localeCode}/${fileName}`
    }
    const filePath = path.join(this.config.path, fileName)
    await fs.unlink(filePath)
  },
  async renamed(page) {
    wiki.logger.info(`(STORAGE/DISK) Renaming file [${page.localeCode}] ${page.path} to [${page.destinationLocaleCode}] ${page.destinationPath}...`)

    let sourceFilePath = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
    let destinationFilePath = `${page.destinationPath}.${pageHelper.getFileExtension(page.contentType)}`

    if (wiki.config.lang.namespacing) {
      if (wiki.config.lang.code !== page.localeCode) {
        sourceFilePath = `${page.localeCode}/${sourceFilePath}`
      }
      if (wiki.config.lang.code !== page.destinationLocaleCode) {
        destinationFilePath = `${page.destinationLocaleCode}/${destinationFilePath}`
      }
    }

    await fs.move(path.join(this.config.path, sourceFilePath), path.join(this.config.path, destinationFilePath), { overwrite: true })
  },
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded (asset) {
    wiki.logger.info(`(STORAGE/DISK) Creating new file ${asset.path}...`)
    await fs.outputFile(path.join(this.config.path, asset.path), asset.data)
  },
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to delete
   */
  async assetDeleted (asset) {
    wiki.logger.info(`(STORAGE/DISK) Deleting file ${asset.path}...`)
    await fs.remove(path.join(this.config.path, asset.path))
  },
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to rename
   */
  async assetRenamed (asset) {
    wiki.logger.info(`(STORAGE/DISK) Renaming file from ${asset.path} to ${asset.destinationPath}...`)
    await fs.move(path.join(this.config.path, asset.path), path.join(this.config.path, asset.destinationPath), { overwrite: true })
  },
  async getLocalLocation (asset) {
    return path.join(this.config.path, asset.path)
  },
  /**
   * HANDLERS
   */
  async dump() {
    wiki.logger.info(`(STORAGE/DISK) Dumping all content to disk...`)

    // -> Pages
    await pipeline(
      wiki.models.knex.column('id', 'path', 'localeCode', 'title', 'description', 'contentType', 'content', 'isPublished', 'updatedAt', 'createdAt', 'editorKey').select().from('pages').where({
        isPrivate: false
      }).stream(),
      new Transform({
        objectMode: true,
        transform: async (value: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isPageExportRow(value)) {
              throw new TypeError('Invalid page export row')
            }
            const pageObject = await wiki.models.pages.query().findOne({ id: value.id })
            if (!pageObject) {
              throw new Error(`Page ${value.id} was not found`)
            }
            const tags = await pageObject.$relatedQuery('tags')
            if (!tags.every((tag): tag is PageTag => typeof tag.tag === 'string')) {
              throw new TypeError(`Invalid tags for page ${value.id}`)
            }
            const page = { ...value, tags }
            let fileName = `${page.path}.${pageHelper.getFileExtension(page.contentType)}`
            if (wiki.config.lang.code !== page.localeCode) {
              fileName = `${page.localeCode}/${fileName}`
            }
            wiki.logger.info(`(STORAGE/DISK) Dumping page ${fileName}...`)
            const filePath = path.join(this.config.path, fileName)
            await fs.outputFile(filePath, serializeContent(pageHelper.injectPageMetadata(page)), 'utf8')
            callback()
          } catch (error: unknown) {
            callback(toError(error))
          }
        }
      })
    )

    // -> Assets
    const assetFolders = await wiki.models.assetFolders.getAllPaths()

    await pipeline(
      wiki.models.knex.column('filename', 'folderId', 'data').select().from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream(),
      new Transform({
        objectMode: true,
        transform: async (value: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          try {
            if (!isAssetExportRow(value)) {
              throw new TypeError('Invalid asset export row')
            }
            let filename = value.filename
            if (value.folderId !== null && value.folderId > 0) {
              const folderPath = assetFolders[value.folderId]
              if (!folderPath) {
                throw new Error(`Asset folder ${value.folderId} was not found`)
              }
              filename = `${folderPath}/${filename}`
            }
            wiki.logger.info(`(STORAGE/DISK) Dumping asset ${filename}...`)
            await fs.outputFile(path.join(this.config.path, filename), value.data)
            callback()
          } catch (error: unknown) {
            callback(toError(error))
          }
        }
      })
    )

    wiki.logger.info('(STORAGE/DISK) All content was dumped to disk successfully.')
  },
  async backup() {
    return this.sync({ manual: true })
  },
  async importAll() {
    wiki.logger.info(`(STORAGE/DISK) Importing all content from local disk folder to the DB...`)
    await commonDisk.importFromDisk({
      fullPath: this.config.path,
      moduleName: 'DISK'
    })
    wiki.logger.info('(STORAGE/DISK) Import completed.')
  }
}

export default plugin
