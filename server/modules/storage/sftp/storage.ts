import type { StorageConfig, StorageContext, WikiAsset, WikiPage } from '../../types.ts'
import { wiki } from '../../types.ts'
import SSH2Promise from 'ssh2-promise'
import type SFTP from 'ssh2-promise/lib/sftp.js'
import type SSHConfig from 'ssh2-promise/lib/sshConfig.js'
import _ from 'lodash'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import pageHelper from '../../../helpers/page.ts'

interface SftpStorageConfig extends StorageConfig {
  authMode: string
  basePath: string
  host: string
  passphrase: string
  password: string
  port: number
  privateKey: string
  username: string
}

interface SshConnectionConfig extends SSHConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

interface SftpStorageContext extends StorageContext<SftpStorageConfig> {
  client: SSH2Promise
  sftp: SFTP
  ensureDirectory(filePath: string): Promise<void>
}

interface SftpStoragePlugin {
  client: SSH2Promise | null
  sftp: SFTP | null
  activated(this: SftpStorageContext): Promise<void>
  deactivated(this: SftpStorageContext): Promise<void>
  init(this: SftpStorageContext): Promise<void>
  created(this: SftpStorageContext, page: WikiPage): Promise<void>
  updated(this: SftpStorageContext, page: WikiPage): Promise<void>
  deleted(this: SftpStorageContext, page: WikiPage): Promise<void>
  renamed(this: SftpStorageContext, page: WikiPage): Promise<void>
  assetUploaded(this: SftpStorageContext, asset: WikiAsset): Promise<void>
  assetDeleted(this: SftpStorageContext, asset: WikiAsset): Promise<void>
  assetRenamed(this: SftpStorageContext, asset: WikiAsset): Promise<void>
  getLocalLocation(this: SftpStorageContext): Promise<void>
  exportAll(this: SftpStorageContext): Promise<void>
  ensureDirectory(this: SftpStorageContext, filePath: string): Promise<void>
}

interface ExportPagePayload {
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

interface ExportAssetPayload {
  filename: string
  folderId: number | null
  data: Buffer
}

function isExportPagePayload(value: unknown): value is ExportPagePayload {
  return typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'localeCode' in value &&
    typeof value.localeCode === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'description' in value &&
    typeof value.description === 'string' &&
    'contentType' in value &&
    typeof value.contentType === 'string' &&
    'content' in value &&
    (typeof value.content === 'string' ||
      (typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content))) &&
    'isPublished' in value &&
    typeof value.isPublished === 'boolean' &&
    'updatedAt' in value &&
    (value.updatedAt instanceof Date || typeof value.updatedAt === 'string') &&
    'createdAt' in value &&
    (value.createdAt instanceof Date || typeof value.createdAt === 'string') &&
    'editorKey' in value &&
    typeof value.editorKey === 'string'
}

function isExportAssetPayload(value: unknown): value is ExportAssetPayload {
  return typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    typeof value.filename === 'string' &&
    'folderId' in value &&
    (typeof value.folderId === 'number' || value.folderId === null) &&
    'data' in value &&
    Buffer.isBuffer(value.data)
}


const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}


const getFilePath = <K extends string>(
  page: { contentType: string, localeCode: string } & Record<K, string>,
  pathKey: K
): string => {
  const fileName = `${page[pathKey]}.${pageHelper.getFileExtension(page.contentType)}`
  const withLocaleCode = wiki.config.lang.namespacing && wiki.config.lang.code !== page.localeCode
  return withLocaleCode ? `${page.localeCode}/${fileName}` : fileName
}

const plugin: SftpStoragePlugin = {
  client: null,
  sftp: null,
  async activated() {

  },
  async deactivated() {

  },
  async init() {
    wiki.logger.info(`(STORAGE/SFTP) Initializing...`)
    const connectionConfig: SshConnectionConfig = {
      host: this.config.host,
      port: this.config.port || 22,
      username: this.config.username,
      ...(this.config.authMode === 'password' ? { password: this.config.password } : {}),
      ...(this.config.authMode === 'privateKey'
        ? {
            privateKey: this.config.privateKey,
            ...(this.config.passphrase ? { passphrase: this.config.passphrase } : {})
          }
        : {})
    }
    this.client = new SSH2Promise(connectionConfig)
    await this.client.connect()
    this.sftp = this.client.sftp()
    try {
      await this.sftp.readdir(this.config.basePath)
    } catch (err: unknown) {
      const message = getErrorMessage(err)
      wiki.logger.warn(`(STORAGE/SFTP) ${message}`)
      throw new Error(`Unable to read specified base directory: ${message}`, { cause: err })
    }
    wiki.logger.info(`(STORAGE/SFTP) Initialization completed.`)
  },
  async created(page) {
    wiki.logger.info(`(STORAGE/SFTP) Creating file ${page.path}...`)
    const filePath = getFilePath(page, 'path')
    await this.ensureDirectory(filePath)
    await this.sftp.writeFile(path.posix.join(this.config.basePath, filePath), page.injectMetadata(), { encoding: 'utf8' })
  },
  async updated(page) {
    wiki.logger.info(`(STORAGE/SFTP) Updating file ${page.path}...`)
    const filePath = getFilePath(page, 'path')
    await this.ensureDirectory(filePath)
    await this.sftp.writeFile(path.posix.join(this.config.basePath, filePath), page.injectMetadata(), { encoding: 'utf8' })
  },
  async deleted(page) {
    wiki.logger.info(`(STORAGE/SFTP) Deleting file ${page.path}...`)
    const filePath = getFilePath(page, 'path')
    await this.sftp.unlink(path.posix.join(this.config.basePath, filePath))
  },
  async renamed(page) {
    wiki.logger.info(`(STORAGE/SFTP) Renaming file ${page.path} to ${page.destinationPath}...`)
    let sourceFilePath = getFilePath(page, 'path')
    let destinationFilePath = getFilePath(page, 'destinationPath')
    if (wiki.config.lang.namespacing) {
      if (wiki.config.lang.code !== page.localeCode) {
        sourceFilePath = `${page.localeCode}/${sourceFilePath}`
      }
      if (wiki.config.lang.code !== page.destinationLocaleCode) {
        destinationFilePath = `${page.destinationLocaleCode}/${destinationFilePath}`
      }
    }
    await this.ensureDirectory(destinationFilePath)
    await this.sftp.rename(path.posix.join(this.config.basePath, sourceFilePath), path.posix.join(this.config.basePath, destinationFilePath))
  },
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded (asset) {
    wiki.logger.info(`(STORAGE/SFTP) Creating new file ${asset.path}...`)
    await this.ensureDirectory(asset.path)
    await this.sftp.writeFile(path.posix.join(this.config.basePath, asset.path), asset.data.toString('binary'), { encoding: 'binary' })
  },
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to delete
   */
  async assetDeleted (asset) {
    wiki.logger.info(`(STORAGE/SFTP) Deleting file ${asset.path}...`)
    await this.sftp.unlink(path.posix.join(this.config.basePath, asset.path))
  },
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to rename
   */
  async assetRenamed (asset) {
    wiki.logger.info(`(STORAGE/SFTP) Renaming file from ${asset.path} to ${asset.destinationPath}...`)
    await this.ensureDirectory(asset.destinationPath)
    await this.sftp.rename(path.posix.join(this.config.basePath, asset.path), path.posix.join(this.config.basePath, asset.destinationPath))
  },
  async getLocalLocation () {

  },
  /**
   * HANDLERS
   */
  async exportAll() {
    wiki.logger.info(`(STORAGE/SFTP) Exporting all content to the remote server...`)

    // -> Pages
    await pipeline(
      wiki.models.knex.column('path', 'localeCode', 'title', 'description', 'contentType', 'content', 'isPublished', 'updatedAt', 'createdAt', 'editorKey').select().from('pages').where({
        visibility: 'public'
      }).stream(),
      new Transform({
        objectMode: true,
        transform: async (value: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          if (!isExportPagePayload(value)) {
            callback(new TypeError('Invalid page export row'))
            return
          }
          const page = value
          const filePath = getFilePath(page, 'path')
          wiki.logger.info(`(STORAGE/SFTP) Adding page ${filePath}...`)
          await this.ensureDirectory(filePath)
          const metadata = pageHelper.injectPageMetadata(page)
          await this.sftp.writeFile(
            path.posix.join(this.config.basePath, filePath),
            typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
            { encoding: 'utf8' }
          )
          callback()
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
          if (!isExportAssetPayload(value)) {
            callback(new TypeError('Invalid asset export row'))
            return
          }
          const asset = value
          const filename = (asset.folderId && asset.folderId > 0) ? `${_.get(assetFolders, asset.folderId)}/${asset.filename}` : asset.filename
          wiki.logger.info(`(STORAGE/SFTP) Adding asset ${filename}...`)
          await this.ensureDirectory(filename)
          await this.sftp.writeFile(path.posix.join(this.config.basePath, filename), asset.data.toString('binary'), { encoding: 'binary' })
          callback()
        }
      })
    )

    wiki.logger.info('(STORAGE/SFTP) All content has been pushed to the remote server.')
  },
  async ensureDirectory(filePath: string) {
    if (filePath.indexOf('/') >= 0) {
      try {
        const folderPaths = _.dropRight(filePath.split('/'))
        for (let i = 1; i <= folderPaths.length; i++) {
          const folderSection = _.take(folderPaths, i).join('/')
          const folderDir = path.posix.join(this.config.basePath, folderSection)
          try {
            await this.sftp.readdir(folderDir)
          } catch {
            await this.sftp.mkdir(folderDir)
          }
        }
      } catch {
        return
      }
    }
  }
}

export default plugin
