import { wiki, type StorageConfig, type WikiAsset, type WikiPage } from '../../types.ts'
import { CopyObjectCommand, DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'
import { pipeline } from 'node:stream/promises'
import _ from 'lodash'
import pageHelper from '../../../helpers/page.ts'
import { encodeS3CopySource, storageObjectKey } from '../object-key.ts'
import { asyncObjectTransform } from '../async-transform.ts'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPageExportRow(value: unknown): value is PageExportRow {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.localeCode === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.contentType === 'string' &&
    (typeof value.content === 'string' || isRecord(value.content)) &&
    typeof value.isPublished === 'boolean' &&
    (value.updatedAt instanceof Date || typeof value.updatedAt === 'string') &&
    (value.createdAt instanceof Date || typeof value.createdAt === 'string') &&
    typeof value.editorKey === 'string'
  )
}

function isAssetExportRow(value: unknown): value is AssetExportRow {
  return isRecord(value) && typeof value.filename === 'string' && (typeof value.folderId === 'number' || value.folderId === null) && Buffer.isBuffer(value.data)
}

function serializeContent(content: string | Record<string, unknown>): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/**
 * Deduce the file path given the `page` object and the object's key to the page's path.
 */
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

/**
 * Can be used with S3 compatible storage.
 */
export default class S3CompatibleStorage {
  config!: StorageConfig & {
    accessKeyId: string
    bucket: string
    secretAccessKey: string
    pathPrefix: string
  }
  storageName: string
  bucketName: string
  s3!: S3Client

  constructor(storageName: string) {
    this.storageName = storageName
    this.bucketName = ''
  }
  async activated() {
    // not used
  }
  async deactivated() {
    // not used
  }
  async init() {
    wiki.logger.info(`(STORAGE/${this.storageName}) Initializing...`)
    const { accessKeyId, secretAccessKey, bucket } = this.config
    const s3Config: S3ClientConfig = {}

    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = { accessKeyId, secretAccessKey }
    }

    if (!_.isNil(this.config.region)) {
      s3Config.region = this.config.region
    }
    if (!_.isNil(this.config.endpoint)) {
      s3Config.endpoint = /^http/.test(this.config.endpoint)
        ? this.config.endpoint
        : `${this.config.sslEnabled === false ? 'http' : 'https'}://${this.config.endpoint}`
    }
    if (!_.isNil(this.config.s3ForcePathStyle)) {
      s3Config.forcePathStyle = this.config.s3ForcePathStyle
    }
    if (!_.isNil(this.config.s3BucketEndpoint)) {
      s3Config.bucketEndpoint = this.config.s3BucketEndpoint
    }

    this.s3 = new S3Client(s3Config)
    this.bucketName = bucket

    // determine if a bucket exists and you have permission to access it
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucketName }))

    wiki.logger.info(`(STORAGE/${this.storageName}) Initialization completed.`)
  }
  async created(page: WikiPage) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Creating file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: filePath, Body: page.injectMetadata() }))
  }
  async updated(page: WikiPage) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Updating file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: filePath, Body: page.injectMetadata() }))
  }
  async deleted(page: WikiPage) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Deleting file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: filePath }))
  }
  async renamed(page: WikiPage) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Renaming file ${page.path} to ${page.destinationPath}...`)
    const sourceFilePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    const destinationFilePath = getFilePath(page, 'destinationPath', this.config.pathPrefix, page.destinationLocaleCode)
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: encodeS3CopySource(this.bucketName, sourceFilePath),
        Key: destinationFilePath
      })
    )
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: sourceFilePath }))
  }
  /**
   * ASSET UPLOAD
   *
   * @param {Object} asset Asset to upload
   */
  async assetUploaded(asset: WikiAsset) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Creating new file ${asset.path}...`)
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: storageObjectKey(this.config.pathPrefix, asset.path), Body: asset.data }))
  }
  /**
   * ASSET DELETE
   *
   * @param {Object} asset Asset to delete
   */
  async assetDeleted(asset: WikiAsset) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Deleting file ${asset.path}...`)
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: storageObjectKey(this.config.pathPrefix, asset.path) }))
  }
  /**
   * ASSET RENAME
   *
   * @param {Object} asset Asset to rename
   */
  async assetRenamed(asset: WikiAsset) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Renaming file from ${asset.path} to ${asset.destinationPath}...`)
    const sourcePath = storageObjectKey(this.config.pathPrefix, asset.path)
    const destinationPath = storageObjectKey(this.config.pathPrefix, asset.destinationPath)
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: encodeS3CopySource(this.bucketName, sourcePath),
        Key: destinationPath
      })
    )
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: sourcePath }))
  }
  async getLocalLocation() {}
  /**
   * HANDLERS
   */
  async exportAll() {
    wiki.logger.info(`(STORAGE/${this.storageName}) Exporting all content to the cloud provider...`)

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
        wiki.logger.info(`(STORAGE/${this.storageName}) Adding page ${filePath}...`)
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: filePath,
            Body: serializeContent(pageHelper.injectPageMetadata(value))
          })
        )
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
        wiki.logger.info(`(STORAGE/${this.storageName}) Adding asset ${filename}...`)
        await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: storageObjectKey(this.config.pathPrefix, filename), Body: value.data }))
      })
    )

    wiki.logger.info(`(STORAGE/${this.storageName}) All content has been pushed to the cloud provider.`)
  }
}
