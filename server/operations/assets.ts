declare const WIKI: Record<string, unknown>

import _ from 'lodash'
import sanitize from 'sanitize-filename'
import type { Knex } from 'knex'

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
interface Models {
  assets: { query(transaction?: Knex.Transaction): Query<Asset>; flushTempUploads(): unknown }
  assetFolders: { query(transaction?: Knex.Transaction): Query<Folder>; getHierarchy(id: number, transaction?: Knex.Transaction): Promise<Folder[]> }
  storage: { assetEvent(event: Record<string, unknown>): Promise<unknown> }
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
} => WIKI.auth as {
  checkAccess(requester: Requester, permissions: readonly string[]): boolean
  checkPageAccess(requester: Requester, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
  loadPageRuleAuthority(requester: Requester, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
}
const errors = WIKI.Error as unknown as WikiErrors
const runtime = WIKI as unknown as { config?: { db?: { type?: string } } }
const ASSET_FOLDER_DESTINATION_LOCK = 0x4153464c

const invalidFolderSlug = () =>
  new ApplicationError('Folder slug must be a canonical non-empty path segment.', { status: 400, code: 'ASSET_FOLDER_INVALID' })

const normalizeFolderSlug = (value: string): string => {
  let sanitized: string
  try {
    sanitized = sanitize(value)
  } catch {
    throw invalidFolderSlug()
  }
  const folderSlug = sanitized.trim().toLowerCase()
  if (
    folderSlug.length === 0 ||
    folderSlug === '.' ||
    folderSlug === '..' ||
    folderSlug.includes('/') ||
    folderSlug.includes('\\')
  ) {
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
    if (
      !locked ||
      !expected ||
      locked.id !== expected.id ||
      locked.slug !== expected.slug ||
      locked.parentId !== expected.parentId
    ) {
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
      auth.checkPageAccess(
        requester,
        ['manage:system', 'read:assets'],
        { path: folderPath ? `${folderPath}/${asset.filename}` : asset.filename },
        authority
      )
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
    auth.checkPageAccess(
      requester,
      ['manage:system', 'read:assets'],
      { path: parentPath ? `${parentPath}/${folder.slug}` : folder.slug },
      authority
    )
  )
}

const createFolder = async ({
  requester,
  slug,
  parentFolderId
}: {
  requester: Requester
  slug: string
  parentFolderId: number
}): Promise<void> => {
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

const rename = async ({ requester, id, filename: requestedFilename }: { requester: Requester; id: number; filename: string }): Promise<void> => {
  const filename = sanitize(requestedFilename).toLowerCase()
  const { asset, sourcePath, targetPath } = await models.knex.transaction(async transaction => {
    const asset = await models.assets.query(transaction).where({ id }).forUpdate().first()
    if (!asset) throw new errors.AssetInvalid()
    if (!_.endsWith(filename, asset.ext)) throw new errors.AssetRenameInvalidExt()
    const collisionQuery = models.assets.query(transaction).where({ filename })
    const collision = (asset.folderId === null ? collisionQuery.whereNull('folderId') : collisionQuery.where('folderId', asset.folderId)).first()
    if (await collision) throw new errors.AssetRenameCollision()
    const hierarchy = asset.folderId ? await models.assetFolders.getHierarchy(asset.folderId) : []
    const folderPath = hierarchy.map(folder => folder.slug).join('/')
    const sourcePath = asset.folderId ? `${folderPath}/${asset.filename}` : asset.filename
    const targetPath = asset.folderId ? `${folderPath}/${filename}` : filename
    const auth = getAuth()
    const authority = await auth.loadPageRuleAuthority(requester, transaction)
    if (!auth.checkPageAccess(requester, ['manage:system', 'manage:assets'], { path: sourcePath }, authority))
      throw new errors.AssetRenameForbidden()
    if (!auth.checkPageAccess(requester, ['manage:system', 'write:assets'], { path: targetPath }, authority))
      throw new errors.AssetRenameTargetForbidden()
    await models.assets
      .query(transaction)
      .patch({ filename, hash: assetHelper.generateHash(targetPath) })
      .findById(id)
    return { asset, sourcePath, targetPath }
  })
  await asset.deleteAssetCache()
  await models.storage.assetEvent({
    event: 'renamed',
    asset: {
      ...asset,
      metadata: stripAssetBrandingMetadata(asset.metadata),
      path: sourcePath,
      destinationPath: targetPath,
      moveAuthorId: requester.id,
      moveAuthorName: requester.name,
      moveAuthorEmail: requester.email
    }
  })
}

const remove = async ({ requester, id }: { requester: Requester; id: number }): Promise<void> => {
  const { asset, assetPath } = await models.knex.transaction(async transaction => {
    const asset = await models.assets.query(transaction).where({ id }).forUpdate().first()
    if (!asset) throw new errors.AssetInvalid()
    const assetPath = await asset.getAssetPath()
    const auth = getAuth()
    const authority = await auth.loadPageRuleAuthority(requester, transaction)
    if (!auth.checkPageAccess(requester, ['manage:system', 'manage:assets'], { path: assetPath }, authority))
      throw new errors.AssetDeleteForbidden()
    await models.assets.query(transaction).deleteById(id)
    return { asset, assetPath }
  })
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
}

const flushTemporaryUploads = (): unknown => models.assets.flushTempUploads()

export default { createFolder, flushTemporaryUploads, getBranding, list, listFolders, remove, rename }
