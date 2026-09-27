declare const WIKI: Record<string, unknown>

import _ from 'lodash'
import sanitize from 'sanitize-filename'
import type { Knex } from 'knex'
import { randomUUID, createHash } from 'node:crypto'

import { enqueueAssetRelocationEffect } from '../jobs/asset-relocation.ts'
import { assertAssetLocationAssetSettled, assertAssetLocationReservations, lockAssetLocation, withAssetLocationLocks } from '../helpers/asset-location-lock.ts'
import assetHelper from '../helpers/asset.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import type { PagePrincipal } from '../helpers/page-access.ts'

import { AssetFolderHierarchyError } from '../models/assetFolders.ts'
import { resolveAssetBrandingView, stripAssetBrandingMetadata } from '../helpers/asset-branding.ts'
import type { PageBrandingView } from '../../shared/page-branding.ts'
import {
  AssetImageTransformError,
  transformAssetImage,
  type AssetImageAnimationPolicy,
  type AssetImageAspectPolicy,
  type AssetImageFormat,
  type AssetImageTransformOptions,
  type AssetImageTransformResult
} from '../helpers/asset-image-transform.ts'
import brandingErrors from './errors.ts'

const { ApplicationError } = brandingErrors

interface Requester extends Record<string, unknown> {
  id: number
  name: string
  email: string
}
interface Asset extends Record<string, unknown> {
  id: number
  filename: string
  hash: string
  kind: string
  ext: string
  folderId: number | null
  mime?: string
  fileSize?: number
  metadata?: unknown
  createdAt?: string | Date
  updatedAt?: string | Date
  deleteAssetCache(): Promise<unknown>
  getAssetPath(): Promise<string>
}

interface Folder extends Record<string, unknown> {
  id: number
  slug: string
  parentId: number | null
}
interface Query<Row> extends PromiseLike<Row[]> {
  where(condition: Record<string, unknown> | string, value?: unknown): Query<Row>
  whereNull(column: string): Query<Row>
  forUpdate(): Query<Row>
  first(): Promise<Row | undefined>
  findById(id: number): Promise<Row | undefined>
  insert(data: Record<string, unknown>): Promise<unknown>
  patch(data: Record<string, unknown>): { findById(id: number): Promise<unknown> }
  deleteById(id: number): Promise<unknown>
}
interface StorageTarget {
  key: string
  configurationKey: string
  active: boolean
  paused: boolean
  supportsAssetRelocation?: boolean
}
interface Models {
  assets: {
    query(transaction?: Knex.Transaction): Query<Asset>
    flushTempUploads(): unknown
    deleteAssetCaches?(hashes: readonly string[]): Promise<unknown>
  }
  assetFolders: { query(transaction?: Knex.Transaction): Query<Folder>; getHierarchy(id: number, transaction?: Knex.Transaction): Promise<Folder[]> }
  storage: {
    assetEvent(event: Record<string, unknown>): Promise<unknown>
    runtimeTargets?(): StorageTarget[]
    relocationTargets?(): StorageTarget[]
  }
  knex: Knex
}
interface WikiErrors {
  AssetFolderExists: new () => Error
  AssetInvalid: new () => Error
  AssetRenameInvalidExt: new () => Error
  AssetRenameInvalid: new () => Error
  AssetRenameCollision: new () => Error
  AssetRenameForbidden: new () => Error
  AssetRenameTargetForbidden: new () => Error
  AssetDeleteForbidden: new () => Error
}
const models = WIKI.models as unknown as Models

const getAuth = (): {
  checkAccess(requester: Requester, permissions: readonly string[]): boolean
  checkPageAccess(requester: Requester, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
  loadPageRuleAuthority(requester: Requester, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
} =>
  WIKI.auth as {
    checkAccess(requester: Requester, permissions: readonly string[]): boolean
    checkPageAccess(requester: Requester, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
    loadPageRuleAuthority(requester: Requester, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
const errors = WIKI.Error as unknown as WikiErrors
const runtime = WIKI as unknown as { config?: { db?: { type?: string } } }
const ASSET_FOLDER_DESTINATION_LOCK = 0x4153464c
const logRelocationCacheCleanupFailure = (): void => {
  try {
    const logger = WIKI.logger
    if (!logger || typeof logger !== 'object' || !('warn' in logger) || typeof logger.warn !== 'function') return
    logger.warn('Asset relocation committed, but cache cleanup could not be completed. The relocation receipt remains valid.')
  } catch {
    // Cache cleanup and logging are best effort after the relocation transaction commits.
  }
}


const invalidFolderSlug = () => new ApplicationError('Folder slug must be a canonical non-empty path segment.', { status: 400, code: 'ASSET_FOLDER_INVALID' })

const normalizeFolderSlug = (value: string): string => {
  let sanitized: string
  try {
    sanitized = sanitize(value)
  } catch {
    throw invalidFolderSlug()
  }
  const folderSlug = sanitized.trim().toLowerCase()
  if (folderSlug.length === 0 || folderSlug === '.' || folderSlug === '..' || folderSlug.includes('/') || folderSlug.includes('\\')) {
    throw invalidFolderSlug()
  }
  return folderSlug
}

const folderCreationForbidden = () =>
  new ApplicationError('You are not authorized to create this asset folder.', {
    status: 403,
    code: 'ASSET_FOLDER_FORBIDDEN'
  })

const assertCompleteHierarchy = (hierarchy: readonly Folder[], parentId: number): void => {
  if (hierarchy.length === 0 || hierarchy[hierarchy.length - 1]?.id !== parentId) {
    throw new AssetFolderHierarchyError('incomplete', parentId)
  }
  for (let index = 0; index < hierarchy.length; index += 1) {
    const folder = hierarchy[index]
    const expectedParentId = index === 0 ? null : hierarchy[index - 1]?.id
    if (
      !folder ||
      !Number.isSafeInteger(folder.id) ||
      folder.id < 1 ||
      typeof folder.slug !== 'string' ||
      folder.slug.length === 0 ||
      folder.parentId !== expectedParentId
    ) {
      const failureId = folder && Number.isSafeInteger(folder.id) ? folder.id : parentId
      throw new AssetFolderHierarchyError('incomplete', failureId)
    }
  }
}

const lockParentChain = async (transaction: Knex.Transaction, hierarchy: readonly Folder[]): Promise<void> => {
  const ancestorIds = [...new Set(hierarchy.map(folder => folder.id))].sort((left, right) => left - right)
  if (ancestorIds.length !== hierarchy.length || ancestorIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new AssetFolderHierarchyError('incomplete', hierarchy.at(-1)?.id ?? 0)
  }
  const expectedById = new Map(hierarchy.map(folder => [folder.id, folder]))
  for (const id of ancestorIds) {
    const locked = await models.assetFolders.query(transaction).where({ id }).forUpdate().first()
    const expected = expectedById.get(id)
    if (!locked || !expected || locked.id !== expected.id || locked.slug !== expected.slug || locked.parentId !== expected.parentId) {
      throw new AssetFolderHierarchyError('disappeared', id)
    }
  }
}
const lockFolderChains = async (transaction: Knex.Transaction, hierarchies: readonly (readonly Folder[])[]): Promise<void> => {
  const expectedById = new Map<number, Folder>()
  for (const hierarchy of hierarchies) {
    for (const folder of hierarchy) {
      const existing = expectedById.get(folder.id)
      if (existing && (existing.slug !== folder.slug || existing.parentId !== folder.parentId)) {
        throw new AssetFolderHierarchyError('disappeared', folder.id)
      }
      expectedById.set(folder.id, folder)
    }
  }
  const ancestorIds = [...expectedById.keys()].sort((left, right) => left - right)
  for (const id of ancestorIds) {
    const locked = await models.assetFolders.query(transaction).where({ id }).forUpdate().first()
    const expected = expectedById.get(id)
    if (!locked || !expected || locked.id !== expected.id || locked.slug !== expected.slug || locked.parentId !== expected.parentId) {
      throw new AssetFolderHierarchyError('disappeared', id)
    }
  }
}

const lockFolderDestination = async (transaction: Knex.Transaction, destinationPath: string): Promise<void> => {
  if (runtime.config?.db?.type !== 'postgres' || typeof transaction.raw !== 'function') return
  await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ASSET_FOLDER_DESTINATION_LOCK, destinationPath])
}

const list = async ({ requester, folderId, kind }: { requester: Requester; folderId: number; kind: string }) => {
  const query = models.assets.query()
  if (folderId === 0) query.whereNull('folderId')
  else query.where('folderId', folderId)
  if (kind !== 'ALL') query.where('kind', kind.toLowerCase())
  const hierarchy = await models.assetFolders.getHierarchy(folderId)
  const folderPath = hierarchy.map(folder => folder.slug).join('/')
  const assets = await query
  const auth = getAuth()
  const authority = await auth.loadPageRuleAuthority(requester)
  return assets
    .filter(asset =>
      auth.checkPageAccess(requester, ['manage:system', 'read:assets'], { path: folderPath ? `${folderPath}/${asset.filename}` : asset.filename }, authority)
    )
    .map(asset => {
      const projected = { ...asset, kind: asset.kind.toUpperCase() }
      if (Object.hasOwn(asset, 'metadata')) projected.metadata = stripAssetBrandingMetadata(asset.metadata)
      return projected
    })
}

const getBranding = async (input: {
  requester: Requester
  id: number
  sessionId: string
  deriveIfMissing?: boolean
}): Promise<{ branding: PageBrandingView }> => {
  const branding = await resolveAssetBrandingView({
    assetId: input.id,
    requester: input.requester as PagePrincipal,
    sessionId: input.sessionId,
    deriveIfMissing: input.deriveIfMissing === true
  })
  if (!branding) throw new ApplicationError('Asset branding is unavailable', { status: 404, code: 'BRANDING_UNAVAILABLE' })
  return { branding }
}

const listFolders = async ({ requester, parentFolderId }: { requester: Requester; parentFolderId: number }) => {
  const query = models.assetFolders.query()
  if (parentFolderId === 0) query.whereNull('parentId')
  else query.where('parentId', parentFolderId)
  const folders = await query
  const hierarchy = await models.assetFolders.getHierarchy(parentFolderId)
  const parentPath = hierarchy.map(folder => folder.slug).join('/')
  const auth = getAuth()
  const authority = await auth.loadPageRuleAuthority(requester)
  return folders.filter(folder =>
    auth.checkPageAccess(requester, ['manage:system', 'read:assets'], { path: parentPath ? `${parentPath}/${folder.slug}` : folder.slug }, authority)
  )
}

const createFolder = async ({ requester, slug, parentFolderId }: { requester: Requester; slug: string; parentFolderId: number }): Promise<void> => {
  const folderSlug = normalizeFolderSlug(slug)
  if (!Number.isSafeInteger(parentFolderId) || parentFolderId < 0) {
    throw new ApplicationError('parentFolderId must be a non-negative integer.', { status: 400, code: 'ASSET_FOLDER_PARENT_INVALID' })
  }
  const parentId = parentFolderId === 0 ? null : parentFolderId

  await models.knex.transaction(async transaction => {
    const auth = getAuth()
    const authority = await auth.loadPageRuleAuthority(requester, transaction)
    let hierarchy: readonly Folder[] = []
    try {
      hierarchy = parentId === null ? [] : await models.assetFolders.getHierarchy(parentId, transaction)
      if (parentId !== null) assertCompleteHierarchy(hierarchy, parentId)
      await lockParentChain(transaction, hierarchy)
    } catch (error: unknown) {
      if (error instanceof AssetFolderHierarchyError) throw folderCreationForbidden()
      throw error
    }
    const parentPath = hierarchy.map(folder => folder.slug).join('/')
    const destinationPath = parentPath ? `${parentPath}/${folderSlug}` : folderSlug
    if (!auth.checkPageAccess(requester, ['manage:system', 'write:assets'], { path: destinationPath }, authority)) {
      throw folderCreationForbidden()
    }

    await lockFolderDestination(transaction, destinationPath)
    const query = models.assetFolders.query(transaction).where({ slug: folderSlug })
    const existing = (parentId === null ? query.whereNull('parentId') : query.where('parentId', parentId)).first()
    if (await existing) throw new errors.AssetFolderExists()
    await models.assetFolders.query(transaction).insert({ slug: folderSlug, name: folderSlug, parentId })
  })
}

export interface AssetRelocationReceipt {
  id: string
  assetId: number
  sourcePath: string
  destinationPath: string
  status: 'pending' | 'leased' | 'succeeded' | 'failed' | 'superseded'
  statusUrl: string
  effects: Array<{ id: string; targetKey: string; status: string; lastError: string | null }>
}

interface AssetDataRow {
  data: Buffer | Uint8Array | string
}

const normalizeAssetFilename = (value: unknown): string => {
  if (typeof value !== 'string') throw new errors.AssetRenameInvalid()
  let filename: string
  try {
    filename = sanitize(value).trim().toLowerCase()
  } catch {
    throw new errors.AssetRenameInvalid()
  }
  if (!filename || filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    throw new errors.AssetRenameInvalid()
  }
  return filename
}

const relocationBytes = (data: unknown): Buffer => {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  throw new errors.AssetInvalid()
}
const imageResizeMime: Record<AssetImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

const imageResizeExtensions: Record<AssetImageFormat, readonly string[]> = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  webp: ['.webp'],
  gif: ['.gif']
}

const imageResizeUnavailable = () =>
  new ApplicationError('This asset does not exist or is not available for image transformation.', {
    status: 404,
    code: 'ASSET_IMAGE_SOURCE_UNAVAILABLE'
  })
const imageResizeDestinationForbidden = () =>
  new ApplicationError('You are not authorized to write to the requested asset destination.', {
    status: 403,
    code: 'ASSET_IMAGE_DESTINATION_FORBIDDEN'
  })
const imageResizeConflict = () =>
  new ApplicationError('An asset already exists at the requested destination.', {
    status: 409,
    code: 'ASSET_IMAGE_DESTINATION_CONFLICT'
  })
const imageResizeStale = () =>
  new ApplicationError('The source asset changed during image transformation. Refresh and try again.', {
    status: 409,
    code: 'ASSET_IMAGE_SOURCE_STALE'
  })
const imageResizeInputError = (message: string) =>
  new ApplicationError(message, { status: 400, code: 'ASSET_IMAGE_INPUT_INVALID' })

const assetRowBytes = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'base64')
  throw imageResizeUnavailable()
}

const assetVersionTime = (value: unknown): string => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  return typeof value === 'string' ? value : ''
}

const assetFolderPath = async (folderId: number | null, transaction: Knex.Transaction): Promise<string> => {
  const hierarchy = folderId === null ? [] : await models.assetFolders.getHierarchy(folderId, transaction)
  if (folderId !== null) assertCompleteHierarchy(hierarchy, folderId)
  await lockFolderChains(transaction, [hierarchy])
  return hierarchy.map(folder => folder.slug).join('/')
}

type AssetImageResizeInput = {
  requester: Requester
  id: number
  destination: { filename: string; folderId: number | null }
  width: number
  height: number
  aspectPolicy: AssetImageAspectPolicy
  format: AssetImageFormat
  quality: number
  animationPolicy: AssetImageAnimationPolicy
}

type AssetImageResizeReceipt = {
  status: 'succeeded'
  assetId: number
  destinationPath: string
  width: number
  height: number
  format: AssetImageFormat
  frames: number
  fileSize: number
  sourceSha256: string
}

const resizeImage = async ({
  requester,
  id,
  destination,
  width,
  height,
  aspectPolicy,
  format,
  quality,
  animationPolicy
}: AssetImageResizeInput): Promise<AssetImageResizeReceipt> => {
  if (!Number.isSafeInteger(id) || id < 1) throw imageResizeUnavailable()
  if (
    !destination ||
    typeof destination.filename !== 'string' ||
    (destination.folderId !== null && (!Number.isSafeInteger(destination.folderId) || destination.folderId < 0))
  ) {
    throw imageResizeInputError('A valid destination filename and folder are required.')
  }
  const filename = normalizeAssetFilename(destination.filename)
  if (filename.length > 255) throw imageResizeInputError('The destination filename must be 255 characters or fewer.')
  if (!imageResizeExtensions[format]?.includes(filename.slice(filename.lastIndexOf('.')).toLowerCase())) {
    throw imageResizeInputError('The destination filename extension must match the selected output format.')
  }
  const folderId = destination.folderId === null || destination.folderId === 0 ? null : destination.folderId

  const snapshot = await models.knex.transaction(async transaction => {
    const asset = await models.assets.query(transaction).where({ id }).first()
    if (!asset) throw imageResizeUnavailable()
    let sourceFolderPath: string
    try {
      sourceFolderPath = await assetFolderPath(asset.folderId === null || asset.folderId === 0 ? null : asset.folderId, transaction)
    } catch (error: unknown) {
      if (error instanceof AssetFolderHierarchyError) throw imageResizeUnavailable()
      throw error
    }
    const sourcePath = sourceFolderPath ? `${sourceFolderPath}/${asset.filename}` : asset.filename
    const auth = getAuth()
    const authority = await auth.loadPageRuleAuthority(requester, transaction)
    if (!auth.checkPageAccess(requester, ['read:assets'], { path: sourcePath }, authority)) throw imageResizeUnavailable()
    let destinationFolderPath: string
    try {
      destinationFolderPath = await assetFolderPath(folderId, transaction)
    } catch (error: unknown) {
      if (error instanceof AssetFolderHierarchyError) throw imageResizeDestinationForbidden()
      throw error
    }
    const preflightDestinationPath = destinationFolderPath ? `${destinationFolderPath}/${filename}` : filename
    if (preflightDestinationPath.length > 512) throw imageResizeInputError('The destination asset path is too long.')
    if (!auth.checkPageAccess(requester, ['write:assets'], { path: preflightDestinationPath }, authority)) {
      throw imageResizeDestinationForbidden()
    }
    await assertAssetLocationAssetSettled(transaction, asset.id)
    const dataRow = await transaction<AssetDataRow>('assetData').where('id', id).first('data')
    if (!dataRow) throw imageResizeUnavailable()
    const bytes = assetRowBytes(dataRow.data)
    return {
      sourcePath,
      asset: {
        id: asset.id,
        filename: asset.filename,
        hash: asset.hash,
        folderId: asset.folderId === 0 ? null : asset.folderId,
        updatedAt: assetVersionTime(asset.updatedAt)
      },
      bytes,
      sourceSha256: createHash('sha256').update(bytes).digest('hex')
    }
  })

  let transformed: AssetImageTransformResult
  try {
    transformed = await transformAssetImage(snapshot.bytes, {
      width,
      height,
      aspectPolicy,
      format,
      quality,
      animationPolicy
    } satisfies AssetImageTransformOptions)
  } catch (error: unknown) {
    if (!(error instanceof AssetImageTransformError)) throw error
    const status =
      error.code === 'ASSET_IMAGE_TOO_LARGE' || error.code === 'ASSET_IMAGE_OUTPUT_TOO_LARGE'
        ? 413
        : error.code === 'ASSET_IMAGE_UNSUPPORTED'
          ? 415
          : error.code === 'ASSET_IMAGE_PROCESSING_LIMIT'
            ? 422
            : 400
    throw new ApplicationError(error.message, { status, code: error.code })
  }

  const filenameExtension = filename.slice(filename.lastIndexOf('.')).toLowerCase()

  const published = await withAssetLocationLocks(
    ['assets', snapshot.sourcePath],
    async assertHeld => {
      await assertHeld?.()
      const asset = await models.knex.transaction(async transaction => {
        const current = await models.assets.query(transaction).where({ id }).forUpdate().first()
        if (!current) throw imageResizeStale()
        let sourceFolderPath: string
        try {
          sourceFolderPath = await assetFolderPath(current.folderId === null || current.folderId === 0 ? null : current.folderId, transaction)
        } catch (error: unknown) {
          if (error instanceof AssetFolderHierarchyError) throw imageResizeStale()
          throw error
        }
        const currentSourcePath = sourceFolderPath ? `${sourceFolderPath}/${current.filename}` : current.filename
        let targetFolderPath: string
        try {
          targetFolderPath = await assetFolderPath(folderId, transaction)
        } catch (error: unknown) {
          if (error instanceof AssetFolderHierarchyError) throw imageResizeDestinationForbidden()
          throw error
        }
        const destinationPath = targetFolderPath ? `${targetFolderPath}/${filename}` : filename
        if (destinationPath.length > 512) throw imageResizeInputError('The destination asset path is too long.')
        if (currentSourcePath !== snapshot.sourcePath) throw imageResizeStale()

        const auth = getAuth()
        const authority = await auth.loadPageRuleAuthority(requester, transaction)
        if (!auth.checkPageAccess(requester, ['read:assets'], { path: currentSourcePath }, authority)) throw imageResizeUnavailable()
        if (!auth.checkPageAccess(requester, ['write:assets'], { path: destinationPath }, authority)) {
          throw imageResizeDestinationForbidden()
        }

        await lockAssetLocation(transaction, currentSourcePath)
        await lockAssetLocation(transaction, destinationPath)
        await lockFolderDestination(transaction, destinationPath)
        await assertAssetLocationAssetSettled(transaction, current.id)
        await assertAssetLocationReservations(transaction, [currentSourcePath, destinationPath])

        const currentData = await transaction<AssetDataRow>('assetData').where('id', id).first('data')
        if (!currentData) throw imageResizeStale()
        const currentBytes = assetRowBytes(currentData.data)
        if (
          current.filename !== snapshot.asset.filename ||
          current.hash !== snapshot.asset.hash ||
          (current.folderId === 0 ? null : current.folderId) !== snapshot.asset.folderId ||
          assetVersionTime(current.updatedAt) !== snapshot.asset.updatedAt ||
          createHash('sha256').update(currentBytes).digest('hex') !== snapshot.sourceSha256
        ) {
          throw imageResizeStale()
        }

        const destinationHash = assetHelper.generateHash(destinationPath)
        const collision = await transaction('assets').where({ hash: destinationHash }).first('id')
        if (collision) throw imageResizeConflict()
        const existing = folderId === null
          ? await transaction('assets').where({ filename }).whereNull('folderId').first('id') ??
            await transaction('assets').where({ filename, folderId: 0 }).first('id')
          : await transaction('assets').where({ filename, folderId }).first('id')
        if (existing) throw imageResizeConflict()

        const now = new Date().toISOString()
        const inserted = await transaction('assets')
          .insert({
            filename,
            hash: destinationHash,
            ext: filenameExtension,
            kind: 'image',
            mime: imageResizeMime[format],
            fileSize: transformed.data.length,
            metadata: JSON.stringify({}),
            authorId: requester.id,
            folderId,
            createdAt: now,
            updatedAt: now
          })
          .returning('*')
        const row = Array.isArray(inserted) ? inserted[0] : inserted
        const createdAssetId = Number(typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : row)
        if (!Number.isSafeInteger(createdAssetId) || createdAssetId < 1) {
          throw new ApplicationError('The resized asset could not be persisted.', { status: 503, code: 'ASSET_IMAGE_PERSISTENCE_FAILED' })
        }
        await transaction('assetData').insert({ id: createdAssetId, data: transformed.data })
        return {
          id: createdAssetId,
          filename,
          hash: destinationHash,
          ext: filenameExtension,
          kind: 'image',
          mime: imageResizeMime[format],
          fileSize: transformed.data.length,
          metadata: {},
          authorId: requester.id,
          createdAt: now,
          updatedAt: now,
          path: destinationPath
        }
      })

      let publicationStarted = false
      try {
        await assertHeld?.()
        if (models.assets.deleteAssetCaches) await models.assets.deleteAssetCaches([asset.hash])
        publicationStarted = true
        await models.storage.assetEvent({
          event: 'uploaded',
          asset: {
            ...asset,
            data: transformed.data,
            authorName: requester.name,
            authorEmail: requester.email
          }
        })
        await assertHeld?.()
      } catch {
        if (publicationStarted) {
          try {
            await models.storage.assetEvent({
              event: 'deleted',
              asset: {
                ...asset,
                authorName: requester.name,
                authorEmail: requester.email
              }
            })
          } catch {
            // Storage cleanup is best effort after a failed new-asset publication.
          }
        }
        try {
          if (models.assets.deleteAssetCaches) await models.assets.deleteAssetCaches([asset.hash])
        } catch {
          // Cache cleanup is retried independently from canonical-row rollback.
        }
        try {
          await models.knex.transaction(async transaction => {
            await transaction('assetData').where({ id: asset.id }).delete()
            await transaction('assets').where({ id: asset.id, hash: asset.hash }).delete()
          })
        } catch {
          // Keep the request unsuccessful if canonical-row rollback cannot complete.
        }
        throw new ApplicationError('The resized asset could not be published.', { status: 503, code: 'ASSET_IMAGE_PUBLICATION_FAILED' })
      }

      return {
        status: 'succeeded' as const,
        assetId: asset.id,
        destinationPath: asset.path,
        width: transformed.width,
        height: transformed.height,
        format: transformed.format,
        frames: transformed.frames,
        fileSize: transformed.data.length,
        sourceSha256: snapshot.sourceSha256
      }
    },
    models.knex
  )
  return published
}

const relocationNotFound = (): InstanceType<typeof ApplicationError> =>
  new ApplicationError('Asset relocation was not found.', { status: 404, code: 'ASSET_RELOCATION_NOT_FOUND' })
const relocationFailureMessage = 'Storage target reconciliation failed.'

const relocationReceipt = async (
  operationId: string,
  requester: Requester,
  transaction: Knex | Knex.Transaction = models.knex
): Promise<AssetRelocationReceipt> => {
  const operation = await transaction('assetRelocationOperations')
    .where({ id: operationId })
    .first('id', 'assetId', 'actorId', 'sourcePath', 'destinationPath', 'status')
  if (!operation) throw relocationNotFound()

  const auth = getAuth()
  const systemManager = auth.checkAccess(requester, ['manage:system'])
  if (!systemManager) {
    if (!auth.checkAccess(requester, ['manage:assets']) || Number(operation.actorId) !== requester.id) throw relocationNotFound()
    const authority = await auth.loadPageRuleAuthority(requester)
    if (
      !auth.checkPageAccess(requester, ['manage:assets'], { path: String(operation.sourcePath) }, authority) ||
      !auth.checkPageAccess(requester, ['write:assets'], { path: String(operation.destinationPath) }, authority)
    ) {
      throw relocationNotFound()
    }
  }

  const effects = await transaction('assetRelocationEffects')
    .where({ operationId })
    .select('id', 'targetKey', 'status', 'lastError')
    .orderBy('targetKey', 'asc')
    .orderBy('id', 'asc')
  return {
    id: String(operation.id),
    assetId: Number(operation.assetId),
    sourcePath: String(operation.sourcePath),
    destinationPath: String(operation.destinationPath),
    status: String(operation.status) as AssetRelocationReceipt['status'],
    statusUrl: `/_api/assets/relocations/${encodeURIComponent(String(operation.id))}`,
    effects: effects.map(effect => ({
      id: String(effect.id),
      targetKey: String(effect.targetKey),
      status: String(effect.status),
      lastError: typeof effect.lastError === 'string' && effect.lastError.length > 0 ? relocationFailureMessage : null
    }))
  }
}

const relocate = async ({
  requester,
  id,
  filename: requestedFilename,
  folderId: requestedFolderId
}: {
  requester: Requester
  id: number
  filename?: string | null
  folderId?: number | null
}): Promise<AssetRelocationReceipt> => {
  if (requestedFilename === undefined && requestedFolderId === undefined) {
    throw new ApplicationError('Asset filename or folderId is required.', { status: 400, code: 'ASSET_RELOCATION_INPUT' })
  }
  if (!Number.isSafeInteger(id) || id < 1) throw new errors.AssetInvalid()
  const filenameInput = requestedFilename === undefined || requestedFilename === null ? undefined : normalizeAssetFilename(requestedFilename)
  if (requestedFilename === null) throw new errors.AssetRenameInvalid()
  if (requestedFolderId !== undefined && requestedFolderId !== null && (!Number.isSafeInteger(requestedFolderId) || requestedFolderId < 0)) {
    throw new ApplicationError('folderId must be a non-negative integer.', { status: 400, code: 'ASSET_FOLDER_INVALID' })
  }

  const result = await withAssetLocationLocks(
    ['assets'],
    async assertHeld => {
      await assertHeld?.()
      const result = await models.knex.transaction(async transaction => {
        const asset = await models.assets.query(transaction).where({ id }).forUpdate().first()
        if (!asset) throw new errors.AssetInvalid()
        const sourceFolderId = asset.folderId === null || asset.folderId === 0 ? null : asset.folderId
        let sourceHierarchy: Folder[] = []
        try {
          sourceHierarchy = sourceFolderId === null ? [] : await models.assetFolders.getHierarchy(sourceFolderId, transaction)
          if (sourceFolderId !== null) assertCompleteHierarchy(sourceHierarchy, sourceFolderId)
          await lockFolderChains(transaction, [sourceHierarchy])
        } catch (error: unknown) {
          if (error instanceof AssetFolderHierarchyError) throw new errors.AssetInvalid()
          throw error
        }
        const sourceFolderPath = sourceHierarchy.map(folder => folder.slug).join('/')
        const sourcePath = sourceFolderPath ? `${sourceFolderPath}/${asset.filename}` : asset.filename
        const auth = getAuth()
        const authority = await auth.loadPageRuleAuthority(requester, transaction)
        if (!auth.checkPageAccess(requester, ['manage:system', 'manage:assets'], { path: sourcePath }, authority)) {
          throw new errors.AssetInvalid()
        }
        await assertAssetLocationAssetSettled(transaction, asset.id)

        const filename = filenameInput ?? asset.filename
        if (!_.endsWith(filename, asset.ext.toLowerCase())) throw new errors.AssetRenameInvalidExt()
        const targetFolderId =
          requestedFolderId === undefined ? sourceFolderId : requestedFolderId === null || requestedFolderId === 0 ? null : requestedFolderId
        let targetHierarchy: Folder[] = []
        try {
          targetHierarchy = targetFolderId === null ? [] : await models.assetFolders.getHierarchy(targetFolderId, transaction)
          if (targetFolderId !== null) assertCompleteHierarchy(targetHierarchy, targetFolderId)
          await lockFolderChains(transaction, [targetHierarchy])
        } catch (error: unknown) {
          if (error instanceof AssetFolderHierarchyError) throw new errors.AssetRenameTargetForbidden()
          throw error
        }
        const targetFolderPath = targetHierarchy.map(folder => folder.slug).join('/')
        const destinationPath = targetFolderPath ? `${targetFolderPath}/${filename}` : filename
        if (!auth.checkPageAccess(requester, ['manage:system', 'write:assets'], { path: destinationPath }, authority)) {
          throw new errors.AssetRenameTargetForbidden()
        }
        for (const path of [sourcePath, destinationPath].sort()) await lockAssetLocation(transaction, path)
        await assertAssetLocationReservations(transaction, [sourcePath, destinationPath])

        const collisionQuery = models.assets.query(transaction).where({ filename })
        let existing = await (targetFolderId === null ? collisionQuery.whereNull('folderId') : collisionQuery.where('folderId', targetFolderId)).first()
        if (!existing && targetFolderId === null) {
          existing = await models.assets.query(transaction).where({ filename }).where('folderId', 0).first()
        }
        if (existing && existing.id !== asset.id) throw new errors.AssetRenameCollision()
        const dataRow = await transaction<AssetDataRow>('assetData').where('id', id).first('data')
        if (!dataRow) throw new errors.AssetInvalid()
        const bytes = relocationBytes(dataRow.data)
        const contentSha256 = createHash('sha256').update(bytes).digest('hex')
        const destinationHash = assetHelper.generateHash(destinationPath)
        const targets =
          typeof models.storage.relocationTargets === 'function'
            ? models.storage.relocationTargets().filter(target => target.active)
            : typeof models.storage.runtimeTargets === 'function'
              ? models.storage.runtimeTargets().filter(target => target.active)
              : []
        const unsupportedTarget = targets.find(target => target.supportsAssetRelocation === false)
        if (unsupportedTarget) {
          throw new ApplicationError(`Storage target ${unsupportedTarget.key} cannot reconcile asset relocations.`, {
            status: 503,
            code: 'ASSET_RELOCATION_UNSUPPORTED'
          })
        }
        await models.assets.query(transaction).patch({ filename, folderId: targetFolderId, hash: destinationHash }).findById(id)

        const operationId = randomUUID()
        const now = new Date()
        await transaction('assetRelocationOperations').insert({
          id: operationId,
          assetId: asset.id,
          actorId: requester.id,
          sourcePath,
          destinationPath,
          sourceHash: asset.hash,
          destinationHash,
          contentSha256,
          status: 'pending',
          lastError: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null
        })
        for (const target of targets) {
          await enqueueAssetRelocationEffect(transaction, {
            operationId,
            assetId: asset.id,
            sourcePath,
            destinationPath,
            sourceHash: asset.hash,
            destinationHash,
            contentSha256,
            targetKey: target.key,
            targetConfigurationRevision: target.configurationKey,
            authorName: requester.name,
            authorEmail: requester.email
          })
        }
        if (targets.length === 0) {
          await transaction('assetRelocationOperations').where({ id: operationId }).update({ status: 'succeeded', completedAt: now, updatedAt: now })
        }
        return { operationId, oldHash: asset.hash, newHash: destinationHash }
      })
      await assertHeld?.()
      try {
        if (models.assets.deleteAssetCaches) await models.assets.deleteAssetCaches([result.oldHash, result.newHash])
      } catch {
        logRelocationCacheCleanupFailure()
      }
      await assertHeld?.()
      return relocationReceipt(result.operationId, requester)
    },
    models.knex
  )
  return result
}

const relocationStatus = async ({ requester, id }: { requester: Requester; id: string }): Promise<AssetRelocationReceipt> => {
  const auth = getAuth()
  if (!auth.checkAccess(requester, ['manage:system', 'manage:assets'])) throw new errors.AssetRenameForbidden()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw relocationNotFound()
  return relocationReceipt(id, requester)
}

const remove = async ({ requester, id }: { requester: Requester; id: number }): Promise<void> => {
  await withAssetLocationLocks(
    ['assets'],
    async assertHeld => {
      await assertHeld?.()
      const { asset, assetPath } = await models.knex.transaction(async transaction => {
        const asset = await models.assets.query(transaction).where({ id }).forUpdate().first()
        if (!asset) throw new errors.AssetInvalid()
        const assetPath = await asset.getAssetPath()
        const auth = getAuth()
        const authority = await auth.loadPageRuleAuthority(requester, transaction)
        if (!auth.checkPageAccess(requester, ['manage:system', 'manage:assets'], { path: assetPath }, authority)) {
          throw new errors.AssetInvalid()
        }
        await lockAssetLocation(transaction, assetPath)
        await assertAssetLocationAssetSettled(transaction, asset.id)
        await assertAssetLocationReservations(transaction, [assetPath])
        await models.assets.query(transaction).deleteById(id)
        return { asset, assetPath }
      })
      await assertHeld?.()
      await asset.deleteAssetCache()
      await models.storage.assetEvent({
        event: 'deleted',
        asset: {
          ...asset,
          metadata: stripAssetBrandingMetadata(asset.metadata),
          path: assetPath,
          authorId: requester.id,
          authorName: requester.name,
          authorEmail: requester.email
        }
      })
      await assertHeld?.()
    },
    models.knex
  )
}

const flushTemporaryUploads = (): unknown => models.assets.flushTempUploads()

export default { createFolder, flushTemporaryUploads, getBranding, list, listFolders, relocate, relocationStatus, remove, resizeImage }
