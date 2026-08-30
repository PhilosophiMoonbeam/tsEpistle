import type { StorageConfig, StorageContext, StoragePlugin } from '../../types.ts'
import { wiki } from '../../types.ts'
import { BlobServiceClient, RestError, StorageSharedKeyCredential, type ContainerClient } from '@azure/storage-blob'
import { pipeline } from 'node:stream/promises'
import pageHelper from '../../../helpers/page.ts'
import _ from 'lodash'
import { storageObjectKey } from '../object-key.ts'
import { asyncObjectTransform } from '../async-transform.ts'

interface AzureStorageConfig extends StorageConfig {
  accountKey: string
  accountName: string
  containerName: string
  pathPrefix: string
}

interface AzureStorageContext extends StorageContext<AzureStorageConfig> {
  client: BlobServiceClient
  container: ContainerClient
  storageName: string
}

interface PageExportRow {
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

interface AssetExportRow {
  filename: string
  folderId: number | null
  data: Buffer
}

function isPageExportRow(value: unknown): value is PageExportRow {
  return (
    typeof value === 'object' &&
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
    (typeof value.content === 'string' || (typeof value.content === 'object' && value.content !== null && !Array.isArray(value.content))) &&
    'isPublished' in value &&
    typeof value.isPublished === 'boolean' &&
    'updatedAt' in value &&
    (value.updatedAt instanceof Date || typeof value.updatedAt === 'string') &&
    'createdAt' in value &&
    (value.createdAt instanceof Date || typeof value.createdAt === 'string') &&
    'editorKey' in value &&
    typeof value.editorKey === 'string'
  )
}

function isAssetExportRow(value: unknown): value is AssetExportRow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    typeof value.filename === 'string' &&
    'folderId' in value &&
    (typeof value.folderId === 'number' || value.folderId === null) &&
    'data' in value &&
    Buffer.isBuffer(value.data)
  )
}

const getFilePath = <K extends 'destinationPath' | 'path'>(
  page: { contentType: string } & Record<K, string>,
  pathKey: K,
  pathPrefix: unknown,
  localeCode: string
): string => {
  const fileName = `${page[pathKey]}.${pageHelper.getFileExtension(page.contentType)}`
  const withLocaleCode = wiki.config.lang.namespacing && wiki.config.lang.code !== localeCode
  return storageObjectKey(pathPrefix, withLocaleCode ? `${localeCode}/${fileName}` : fileName)
}

const plugin: StoragePlugin<AzureStorageConfig, AzureStorageContext> = {
  async activated() {},
  async deactivated() {},
  async init() {
    wiki.logger.info(`(STORAGE/AZURE) Initializing...`)
    const { accountName, accountKey, containerName } = this.config
    this.client = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, new StorageSharedKeyCredential(accountName, accountKey))
    this.container = this.client.getContainerClient(containerName)
    try {
      await this.container.create()
    } catch (err: unknown) {
      if (!(err instanceof RestError) || err.statusCode !== 409) {
        wiki.logger.warn(err instanceof Error ? err.message : String(err))
        throw err
      }
    }
    wiki.logger.info(`(STORAGE/AZURE) Initialization completed.`)
  },
  async created(page) {
    wiki.logger.info(`(STORAGE/AZURE) Creating file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    const pageContent = page.injectMetadata()
    const blockBlobClient = this.container.getBlockBlobClient(filePath)
    await blockBlobClient.upload(pageContent, pageContent.length, { tier: this.config.storageTier })
  },
  async updated(page) {
    wiki.logger.info(`(STORAGE/AZURE) Updating file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    const pageContent = page.injectMetadata()
    const blockBlobClient = this.container.getBlockBlobClient(filePath)
    await blockBlobClient.upload(pageContent, pageContent.length, { tier: this.config.storageTier })
  },
  async deleted(page) {
    wiki.logger.info(`(STORAGE/AZURE) Deleting file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    const blockBlobClient = this.container.getBlockBlobClient(filePath)
    await blockBlobClient.delete({
      deleteSnapshots: 'include'
    })
  },
  async renamed(page) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Renaming file ${page.path} to ${page.destinationPath}...`)
    const sourceFilePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    const destinationFilePath = getFilePath(page, 'destinationPath', this.config.pathPrefix, page.destinationLocaleCode)
    const sourceBlockBlobClient = this.container.getBlockBlobClient(sourceFilePath)
    const destBlockBlobClient = this.container.getBlockBlobClient(destinationFilePath)
    await destBlockBlobClient.syncCopyFromURL(sourceBlockBlobClient.url)
    await sourceBlockBlobClient.delete({
      deleteSnapshots: 'include'
    })
  },
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded(asset) {
    wiki.logger.info(`(STORAGE/AZURE) Creating new file ${asset.path}...`)
    const blockBlobClient = this.container.getBlockBlobClient(storageObjectKey(this.config.pathPrefix, asset.path))
    await blockBlobClient.upload(asset.data, asset.data.length, { tier: this.config.storageTier })
  },
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to delete
   */
  async assetDeleted(asset) {
    wiki.logger.info(`(STORAGE/AZURE) Deleting file ${asset.path}...`)
    const blockBlobClient = this.container.getBlockBlobClient(storageObjectKey(this.config.pathPrefix, asset.path))
    await blockBlobClient.delete({
      deleteSnapshots: 'include'
    })
  },
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to rename
   */
  async assetRenamed(asset) {
    wiki.logger.info(`(STORAGE/AZURE) Renaming file from ${asset.path} to ${asset.destinationPath}...`)
    const sourceBlockBlobClient = this.container.getBlockBlobClient(storageObjectKey(this.config.pathPrefix, asset.path))
    const destBlockBlobClient = this.container.getBlockBlobClient(storageObjectKey(this.config.pathPrefix, asset.destinationPath))
    await destBlockBlobClient.syncCopyFromURL(sourceBlockBlobClient.url)
    await sourceBlockBlobClient.delete({
      deleteSnapshots: 'include'
    })
  },
  async getLocalLocation() {},
  /**
   * HANDLERS
   */
  async exportAll() {
    wiki.logger.info(`(STORAGE/AZURE) Exporting all content to Azure Blob Storage...`)

    // -> Pages
    await pipeline(
      wiki.models.knex
        .column('path', 'localeCode', 'title', 'description', 'contentType', 'content', 'isPublished', 'updatedAt', 'createdAt', 'editorKey')
        .select()
        .from('pages')
        .where({
          visibility: 'public'
        })
        .stream(),
      asyncObjectTransform(async value => {
        if (!isPageExportRow(value)) {
          throw new TypeError('Invalid page export row')
        }
        const filePath = getFilePath(value, 'path', this.config.pathPrefix, value.localeCode)
        wiki.logger.info(`(STORAGE/AZURE) Adding page ${filePath}...`)
        const metadata = pageHelper.injectPageMetadata(value)
        const pageContent = typeof metadata === 'string' ? metadata : JSON.stringify(metadata)
        const blockBlobClient = this.container.getBlockBlobClient(filePath)
        await blockBlobClient.upload(pageContent, pageContent.length, { tier: this.config.storageTier })
      })
    )

    // -> Assets
    const assetFolders = await wiki.models.assetFolders.getAllPaths()

    await pipeline(
      wiki.models.knex.column('filename', 'folderId', 'data').select().from('assets').join('assetData', 'assets.id', '=', 'assetData.id').stream(),
      asyncObjectTransform(async value => {
        if (!isAssetExportRow(value)) {
          throw new TypeError('Invalid asset export row')
        }
        const filename = value.folderId && value.folderId > 0 ? `${_.get(assetFolders, value.folderId)}/${value.filename}` : value.filename
        wiki.logger.info(`(STORAGE/AZURE) Adding asset ${filename}...`)
        const blockBlobClient = this.container.getBlockBlobClient(storageObjectKey(this.config.pathPrefix, filename))
        await blockBlobClient.upload(value.data, value.data.length, { tier: this.config.storageTier })
      })
    )

    wiki.logger.info('(STORAGE/AZURE) All content has been pushed to Azure Blob Storage.')
  }
}

export default plugin
