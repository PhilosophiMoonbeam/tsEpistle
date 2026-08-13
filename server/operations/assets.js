const _ = require('lodash')
const sanitize = require('sanitize-filename')

const assetHelper = require('../helpers/asset')

/* global WIKI */

const list = async ({ requester, folderId, kind }) => {
  const condition = { folderId: folderId === 0 ? null : folderId }
  if (kind !== 'ALL') condition.kind = kind.toLowerCase()
  const hierarchy = await WIKI.models.assetFolders.getHierarchy(folderId)
  const folderPath = hierarchy.map(folder => folder.slug).join('/')
  const assets = await WIKI.models.assets.query().where(condition)
  return assets.filter(asset => WIKI.auth.checkAccess(requester, ['read:assets'], {
    path: folderPath ? `${folderPath}/${asset.filename}` : asset.filename
  })).map(asset => ({ ...asset, kind: asset.kind.toUpperCase() }))
}

const listFolders = async ({ requester, parentFolderId }) => {
  const folders = await WIKI.models.assetFolders.query().where({ parentId: parentFolderId === 0 ? null : parentFolderId })
  const hierarchy = await WIKI.models.assetFolders.getHierarchy(parentFolderId)
  const parentPath = hierarchy.map(folder => folder.slug).join('/')
  return folders.filter(folder => WIKI.auth.checkAccess(requester, ['read:assets'], {
    path: parentPath ? `${parentPath}/${folder.slug}` : folder.slug
  }))
}

const createFolder = async ({ slug, parentFolderId }) => {
  const folderSlug = sanitize(slug).toLowerCase()
  const parentId = parentFolderId === 0 ? null : parentFolderId
  const existing = await WIKI.models.assetFolders.query().where({ parentId, slug: folderSlug }).first()
  if (existing) throw new WIKI.Error.AssetFolderExists()
  await WIKI.models.assetFolders.query().insert({ slug: folderSlug, name: folderSlug, parentId })
}

const rename = async ({ requester, id, filename: requestedFilename }) => {
  const filename = sanitize(requestedFilename).toLowerCase()
  const asset = await WIKI.models.assets.query().findById(id)
  if (!asset) throw new WIKI.Error.AssetInvalid()
  if (!_.endsWith(filename, asset.ext)) throw new WIKI.Error.AssetRenameInvalidExt()
  if (asset.ext.length > 0 && filename.length - asset.ext.length < 1) throw new WIKI.Error.AssetRenameInvalid()
  if (await WIKI.models.assets.query().where({ filename, folderId: asset.folderId }).first()) throw new WIKI.Error.AssetRenameCollision()
  const hierarchy = asset.folderId ? await WIKI.models.assetFolders.getHierarchy(asset.folderId) : []
  const folderPath = hierarchy.map(folder => folder.slug).join('/')
  const sourcePath = asset.folderId ? `${folderPath}/${asset.filename}` : asset.filename
  if (!WIKI.auth.checkAccess(requester, ['manage:assets'], { path: sourcePath })) throw new WIKI.Error.AssetRenameForbidden()
  const targetPath = asset.folderId ? `${folderPath}/${filename}` : filename
  if (!WIKI.auth.checkAccess(requester, ['write:assets'], { path: targetPath })) throw new WIKI.Error.AssetRenameTargetForbidden()
  await WIKI.models.assets.query().patch({ filename, hash: assetHelper.generateHash(targetPath) }).findById(id)
  await asset.deleteAssetCache()
  await WIKI.models.storage.assetEvent({
    event: 'renamed',
    asset: {
      ...asset,
      path: sourcePath,
      destinationPath: targetPath,
      moveAuthorId: requester.id,
      moveAuthorName: requester.name,
      moveAuthorEmail: requester.email
    }
  })
}

const remove = async ({ requester, id }) => {
  const asset = await WIKI.models.assets.query().findById(id)
  if (!asset) throw new WIKI.Error.AssetInvalid()
  const assetPath = await asset.getAssetPath()
  if (!WIKI.auth.checkAccess(requester, ['manage:assets'], { path: assetPath })) throw new WIKI.Error.AssetDeleteForbidden()
  await WIKI.models.knex('assetData').where('id', id).del()
  await WIKI.models.assets.query().deleteById(id)
  await asset.deleteAssetCache()
  await WIKI.models.storage.assetEvent({
    event: 'deleted',
    asset: {
      ...asset,
      path: assetPath,
      authorId: requester.id,
      authorName: requester.name,
      authorEmail: requester.email
    }
  })
}

const flushTemporaryUploads = () => WIKI.models.assets.flushTempUploads()

module.exports = { createFolder, flushTemporaryUploads, list, listFolders, remove, rename }
