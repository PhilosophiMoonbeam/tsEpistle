declare const WIKI: Record<string, unknown>

import { Model } from 'objection'
import type { ModelOptions, QueryContext } from 'objection'
import type { Response } from 'express'
import type { Knex } from 'knex'
import moment from 'moment'
import path from 'node:path'
import { chmod, mkdtemp, mkdir, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import _ from 'lodash'
import assetHelper from '../helpers/asset.ts'
import User from './users.ts'
import AssetFolder, { AssetFolderHierarchyError } from './assetFolders.ts'
import {
  analyzeAssetBranding,
  hasAssetBrandingMetadata,
  type AssetBrandingAnalysisReservation,
  releaseAssetBrandingAnalysis,
  reserveAssetBrandingAnalysis,
  stripAssetBrandingMetadata,
  stripAssetBrandingMetadataRecord
} from '../helpers/asset-branding.ts'
import type { AssetBrandingMetadata } from '../../shared/page-branding.ts'
import {
  boundedImportAssetLimit,
  validateUploadLimit
} from '../modules/storage/import-budget.ts'
import type { StorageAssetIdentity, StorageLocalLocation } from '../modules/types.ts'
import { isStorageInternalPath, isStorageReservedPath } from '../modules/storage/internal-path.ts'
import { openStorageRoot, type StorageFileHandle, type StorageRootHandle } from '../modules/storage/local-filesystem.ts'

const uploadFlights = new Map<string, Promise<void>>()

const enqueueAssetUpload = (key: string, work: () => Promise<void>): Promise<void> => {
  const previous = uploadFlights.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(work)
  uploadFlights.set(key, current)
  void current
    .finally(() => {
      if (uploadFlights.get(key) === current) uploadFlights.delete(key)
    })
    .catch(() => undefined)
  return current
}

interface AssetUser {
  id: number
  name: string
  email: string
}

interface UploadOptions {
  originalname: string
  assetPath: string
  mimetype: string
  size: number
  folderId: number | null
  path: string
  mode: string
  user: AssetUser
  maxBytes?: number
  skipStorage?: boolean
}

interface AssetDataRow {
  data: Buffer
}

interface SourceHandle {
  root: StorageRootHandle
  file: StorageFileHandle
  relativePath: string
}

const storageRootPath = (name: 'cache' | 'uploads'): string =>
  path.resolve(wiki.ROOTPATH, wiki.config.dataPath, name)

const isMissing = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT'

const isDeniedAssetPath = (assetPath: string): boolean =>
  isStorageInternalPath(assetPath) || isStorageReservedPath(assetPath)

const isValidAssetIdentityField = (asset: Partial<Asset>): asset is Pick<Asset, 'id' | 'hash' | 'filename' | 'folderId'> => {
  const { id, folderId } = asset
  return typeof id === 'number' &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    typeof asset.hash === 'string' &&
    typeof asset.filename === 'string' &&
    asset.filename.length > 0 &&
    (folderId === null || (typeof folderId === 'number' && Number.isSafeInteger(folderId) && folderId >= 0))
}

const relativeStoragePath = (rootPath: string, candidatePath: string): string => {
  const relative = path.relative(rootPath, candidatePath).replace(/\\/g, '/')
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`Asset source path escapes the configured upload root: ${candidatePath}`)
  }
  return relative
}

async function openAssetSource (filePath: string, mode: string, expectedSize: number): Promise<SourceHandle> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new RangeError('Asset source size must be a non-negative safe integer')
  const rootPath = mode === 'upload' ? storageRootPath('uploads') : path.dirname(filePath)
  await mkdir(rootPath, { recursive: true, mode: 0o700 })
  const root = await openStorageRoot(rootPath)
  const relativePath = mode === 'upload' ? relativeStoragePath(rootPath, filePath) : path.basename(filePath)
  try {
    const file = await root.openFile(relativePath, { size: expectedSize })
    return { root, file, relativePath }
  } catch (error: unknown) {
    await root.close()
    throw error
  }
}

async function stageAssetSource (source: StorageFileHandle, maxBytes: number): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wiki-asset-upload-'))
  try {
    await chmod(directory, 0o700)
    const stagedPath = path.join(directory, 'asset')
    const staged = await open(stagedPath, 'wx', 0o600)
    try {
      const copied = await source.copyTo(staged, maxBytes)
      if (copied !== source.stats.size) throw new Error(`Asset source size changed: ${source.relativePath}`)
    } finally {
      await staged.close()
    }
    return { directory, path: stagedPath }
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function withStorageRoot<T> (rootPath: string, operation: (root: StorageRootHandle) => Promise<T>): Promise<T> {
  await mkdir(rootPath, { recursive: true, mode: 0o700 })
  const root = await openStorageRoot(rootPath)
  try {
    return await operation(root)
  } finally {
    await root.close()
  }
}

interface ByteRange {
  start: number
  end: number
}

function parseByteRange (value: unknown, size: number): ByteRange | null | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (!value.startsWith('bytes=')) return null
  const ranges = value.slice('bytes='.length).split(',')
  if (ranges.length !== 1) return null
  const range = ranges[0]
  if (!range) return null
  const separator = range.indexOf('-')
  if (separator < 0) return null
  const startText = range.slice(0, separator).trim()
  const endText = range.slice(separator + 1).trim()
  if (size < 1) return null
  if (startText.length === 0) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
  const end = endText.length === 0 ? size - 1 : Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

async function sendAssetBuffer (data: Buffer, res: Response): Promise<void> {
  const request = res.req
  const range = parseByteRange(request?.headers?.range, data.byteLength)
  if (range === null) {
    res.status(416).set('Content-Range', `bytes */${data.byteLength}`).end()
    return
  }
  if (range === undefined) {
    res.set('Content-Length', String(data.byteLength))
  } else {
    res.status(206)
      .set('Content-Range', `bytes ${range.start}-${range.end}/${data.byteLength}`)
      .set('Content-Length', String(range.end - range.start + 1))
  }
  if (request?.method === 'HEAD') {
    res.end()
    return
  }
  res.send(range === undefined ? data : data.subarray(range.start, range.end + 1))
}

async function sendAssetFile (source: StorageFileHandle, res: Response): Promise<void> {
  const range = parseByteRange(res.req?.headers?.range, source.stats.size)
  if (range === null) {
    res.status(416).set('Content-Range', `bytes */${source.stats.size}`).end()
    return
  }
  if (source.stats.size === 0) {
    res.set('Content-Length', '0')
    if (res.req?.method === 'HEAD') res.end()
    else res.end()
    return
  }
  const start = range?.start ?? 0
  const end = range?.end ?? source.stats.size - 1
  res.set('Content-Length', String(end - start + 1))
  if (range) res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${source.stats.size}`)
  if (res.req?.method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(source.handle.createReadStream({ start, end, autoClose: false }), res)
}

export default class Asset extends Model {
  declare id: number
  declare filename: string
  declare hash: string
  declare ext: string
  declare kind: string
  declare mime: string
  declare fileSize: number
  declare metadata: Record<string, unknown>
  declare authorId: number
  declare folderId: number | null
  declare createdAt: string
  declare updatedAt: string

  static override get tableName () {
    return 'assets'
  }

  static override get jsonSchema () {
    return {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filename: { type: 'string' },
        hash: { type: 'string' },
        ext: { type: 'string' },
        kind: { type: 'string' },
        mime: { type: 'string' },
        fileSize: { type: 'integer' },
        metadata: { type: 'object' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' }
      }
    }
  }

  static override get relationMappings () {
    return {
      author: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: { from: 'assets.authorId', to: 'users.id' }
      },
      folder: {
        relation: Model.BelongsToOneRelation,
        modelClass: AssetFolder,
        join: { from: 'assets.folderId', to: 'assetFolders.id' }
      }
    }
  }

  async getAssetPath (): Promise<string> {
    const hierarchy = this.folderId ? await wiki.models.assetFolders.getHierarchy(this.folderId) : []
    return this.folderId ? `${hierarchy.map(folder => folder.slug).join('/')}/${this.filename}` : this.filename
  }

  async deleteAssetCache (): Promise<void> {
    await withStorageRoot(storageRootPath('cache'), async root => {
      await root.removeFile(`${this.hash}.dat`)
    })
  }

  override async $beforeUpdate (opt: ModelOptions, context: QueryContext): Promise<void> {
    await super.$beforeUpdate(opt, context)
    this.updatedAt = moment.utc().toISOString()
  }

  override async $beforeInsert (context: QueryContext): Promise<void> {
    await super.$beforeInsert(context)
    this.createdAt = moment.utc().toISOString()
    this.updatedAt = moment.utc().toISOString()
  }

  static async upload (opts: UploadOptions): Promise<void> {
    const configuredLimit = validateUploadLimit(wiki.config?.uploads?.maxFileSize)
    const modeLimit = opts.mode === 'upload' ? configuredLimit : boundedImportAssetLimit(configuredLimit)
    if (opts.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0)) {
      throw new RangeError('Asset upload bound must be a non-negative safe integer')
    }
    const maxBytes = Math.min(modeLimit, opts.maxBytes ?? modeLimit)
    const fileInfo = path.parse(opts.originalname)
    const fileHash = assetHelper.generateHash(opts.assetPath)
    const assetRow: Partial<Asset> = {
      filename: opts.originalname,
      hash: fileHash,
      ext: fileInfo.ext,
      kind: _.startsWith(opts.mimetype, 'image/') ? 'image' : 'binary',
      mime: opts.mimetype,
      fileSize: opts.size,
      folderId: opts.folderId
    }

    await enqueueAssetUpload(fileHash, async () => {
      const source = await openAssetSource(opts.path, opts.mode, opts.size)
      let stagedDirectory: string | undefined
      try {
        const staged = await stageAssetSource(source.file, maxBytes)
        stagedDirectory = staged.directory
        if (wiki.config.uploads.scanSVG && (opts.mimetype.toLowerCase().startsWith('image/svg') || fileInfo.ext.toLowerCase() === '.svg')) {
          const svgSanitizeJob = await wiki.scheduler.registerJob({ name: 'sanitize-svg', immediate: true, worker: true }, staged.path)
          await svgSanitizeJob.finished
        }

        const fileBuffer = await withStorageRoot(staged.directory, async root => {
          const stagedFile = await root.openFile('asset')
          try {
            return await stagedFile.readBounded(maxBytes)
          } finally {
            await stagedFile.close()
          }
        })
        const insertedRow = { ...assetRow, authorId: opts.user.id }
        const updatedRow = { ...(opts.mode === 'upload' ? insertedRow : assetRow), updatedAt: moment.utc().toISOString() }
        let reservation: AssetBrandingAnalysisReservation | undefined
        try {
          const persisted = await wiki.models.knex.transaction(async transaction => {
            const current = (await transaction('assets').where({ hash: fileHash }).forUpdate().first('id', 'metadata')) as
              | { id: number; metadata?: unknown }
              | undefined
            let branding: AssetBrandingMetadata | undefined
            if (current && hasAssetBrandingMetadata(current.metadata)) {
              reservation = reserveAssetBrandingAnalysis(current.id)
              branding = await analyzeAssetBranding(fileBuffer)
            }
            const persistedAsset = (await wiki.models.assets.query(transaction).insert(insertedRow).onConflict('hash').merge(updatedRow).returning('*')) as Asset
            const metadata = stripAssetBrandingMetadataRecord(current?.metadata)
            if (branding) metadata.branding = branding
            await transaction('assets').where({ id: persistedAsset.id }).update({ metadata: JSON.stringify(metadata) })
            await transaction('assetData').insert({ id: persistedAsset.id, data: fileBuffer }).onConflict('id').merge({ data: fileBuffer })
            return { asset: persistedAsset }
          })

          await withStorageRoot(storageRootPath('cache'), async root => {
            await root.writeAtomic(`${fileHash}.dat`, fileBuffer)
          })
          if (opts.mode === 'upload') await source.root.removeFile(source.relativePath)

          if (!opts.skipStorage) {
            await wiki.models.storage.assetEvent({
              event: 'uploaded',
              asset: {
                ...persisted.asset,
                metadata: stripAssetBrandingMetadata(persisted.asset.metadata),
                path: await persisted.asset.getAssetPath(),
                data: fileBuffer,
                authorId: opts.user.id,
                authorName: opts.user.name,
                authorEmail: opts.user.email
              }
            })
          }
        } finally {
          releaseAssetBrandingAnalysis(reservation)
        }
      } finally {
        if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true })
        await source.file.close()
        await source.root.close()
      }
    })
  }

  private static async resolveAssetIdentity (assetPath: string): Promise<StorageAssetIdentity | null> {
    if (isDeniedAssetPath(assetPath)) return null
    const requestedHash = assetHelper.generateHash(assetPath)
    const asset = await wiki.models.assets.query().where('hash', requestedHash).first() as Asset | undefined
    if (!asset || !isValidAssetIdentityField(asset) || asset.hash !== requestedHash) return null
    if (
      asset.filename.includes('/') ||
      asset.filename.includes('\\') ||
      asset.filename.includes('\0') ||
      asset.filename === '.' ||
      asset.filename === '..'
    ) return null

    let hierarchy: Array<{ slug: string }> = []
    if (asset.folderId !== null && asset.folderId !== 0) {
      try {
        hierarchy = await wiki.models.assetFolders.getHierarchy(asset.folderId)
      } catch (error: unknown) {
        if (error instanceof AssetFolderHierarchyError) return null
        throw error
      }
    }
    if (!hierarchy.every(folder =>
      typeof folder.slug === 'string' &&
      folder.slug.length > 0 &&
      folder.slug !== '.' &&
      folder.slug !== '..' &&
      !folder.slug.includes('/') &&
      !folder.slug.includes('\\') &&
      !folder.slug.includes('\0')
    )) return null

    const canonicalPath = hierarchy.length === 0
      ? asset.filename
      : `${hierarchy.map(folder => folder.slug).join('/')}/${asset.filename}`
    if (canonicalPath !== assetPath || asset.hash !== assetHelper.generateHash(canonicalPath) || isDeniedAssetPath(canonicalPath)) return null
    return {
      id: asset.id,
      hash: asset.hash,
      path: canonicalPath,
      filename: asset.filename,
      folderId: asset.folderId
    }
  }

  static async getAsset (assetPath: string, res: Response): Promise<void> {
    try {
      const identity = await this.resolveAssetIdentity(assetPath)
      if (!identity) {
        res.sendStatus(404)
        return
      }
      const fileInfo = assetHelper.getPathInfo(identity.path)
      if (wiki.config.uploads.forceDownload && !['.png', '.apng', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(fileInfo.ext)) {
        res.set('Content-disposition', `attachment; filename=${encodeURIComponent(fileInfo.base)}`)
      }
      res.type(fileInfo.ext)
      res.set('Accept-Ranges', 'bytes')
      if (await this.getAssetFromCache(identity, res)) return
      if (await this.getAssetFromStorage(identity, res)) return
      await this.getAssetFromDb(identity, res)
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err.code === 'ECONNABORTED' || err.code === 'EPIPE')) return
      wiki.logger.error(err)
      if (!res.headersSent) res.sendStatus(500)
    }
  }

  static async getAssetFromCache (identity: StorageAssetIdentity, res: Response): Promise<boolean> {
    if (isDeniedAssetPath(identity.path)) return false
    return await withStorageRoot(storageRootPath('cache'), async root => {
      let source: StorageFileHandle
      try {
        source = await root.openFile(`${identity.hash}.dat`)
      } catch (error: unknown) {
        if (isMissing(error)) return false
        throw error
      }
      try {
        await sendAssetFile(source, res)
        return true
      } finally {
        await source.close()
      }
    })
  }

  static async getAssetFromStorage (identity: StorageAssetIdentity, res: Response): Promise<boolean> {
    if (isDeniedAssetPath(identity.path)) return false
    const localLocations = await wiki.models.storage.getLocalLocations({ asset: identity })
    for (const location of _.filter(localLocations, candidate => Boolean(candidate.location))) {
      let source: StorageFileHandle
      try {
        source = await location.location.open()
      } catch (error: unknown) {
        if (isMissing(error)) continue
        throw error
      }
      try {
        await sendAssetFile(source, res)
        return true
      } finally {
        await source.close()
      }
    }
    return false
  }

  static async getAssetFromDb (identity: StorageAssetIdentity, res: Response): Promise<void> {
    if (isDeniedAssetPath(identity.path)) {
      res.sendStatus(404)
      return
    }
    const assetData = await wiki.models.knex<AssetDataRow>('assetData').where('id', identity.id).first()
    if (!assetData) {
      res.sendStatus(404)
      return
    }
    await withStorageRoot(storageRootPath('cache'), async root => {
      await root.writeAtomic(`${identity.hash}.dat`, assetData.data)
    })
    await sendAssetBuffer(assetData.data, res)
  }

  static async flushTempUploads (): Promise<void> {
    await withStorageRoot(storageRootPath('uploads'), async root => {
      await root.purgeContents()
    })
  }
}

const wiki = WIKI as unknown as {
  ROOTPATH: string
  config: {
    dataPath: string
    uploads: { maxFileSize: number; scanSVG: boolean; forceDownload: boolean }
  }
  logger: { warn: (error: unknown) => void; error: (error: unknown) => void }
  scheduler: { registerJob: (definition: { name: string; immediate: boolean; worker: boolean }, path: string) => Promise<{ finished: Promise<unknown> }> }
  models: {
    assets: typeof Asset
    assetFolders: typeof AssetFolder
    knex: Knex
    storage: {
      assetEvent: (event: { event: string; asset: Record<string, unknown> }) => Promise<void>
      getLocalLocations: (event: { asset: StorageAssetIdentity }) => Promise<Array<{ location: StorageLocalLocation; key: string }>>
    }
  }
}
