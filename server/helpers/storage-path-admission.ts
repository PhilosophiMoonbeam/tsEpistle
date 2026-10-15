import type { Knex } from 'knex'
import { assertAssetLocationReservations } from './asset-location-lock.ts'
import { lockSearchIndex } from './search-contract.ts'
import { storagePagePath } from './storage-page-path.ts'
import type { StoragePagePathIdentity, StoragePagePathOptions } from './storage-page-path.ts'
import { okfFilePath, parseOkfFilePath } from '../okf/format.ts'

interface StorageTargetRow {
  key: string
  config: unknown
}
interface PublicPageIdentity extends StoragePagePathIdentity {
  id: number
}
interface AdmissionRuntime {
  config: { lang: { code: string; namespacing?: boolean } }
}

export class StoragePathCollisionError extends Error {
  readonly status = 409
  readonly code = 'STORAGE_PATH_COLLISION'

  constructor() {
    super('The storage destination is already occupied.')
    this.name = 'StoragePathCollisionError'
  }
}

const pagePathOptions = (target: StorageTargetRow): StoragePagePathOptions => {
  const runtime = (globalThis as typeof globalThis & { WIKI: AdmissionRuntime }).WIKI
  const lang = runtime.config.lang
  const config: unknown = typeof target.config === 'string' ? JSON.parse(target.config) : target.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new TypeError('Storage target configuration is invalid')
  return {
    defaultLocale: lang.code,
    namespaceNonDefaultLocale: target.key === 'disk' || lang.namespacing === true,
    alwaysNamespace: target.key === 'git' && Reflect.get(config, 'alwaysNamespace') === true
  }
}

const enabledPagePathOptions = async (transaction: Knex.Transaction): Promise<StoragePagePathOptions[]> => {
  const targets = await transaction<StorageTargetRow>('storage').where('isEnabled', true).orderBy('key').forShare().select('key', 'config')
  return targets.map(pagePathOptions)
}

/** Authorize the asset destination first; the caller must already hold the exclusive asset session fence. */
export const assertNoPublicStoragePageAtPath = async (transaction: Knex.Transaction, assetPath: string): Promise<void> => {
  await lockSearchIndex(transaction, false)
  const options = await enabledPagePathOptions(transaction)
  if (options.length === 0) return
  const okf = parseOkfFilePath(assetPath)
  const extension = assetPath.lastIndexOf('.')
  if (okf === null && extension <= assetPath.lastIndexOf('/')) return
  const basename = assetPath.slice(0, extension)
  const slash = basename.indexOf('/')
  const paths = okf === null ? [basename] : [okf.pagePath]
  if (okf === null && slash > 0) paths.push(basename.slice(slash + 1))
  const pages = await transaction<PublicPageIdentity>('pages')
    .where('visibility', 'public')
    .whereIn('path', paths)
    .select('id', 'path', 'localeCode', 'contentType')
  for (const page of pages) {
    for (const policy of options) {
      if (storagePagePath(page, policy) === assetPath) throw new StoragePathCollisionError()
    }
  }
}

const assertNoAssetAtPath = async (transaction: Knex.Transaction, storagePath: string): Promise<void> => {
  await assertAssetLocationReservations(transaction, [storagePath])
  const parts = storagePath.split('/')
  const filename = parts.pop()
  if (!filename) throw new StoragePathCollisionError()
  let parentId: number | null = null
  for (const slug of parts) {
    const query = transaction<{ id: number }>('assetFolders').where('slug', slug)
    if (parentId === null) query.whereNull('parentId')
    else query.where('parentId', parentId)
    const folder = await query.first('id')
    if (!folder) return
    parentId = folder.id
  }
  const asset = transaction('assets').where({ filename })
  if (parentId === null) asset.where(query => query.whereNull('folderId').orWhere('folderId', 0))
  else asset.where({ folderId: parentId })
  if (await asset.first('id')) throw new StoragePathCollisionError()
}

/** Authorize the proposed page first and hold shared asset then search fences through the canonical transaction. */
export const assertNoStorageAssetAtPagePaths = async (transaction: Knex.Transaction, page: StoragePagePathIdentity & { visibility: string }): Promise<void> => {
  if (page.visibility !== 'public') return
  const paths = new Set((await enabledPagePathOptions(transaction)).map(options => storagePagePath(page, options)))
  if (page.contentType === 'markdown') paths.add(okfFilePath(page.localeCode, page.path))
  for (const storagePath of paths) await assertNoAssetAtPath(transaction, storagePath)
}

/** Hold the exclusive asset then search fences before locking/publishing the target configuration. */
export const assertStorageTargetPathsAvailable = async (transaction: Knex.Transaction, target: StorageTargetRow): Promise<void> => {
  const options = pagePathOptions(target)
  let afterId = 0
  while (true) {
    const pages = await transaction<PublicPageIdentity>('pages')
      .where('visibility', 'public')
      .where('id', '>', afterId)
      .orderBy('id')
      .limit(500)
      .select('id', 'path', 'localeCode', 'contentType')
    if (pages.length === 0) return
    for (const page of pages) await assertNoAssetAtPath(transaction, storagePagePath(page, options))
    afterId = pages[pages.length - 1]!.id
  }
}
