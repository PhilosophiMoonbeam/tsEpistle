import _ from 'lodash'
import sanitize from 'sanitize-filename'

import assetHelper from '../helpers/asset.ts'

interface Requester extends Record<string, unknown> { id: number, name: string, email: string }
interface Asset extends Record<string, unknown> {
  id: number
  filename: string
  kind: string
  ext: string
  folderId: number | null
  deleteAssetCache(): Promise<unknown>
  getAssetPath(): Promise<string>
}
interface Folder extends Record<string, unknown> { slug: string }
interface Query<Row> {
  where(condition: Record<string, unknown> | string, value?: unknown): Query<Row> & PromiseLike<Row[]>
  first(): Promise<Row | undefined>
  findById(id: number): Promise<Row | undefined>
  insert(data: Record<string, unknown>): Promise<unknown>
  patch(data: Record<string, unknown>): { findById(id: number): Promise<unknown> }
  deleteById(id: number): Promise<unknown>
}
interface Models {
  assets: { query(): Query<Asset>, flushTempUploads(): unknown }
  assetFolders: { query(): Query<Folder>, getHierarchy(id: number): Promise<Folder[]> }
  storage: { assetEvent(event: Record<string, unknown>): Promise<unknown> }
  knex(table: string): { where(column: string, value: unknown): { del(): Promise<unknown> } }
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
const getAuth = (): { checkAccess(requester: Requester, permissions: string[], context: Record<string, unknown>): boolean } =>
  WIKI.auth as { checkAccess(requester: Requester, permissions: string[], context: Record<string, unknown>): boolean }
const errors = WIKI.Error as unknown as WikiErrors

const list = async ({ requester, folderId, kind }: { requester: Requester, folderId: number, kind: string }) => {
  const condition: Record<string, unknown> = { folderId: folderId === 0 ? null : folderId }
  if (kind !== 'ALL') condition.kind = kind.toLowerCase()
  const hierarchy = await models.assetFolders.getHierarchy(folderId)
  const folderPath = hierarchy.map(folder => folder.slug).join('/')
  const assets = await models.assets.query().where(condition)
  return assets.filter(asset => getAuth().checkAccess(requester, ['read:assets'], {
    path: folderPath ? `${folderPath}/${asset.filename}` : asset.filename
  })).map(asset => ({ ...asset, kind: asset.kind.toUpperCase() }))
}

const listFolders = async ({ requester, parentFolderId }: { requester: Requester, parentFolderId: number }) => {
  const folders = await models.assetFolders.query().where({ parentId: parentFolderId === 0 ? null : parentFolderId })
  const hierarchy = await models.assetFolders.getHierarchy(parentFolderId)
  const parentPath = hierarchy.map(folder => folder.slug).join('/')
  return folders.filter(folder => getAuth().checkAccess(requester, ['read:assets'], {
    path: parentPath ? `${parentPath}/${folder.slug}` : folder.slug
  }))
}

const createFolder = async ({ slug, parentFolderId }: { slug: string, parentFolderId: number }): Promise<void> => {
  const folderSlug = sanitize(slug).toLowerCase()
  const parentId = parentFolderId === 0 ? null : parentFolderId
  const existing = await models.assetFolders.query().where({ parentId, slug: folderSlug }).first()
  if (existing) throw new errors.AssetFolderExists()
  await models.assetFolders.query().insert({ slug: folderSlug, name: folderSlug, parentId })
}

const rename = async ({ requester, id, filename: requestedFilename }: { requester: Requester, id: number, filename: string }): Promise<void> => {
  const filename = sanitize(requestedFilename).toLowerCase()
  const asset = await models.assets.query().findById(id)
  if (!asset) throw new errors.AssetInvalid()
  if (!_.endsWith(filename, asset.ext)) throw new errors.AssetRenameInvalidExt()
  if (asset.ext.length > 0 && filename.length - asset.ext.length < 1) throw new errors.AssetRenameInvalid()
  if (await models.assets.query().where({ filename, folderId: asset.folderId }).first()) throw new errors.AssetRenameCollision()
  const hierarchy = asset.folderId ? await models.assetFolders.getHierarchy(asset.folderId) : []
  const folderPath = hierarchy.map(folder => folder.slug).join('/')
  const sourcePath = asset.folderId ? `${folderPath}/${asset.filename}` : asset.filename
  if (!getAuth().checkAccess(requester, ['manage:assets'], { path: sourcePath })) throw new errors.AssetRenameForbidden()
  const targetPath = asset.folderId ? `${folderPath}/${filename}` : filename
  if (!getAuth().checkAccess(requester, ['write:assets'], { path: targetPath })) throw new errors.AssetRenameTargetForbidden()
  await models.assets.query().patch({ filename, hash: assetHelper.generateHash(targetPath) }).findById(id)
  await asset.deleteAssetCache()
  await models.storage.assetEvent({
    event: 'renamed',
    asset: { ...asset, path: sourcePath, destinationPath: targetPath, moveAuthorId: requester.id, moveAuthorName: requester.name, moveAuthorEmail: requester.email }
  })
}

const remove = async ({ requester, id }: { requester: Requester, id: number }): Promise<void> => {
  const asset = await models.assets.query().findById(id)
  if (!asset) throw new errors.AssetInvalid()
  const assetPath = await asset.getAssetPath()
  if (!getAuth().checkAccess(requester, ['manage:assets'], { path: assetPath })) throw new errors.AssetDeleteForbidden()
  await models.knex('assetData').where('id', id).del()
  await models.assets.query().deleteById(id)
  await asset.deleteAssetCache()
  await models.storage.assetEvent({
    event: 'deleted',
    asset: { ...asset, path: assetPath, authorId: requester.id, authorName: requester.name, authorEmail: requester.email }
  })
}

const flushTemporaryUploads = (): unknown => models.assets.flushTempUploads()

export default { createFolder, flushTemporaryUploads, list, listFolders, remove, rename }
