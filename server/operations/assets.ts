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
  metadata?: unknown
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

export default { createFolder, flushTemporaryUploads, getBranding, list, listFolders, relocate, relocationStatus, remove }
