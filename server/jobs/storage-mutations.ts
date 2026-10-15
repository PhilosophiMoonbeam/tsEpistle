import type { Knex } from 'knex'
import { DurableJobDeferral, DurableJobStore, type DurableJobHandler } from '../core/durable-jobs.ts'
import { nativeStorageMutationConfigurationKey } from '../helpers/storage-configuration-key.ts'
import { storageTargetPausedOffline } from '../helpers/storage-offline-policy.ts'
import { lockAssetMutationFence } from '../helpers/asset-location-lock.ts'
import { lockSearchIndex } from '../helpers/search-contract.ts'
import { storagePagePath } from '../helpers/storage-page-path.ts'
import assetHelper from '../helpers/asset.ts'
import pageHelper from '../helpers/page.ts'
import { parseOkfFilePath } from '../okf/format.ts'
import { isRecord } from '../models/moduleTypes.ts'
import type { StoragePageEncodingInput } from '../modules/storage/page-document.ts'
import { z } from 'zod'

interface StorageTargetRow {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval: string
  config: Record<string, unknown> | string
}

export interface StorageMutationPageLocation {
  path: string
  localeCode: string
  contentType: string
  visibility: string
}

interface MutationAuthor {
  id: number
  name: string
  email: string
}

const StorageMutationPayloadSchema = z.strictObject({
  entityType: z.enum(['page', 'asset']),
  entityId: z.number().int().positive().safe(),
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(2048)
        .refine(value => {
          if (value.startsWith('/') || value.includes('\\')) return false
          for (let index = 0; index < value.length; index += 1) {
            if (value.charCodeAt(index) <= 31) return false
          }
          return value.split('/').every(part => part !== '..' && part !== '.' && part !== '')
        })
    )
    .min(1)
    .max(2),
  targetKey: z.string().min(1).max(255),
  targetConfigurationRevision: z.string().min(1),
  authorId: z.number().int().positive().safe(),
  authorName: z.string(),
  authorEmail: z.string()
})
export type StorageMutationPayload = z.infer<typeof StorageMutationPayloadSchema>

export interface StorageMutationDispatch {
  writePage(page: StoragePageEncodingInput & { authorName: string; authorEmail: string }): Promise<unknown>
  writeAsset(asset: { path: string; data: Buffer; authorId: number; authorName: string; authorEmail: string }): Promise<unknown>
  removePath(asset: { path: string; authorId: number; authorName: string; authorEmail: string }): Promise<unknown>
}

interface StorageMutationRuntime {
  config: { lang: { code: string; namespacing?: boolean }; offline?: boolean; allowGitSyncWhileOffline?: boolean }
  models: {
    storage: {
      performMutation(input: StorageMutationPayload, work: (dispatch: StorageMutationDispatch) => Promise<void>, signal: AbortSignal): Promise<void>
    }
  }
}

const getWiki = (): StorageMutationRuntime => {
  const runtime = globalThis as unknown as { WIKI: StorageMutationRuntime }
  return runtime.WIKI
}
const readConfig = (config: StorageTargetRow['config']): Record<string, unknown> => {
  const value: unknown = typeof config === 'string' ? JSON.parse(config) : config
  if (!isRecord(value)) throw new TypeError('Storage target configuration is invalid')
  return value
}

const pagePath = (page: Pick<StorageMutationPageLocation, 'path' | 'localeCode' | 'contentType'>, target: StorageTargetRow): string => {
  const lang = getWiki().config.lang
  return storagePagePath(page, {
    defaultLocale: lang.code,
    namespaceNonDefaultLocale: target.key === 'disk' || lang.namespacing === true,
    alwaysNamespace: target.key === 'git' && readConfig(target.config).alwaysNamespace === true
  })
}

const enabledTargets = async (transaction: Knex.Transaction): Promise<StorageTargetRow[]> => {
  const targets = await transaction<StorageTargetRow>('storage')
    .where({ isEnabled: true })
    .orderBy('key')
    .forShare()
    .select('key', 'isEnabled', 'mode', 'syncInterval', 'config')
  return targets.map(target => ({ ...target, config: readConfig(target.config) }))
}

const admit = async (
  transaction: Knex.Transaction,
  input: { entityType: 'page' | 'asset'; entityId: number; author: MutationAuthor },
  locations: (target: StorageTargetRow) => string[]
): Promise<void> => {
  const store = new DurableJobStore(transaction)
  for (const target of await enabledTargets(transaction)) {
    const paths = [...new Set(locations(target))]
    if (paths.length === 0) continue
    await store.enqueue({
      type: 'storage-mutation',
      version: 1,
      payload: StorageMutationPayloadSchema.parse({
        entityType: input.entityType,
        entityId: input.entityId,
        paths,
        targetKey: target.key,
        targetConfigurationRevision: nativeStorageMutationConfigurationKey(target),
        authorId: input.author.id,
        authorName: input.author.name,
        authorEmail: input.author.email
      })
    })
  }
}

/** Called in the canonical transaction, including deletes. No source or blob is copied to the queue. */
export const enqueuePageStorageMutation = async (
  transaction: Knex.Transaction,
  input: { pageId: number; previous?: StorageMutationPageLocation; author: MutationAuthor; skipStorage?: boolean | undefined }
): Promise<void> => {
  if (input.skipStorage) return
  const current = await transaction<StorageMutationPageLocation>('pages').where('id', input.pageId).first('path', 'localeCode', 'contentType', 'visibility')
  const locations = [input.previous, current].filter((page): page is StorageMutationPageLocation => page?.visibility === 'public')
  if (locations.length === 0) return
  await admit(transaction, { entityType: 'page', entityId: input.pageId, author: input.author }, target => locations.map(page => pagePath(page, target)))
}

export const enqueueAssetStorageMutation = async (
  transaction: Knex.Transaction,
  input: { assetId: number; paths: string[]; author: MutationAuthor; skipStorage?: boolean | undefined }
): Promise<void> => {
  if (input.skipStorage) return
  await admit(transaction, { entityType: 'asset', entityId: input.assetId, author: input.author }, () => input.paths)
}

interface CanonicalPage extends StoragePageEncodingInput {
  id: number
  authorName: string
  authorEmail: string
}
type CanonicalPageIdentity = Pick<CanonicalPage, 'id' | 'path' | 'localeCode' | 'contentType'>
interface CanonicalAsset {
  id: number
  hash: string
  filename: string
  folderId: number | null
  authorId: number
}

const assertLease = async (transaction: Knex.Transaction, job: Parameters<DurableJobHandler>[0], signal: AbortSignal, targetKey: string): Promise<void> => {
  signal.throwIfAborted()
  const current = await transaction('durableJobs')
    .where({ id: job.id, type: job.type, version: job.version, state: 'running', leaseOwner: job.leaseOwner, leaseToken: job.leaseToken })
    .where('leaseExpiresAt', '>', new Date())
    .first('id')
  if (!current || !job.leaseOwner || !job.leaseToken) throw new Error('Storage mutation durable lease is no longer current')
  if (storageTargetPausedOffline(getWiki().config, targetKey)) throw new Error('Remote storage mutation is paused in offline mode')
}

const currentPage = async (transaction: Knex.Transaction, relativePath: string, target: StorageTargetRow): Promise<CanonicalPage | undefined> => {
  const okf = parseOkfFilePath(relativePath)
  if (!okf && relativePath.lastIndexOf('.') <= relativePath.lastIndexOf('/')) return undefined
  const basename = relativePath.slice(0, relativePath.lastIndexOf('.'))
  const slash = basename.indexOf('/')
  const candidates = okf
    ? [{ path: okf.pagePath, localeCode: okf.locale }]
    : [{ path: basename }, ...(slash > 0 ? [{ path: basename.slice(slash + 1), localeCode: basename.slice(0, slash) }] : [])]
  const pages = await transaction<CanonicalPageIdentity>('pages')
    .where('visibility', 'public')
    .where(builder => {
      for (const location of candidates) builder.orWhere(location)
    })
    .forShare()
    .select('id', 'path', 'localeCode', 'contentType')
  const owners = pages.filter(page => pagePath(page, target) === relativePath)
  if (owners.length > 1) throw new Error('Storage path has multiple canonical page owners')
  const identity = owners[0]
  if (!identity) return undefined
  const page = await transaction<CanonicalPage>('pages')
    .where('id', identity.id)
    .where('visibility', 'public')
    .first(
      'id',
      'path',
      'localeCode',
      'title',
      'description',
      'contentType',
      'content',
      'sourceRevision',
      'authorId',
      'createdAt',
      'updatedAt',
      'extra',
      'isPublished',
      'editorKey'
    )
  if (!page) throw new Error('Canonical storage page disappeared while locked')
  const author = await transaction<{ name: string; email: string }>('users').where('id', page.authorId).first('name', 'email')
  if (!author) throw new Error('Canonical storage page author is unavailable')
  const tags = await transaction<{ tag: string }>('tags').join('pageTags', 'pageTags.tagId', 'tags.id').where('pageTags.pageId', page.id).select('tags.tag')
  const extra: unknown = typeof page.extra === 'string' ? JSON.parse(page.extra) : page.extra
  if (extra !== null && extra !== undefined && !isRecord(extra)) throw new Error('Canonical storage page metadata is invalid')
  return { ...page, authorName: author.name, authorEmail: author.email, tags, extra: extra ?? null }
}

const hasImportedPageOwner = async (
  transaction: Knex.Transaction,
  relativePath: string,
  target: StorageTargetRow,
  input: StorageMutationPayload
): Promise<boolean> => {
  if ((target.key !== 'git' && target.key !== 'disk') || parseOkfFilePath(relativePath) !== null) return false
  const contentType = pageHelper.getContentType(relativePath)
  if (!contentType) return false
  const identity = pageHelper.getPagePath(relativePath)
  const paths = [identity.path]
  if (readConfig(target.config).mapReadmeToHome === true && (contentType === 'markdown' || contentType === 'asciidoc') && /^readme$/iu.test(identity.path)) {
    paths.push('home')
  }
  const query = transaction('pages').where({ localeCode: identity.locale, visibility: 'public' }).whereIn('path', paths)
  if (input.entityType === 'page') query.whereNot('id', input.entityId)
  const owner = await query.forShare().first('id')
  return Boolean(owner)
}

const currentAsset = async (transaction: Knex.Transaction, relativePath: string): Promise<CanonicalAsset | undefined> => {
  const asset = await transaction<CanonicalAsset>('assets')
    .where({ hash: assetHelper.generateHash(relativePath) })
    .forShare()
    .first('id', 'hash', 'filename', 'folderId', 'authorId')
  if (!asset) return undefined
  let folderId = asset.folderId
  const segments = [asset.filename]
  const seen = new Set<number>()
  while (folderId !== null && folderId !== 0) {
    if (seen.has(folderId) || seen.size >= 256) throw new Error('Canonical storage asset hierarchy is invalid')
    seen.add(folderId)
    const folder = await transaction<{ slug: string; parentId: number | null }>('assetFolders').where('id', folderId).forShare().first('slug', 'parentId')
    if (!folder) throw new Error('Canonical storage asset hierarchy is unavailable')
    segments.unshift(folder.slug)
    folderId = folder.parentId
  }
  if (segments.join('/') !== relativePath) throw new Error('Canonical storage asset path does not match its hash')
  return asset
}

export const createStorageMutationHandler =
  (): DurableJobHandler =>
  async (job, { knex, signal }) => {
    if (job.type !== 'storage-mutation' || job.version !== 1) throw new TypeError('Invalid storage mutation job identity')
    const input = StorageMutationPayloadSchema.parse(job.payload)
    // Git invokes this callback only after acquiring its public, non-inheritable turn.
    try {
      signal.throwIfAborted()
      await getWiki().models.storage.performMutation(
        input,
        async dispatch => {
          await knex.transaction(async transaction => {
            const client = transaction.client.config.client
            if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
              await transaction.raw("SET LOCAL lock_timeout = '2000ms'")
              await transaction.raw("SET LOCAL statement_timeout = '5000ms'")
            }
            await assertLease(transaction, job, signal, input.targetKey)
            // Match native producer order: assets first, then the canonical page/search fence.
            // Row locks alone cannot protect a currently absent location from skipStorage ingestion.
            await lockAssetMutationFence(transaction)
            await lockSearchIndex(transaction, true)
            await assertLease(transaction, job, signal, input.targetKey)
            const target = await transaction<StorageTargetRow>('storage').where({ key: input.targetKey }).forUpdate().first()
            if (
              !target ||
              !target.isEnabled ||
              nativeStorageMutationConfigurationKey({ ...target, config: readConfig(target.config) }) !== input.targetConfigurationRevision
            ) {
              throw new Error('Storage mutation target configuration is no longer current')
            }
            for (const relativePath of input.paths) {
              const page = await currentPage(transaction, relativePath, target)
              const asset = await currentAsset(transaction, relativePath)
              if (page && asset) throw new Error('Storage path has conflicting canonical owners')
              await assertLease(transaction, job, signal, input.targetKey)
              // Imported legacy filenames can remain upstream while Markdown egress uses OKF.
              // A newer importer-owned path is not an orphan of this older asset/page mutation.
              if (!page && !asset && (await hasImportedPageOwner(transaction, relativePath, target, input))) continue
              if (page) await dispatch.writePage(page)
              else if (asset) {
                const row = await transaction<{ data: Buffer | Uint8Array | string }>('assetData').where('id', asset.id).first('data')
                if (!row) throw new Error('Canonical storage asset bytes are unavailable')
                const author = await transaction<{ name: string; email: string }>('users').where('id', asset.authorId).first('name', 'email')
                if (!author) throw new Error('Canonical storage asset author is unavailable')
                const data = Buffer.isBuffer(row.data)
                  ? row.data
                  : typeof row.data === 'string'
                    ? Buffer.from(row.data, 'base64')
                    : Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength)
                await assertLease(transaction, job, signal, input.targetKey)
                await dispatch.writeAsset({ path: relativePath, data, authorId: asset.authorId, authorName: author.name, authorEmail: author.email })
              } else {
                try {
                  await dispatch.removePath({ path: relativePath, authorId: input.authorId, authorName: input.authorName, authorEmail: input.authorEmail })
                } catch (error) {
                  // SFTP uses SSH_FX_NO_SUCH_FILE (2); other providers report ENOENT/404.
                  if (!isRecord(error) || !(error.code === 'ENOENT' || error.code === 2 || error.statusCode === 404)) throw error
                }
              }
              await assertLease(transaction, job, signal, input.targetKey)
            }
          })
        },
        signal
      )
    } catch (error) {
      const contention = isRecord(error) && (error.code === 'STORAGE_GIT_BUSY' || error.code === '55P03')
      throw new DurableJobDeferral(error, contention)
    }
  }
