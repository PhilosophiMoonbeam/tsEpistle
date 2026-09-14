import { wiki, type StorageAssetRelocation, type StorageConfig, type WikiAsset, type WikiPage } from '../../types.ts'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import _ from 'lodash'
import pageHelper from '../../../helpers/page.ts'
import { encodeS3CopySource, storageObjectKey } from '../object-key.ts'
import { encodeStoragePageDocument, type StoragePageEncodingInput } from '../page-document.ts'
import { asyncObjectTransform } from '../async-transform.ts'
import { okfFilePath } from '../../../okf/format.ts'

interface PageExportRow {
  id: number
  path: string
  localeCode: string
  title: string
  description: string
  contentType: string
  content: string | Record<string, unknown>
  sourceRevision: string | number | bigint
  authorId: number
  extra: Record<string, unknown>
  isPublished: boolean | number
  updatedAt: Date | string
  createdAt: Date | string
  editorKey: string
  tags?: { tag: string }[]
}

interface AssetExportRow {
  filename: string
  folderId: number | null
  data: Buffer
}

interface PageTag extends Record<string, unknown> {
  tag: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPageExportRow(value: unknown): value is PageExportRow {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.path === 'string' &&
    typeof value.localeCode === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.contentType === 'string' &&
    (typeof value.content === 'string' || (isRecord(value.content) && !Array.isArray(value.content))) &&
    (typeof value.sourceRevision === 'string' || typeof value.sourceRevision === 'number' || typeof value.sourceRevision === 'bigint') &&
    typeof value.authorId === 'number' &&
    isRecord(value.extra) &&
    !Array.isArray(value.extra) &&
    (typeof value.isPublished === 'boolean' || value.isPublished === 0 || value.isPublished === 1) &&
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

function serializePage(page: StoragePageEncodingInput): string | Buffer {
  const encoded = encodeStoragePageDocument(page)
  if (page.contentType === 'markdown') {
    if (typeof encoded === 'object' && encoded !== null && 'markdown' in encoded && typeof encoded.markdown === 'string') {
      return Buffer.from(encoded.markdown, 'utf8')
    }
    throw new TypeError('Markdown page encoder did not return a document')
  }
  return serializeContent(encoded as string | Record<string, unknown>)
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
  if (page.contentType === 'markdown') {
    return storageObjectKey(pathPrefix, okfFilePath(localeCode, page[pathKey]))
  }
  const fileName = `${page[pathKey]}.${pageHelper.getFileExtension(page.contentType)}`
  const withLocaleCode = wiki.config.lang.namespacing && wiki.config.lang.code !== localeCode
  return storageObjectKey(pathPrefix, withLocaleCode ? `${localeCode}/${fileName}` : fileName)
}

/**
 * Can be used with S3 compatible storage.
 */
interface S3ObjectResponse {
  Body?: { transformToByteArray(): Promise<Uint8Array> }
  ETag?: string
}

function isS3NotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  const metadataStatus = typeof record.$metadata === 'object' && record.$metadata !== null ? Reflect.get(record.$metadata, 'httpStatusCode') : undefined
  return record.name === 'NoSuchKey' || record.name === 'NotFound' || metadataStatus === 404 || record.statusCode === 404 || record.status === 404
}

async function readS3ObjectBytes(response: S3ObjectResponse, failureMessage: string): Promise<Buffer> {
  if (!response.Body || typeof response.Body.transformToByteArray !== 'function') throw new Error(failureMessage)
  return Buffer.from(await response.Body.transformToByteArray())
}

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
    this.s3?.destroy()
  }
  async init() {
    wiki.logger.info(`(STORAGE/${this.storageName}) Initializing...`)
    const { accessKeyId, secretAccessKey, bucket } = this.config
    const s3Config: S3ClientConfig = {}

    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = { accessKeyId, secretAccessKey }
    }

    if (typeof this.config.region === 'string' && this.config.region.trim()) {
      s3Config.region = this.config.region.trim()
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
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: filePath, Body: serializePage(page) }))
  }
  async updated(page: WikiPage) {
    wiki.logger.info(`(STORAGE/${this.storageName}) Updating file ${page.path}...`)
    const filePath = getFilePath(page, 'path', this.config.pathPrefix, page.localeCode)
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: filePath, Body: serializePage(page) }))
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
  async assetRelocated(asset: StorageAssetRelocation) {
    const digest = createHash('sha256').update(asset.data).digest('hex')
    if (digest !== asset.contentSha256) throw new Error('Canonical asset bytes failed relocation validation')
    const sourcePath = storageObjectKey(this.config.pathPrefix, asset.sourcePath)
    const destinationPath = storageObjectKey(this.config.pathPrefix, asset.destinationPath)
    let destination: S3ObjectResponse | undefined
    try {
      destination = (await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: destinationPath }))) as unknown as S3ObjectResponse
    } catch (error: unknown) {
      if (!isS3NotFound(error)) throw error
    }
    if (destination === undefined) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: destinationPath,
          Body: asset.data,
          IfNoneMatch: '*',
          Metadata: { 'tsepistle-content-sha256': asset.contentSha256 }
        })
      )
      destination = (await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: destinationPath }))) as unknown as S3ObjectResponse
    }
    const destinationBytes = await readS3ObjectBytes(destination, 'Storage destination returned no body after relocation write')
    if (destinationBytes.byteLength !== asset.data.byteLength || createHash('sha256').update(destinationBytes).digest('hex') !== asset.contentSha256) {
      throw new Error('Storage destination does not contain the canonical asset bytes')
    }
    if (asset.sourcePath === asset.destinationPath) return
    let source: S3ObjectResponse
    try {
      source = (await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: sourcePath }))) as unknown as S3ObjectResponse
    } catch (error: unknown) {
      if (isS3NotFound(error)) return
      throw error
    }
    const sourceEtag = source.ETag
    if (typeof sourceEtag !== 'string' || sourceEtag.trim().length === 0 || sourceEtag === '*') {
      throw new Error('Storage source cannot be conditionally verified for relocation cleanup')
    }
    const sourceBytes = await readS3ObjectBytes(source, 'Storage source returned no body for relocation cleanup')
    if (sourceBytes.byteLength !== asset.data.byteLength || createHash('sha256').update(sourceBytes).digest('hex') !== asset.contentSha256) {
      throw new Error('Former storage location changed before relocation cleanup')
    }
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: sourcePath, IfMatch: sourceEtag }))
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
        .column(
          'id',
          'path',
          'localeCode',
          'title',
          'description',
          'contentType',
          'content',
          'sourceRevision',
          'authorId',
          'extra',
          'isPublished',
          'updatedAt',
          'createdAt',
          'editorKey'
        )
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
        const pageObject = await wiki.models.pages.query().findOne({ id: value.id })
        if (!pageObject) {
          throw new Error(`Page ${value.id} was not found during S3 export`)
        }
        const relatedTags = await pageObject.$relatedQuery('tags')
        if (!relatedTags.every((tag): tag is PageTag => isRecord(tag) && typeof tag.tag === 'string')) {
          throw new TypeError(`Invalid tags for page ${value.id}`)
        }
        const page = { ...value, tags: relatedTags }
        const filePath = getFilePath(page, 'path', this.config.pathPrefix, value.localeCode)
        wiki.logger.info(`(STORAGE/${this.storageName}) Adding page ${filePath}...`)
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: filePath,
            Body: serializePage(page)
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
