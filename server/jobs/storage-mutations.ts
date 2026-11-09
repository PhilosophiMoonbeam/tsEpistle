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
import {
  assertNativeStoragePageIdentity,
  storageImportIdentityKey,
  storageImportLocationKey,
  storageImportSourceKey
} from '../modules/storage/import-identity.ts'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ENTRIES } from '../modules/storage/import-budget.ts'
import { acknowledgeStoragePageExport, loadStoragePageImportOwners, type StoragePageExportHook, type StoragePageExportProof } from '../helpers/storage-page-import-owner.ts'
import { currentGitMutationTurn } from '../modules/storage/git/mutation-lock.ts'
import type { StorageRootHandle } from '../modules/storage/local-filesystem.ts'
import { z } from 'zod'
import { PageChangeReasonSchema } from '../../shared/page-change-reason.ts'

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
  sourceRevision?: string | number | bigint
}

interface MutationAuthor {
  id: number
  name: string
  email: string
}

const StorageMutationPayloadSchema = z
  .strictObject({
    entityType: z.enum(['page', 'asset']),
    entityId: z.number().int().positive().safe(),
    sourceRevision: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .optional(),
    sourceOutboxId: z.string().uuid().optional(),
    changeReason: PageChangeReasonSchema,
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
  .refine(
    input => input.changeReason === undefined || (input.entityType === 'page' && input.sourceRevision !== undefined),
    'A change reason requires a page source revision'
  )
  .refine(
    input => input.sourceOutboxId === undefined || (input.entityType === 'page' && input.sourceRevision !== undefined),
    'A canonical root requires a page source revision'
  )
export type StorageMutationPayload = z.infer<typeof StorageMutationPayloadSchema>

export interface StorageMutationDispatch {
  writePage(page: StoragePageEncodingInput & { authorName: string; authorEmail: string; changeReason?: string }, onWritten?: StoragePageExportHook): Promise<unknown>
  writeAsset(asset: { path: string; data: Buffer; authorId: number; authorName: string; authorEmail: string }): Promise<unknown>
  removePath(asset: { path: string; authorId: number; authorName: string; authorEmail: string }): Promise<unknown>
}

interface StorageMutationRuntime {
  config: { lang: { code: string; namespacing?: boolean }; offline?: boolean; allowGitSyncWhileOffline?: boolean }
  models: {
    storage: {
      performMutation(input: StorageMutationPayload, work: (dispatch: StorageMutationDispatch) => Promise<void>, signal: AbortSignal): Promise<void>
      activeTargets?: Array<{ key: string; fn: { root?: StorageRootHandle | null } }>
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
  input: { entityType: 'page' | 'asset'; entityId: number; author: MutationAuthor; sourceRevision?: string; sourceOutboxId?: string; changeReason?: string },
  locations: (target: StorageTargetRow) => string[]
): Promise<void> => {
  const store = new DurableJobStore(transaction)
  for (const target of await enabledTargets(transaction)) {
    const paths = [...new Set(locations(target))]
    if (paths.length === 0) continue
    await store.enqueue({
      type: 'storage-mutation',
      version: input.entityType === 'page' ? 2 : 1,
      payload: StorageMutationPayloadSchema.parse({
        entityType: input.entityType,
        entityId: input.entityId,
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
        ...(input.sourceOutboxId === undefined ? {} : { sourceOutboxId: input.sourceOutboxId }),
        ...(input.changeReason === undefined ? {} : { changeReason: input.changeReason }),
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
  input: {
    pageId: number
    previous?: StorageMutationPageLocation
    author: MutationAuthor
    skipStorage?: boolean | undefined
    sourceRevision?: string | number | bigint
    sourceOutboxId?: string
    changeReason?: string
  }
): Promise<void> => {
  const changeReason = PageChangeReasonSchema.parse(input.changeReason)
  if (input.skipStorage) return
  const current = await transaction<StorageMutationPageLocation>('pages')
    .where('id', input.pageId)
    .first('path', 'localeCode', 'contentType', 'visibility', 'sourceRevision')
  const locations = [input.previous, current].filter((page): page is StorageMutationPageLocation => page?.visibility === 'public')
  if (locations.length === 0) return
  const sourceRevision = String(current?.sourceRevision ?? input.sourceRevision ?? input.previous?.sourceRevision)
  if (!/^[1-9][0-9]*$/u.test(sourceRevision)) throw new TypeError('Storage page mutation requires its canonical source revision')
  await admit(
    transaction,
    {
      entityType: 'page', entityId: input.pageId, author: input.author, sourceRevision,
      ...(input.sourceOutboxId === undefined ? {} : { sourceOutboxId: input.sourceOutboxId }),
      ...(changeReason === undefined ? {} : { changeReason })
    },
    target => locations.map(page => pagePath(page, target))
  )
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
  visibility: string
  ownerId: number | null
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
      'visibility',
      'ownerId',
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
  mutation: StorageMutationPayload,
  job: Parameters<DurableJobHandler>[0]
): Promise<boolean> => {
  if ((target.key !== 'git' && target.key !== 'disk') || parseOkfFilePath(relativePath) !== null) return false
  const contentType = pageHelper.getContentType(relativePath)
  if (!contentType) return false
  const config = readConfig(target.config)
  const locationKey = storageImportLocationKey(target.key === 'git' ? 'GIT' : 'DISK', config)
  const owners = await loadStoragePageImportOwners(transaction, { limit: IMPORT_MAX_ENTRIES })
  // Unrelated mutations protect the upstream source. Only the actual immutable
  // canonical withdrawal can remove its own accepted source, without adopting it.
  const associated = owners.filter(owner => owner.locationKey === locationKey && owner.sourcePath === relativePath)
  if (associated.length > 1) throw new Error(`Storage source has multiple canonical owners: ${relativePath}`)
  const association = associated[0]
  if (association) {
    if (mutation.entityType !== 'page' || association.pageId !== mutation.entityId || mutation.sourceOutboxId === undefined) return true
    const conflict = () => new Error(`Storage source withdrawal provenance is unreviewed: ${relativePath}. Preserve the source and review its canonical association before retrying.`)
    const durable = await transaction('durableJobs').where({
      id: job.id, type: 'storage-mutation', version: 2, state: 'running', leaseOwner: job.leaseOwner, leaseToken: job.leaseToken
    }).where('leaseExpiresAt', '>', new Date()).forShare().first('payload')
    if (!durable || JSON.stringify(StorageMutationPayloadSchema.parse(JSON.parse(durable.payload))) !== JSON.stringify(mutation)) throw conflict()
    const native = await transaction('pages').where({ id: mutation.entityId }).forShare()
      .first('id', 'path', 'localeCode', 'contentType', 'visibility', 'sourceRevision')
    if (association.moveBinding?.phase === 'moved' ||
        pagePath({ path: association.nativePath, localeCode: association.nativeLocaleCode, contentType }, target) !== relativePath) throw conflict()
    if (native) {
      if (association.status !== 'active' || native.visibility !== 'private' ||
          String(native.sourceRevision) !== mutation.sourceRevision ||
          native.path !== association.nativePath || native.localeCode !== association.nativeLocaleCode ||
          BigInt(association.nativeRevision) > BigInt(String(native.sourceRevision))) throw conflict()
    } else if (association.status !== 'deleted' || association.nativeRevision !== mutation.sourceRevision ||
        association.operationId !== mutation.sourceOutboxId) throw conflict()
    // Root pruning is permitted: the surviving immutable v2 intent remains the
    // authority. A surviving root must still identify the exact withdrawal.
    const event = await transaction('outboxEvents').where({ id: mutation.sourceOutboxId }).first('type', 'aggregateType', 'aggregateId', 'payload')
    if (event) {
      const payload: unknown = JSON.parse(event.payload)
      if (event.aggregateType !== 'page' || event.aggregateId !== String(mutation.entityId) ||
          event.type !== (native ? 'page.visibility-changed' : 'page.deleted') ||
          !isRecord(payload) || payload.pageId !== mutation.entityId ||
          payload.path !== association.nativePath || payload.localeCode !== association.nativeLocaleCode) throw conflict()
    }
    const root = getWiki().models.storage.activeTargets?.find(candidate => candidate.key === target.key)?.fn.root
    if (!root || root.closed || storageImportSourceKey(root.sourceIdentity, target.key === 'git' ? 'GIT' : 'DISK', config) !== association.sourceKey) throw conflict()
    try {
      const source = await root.openFile(relativePath)
      try {
        if (await source.sha256Bounded(IMPORT_MAX_BYTES) !== association.sourceSha256) throw conflict()
      } finally {
        await source.close()
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
    return false
  }
  const pages = await transaction<CanonicalPageIdentity>('pages')
    .where('visibility', 'public').forShare().limit(IMPORT_MAX_ENTRIES + 1).select('id', 'localeCode', 'path', 'contentType')
  if (pages.length > IMPORT_MAX_ENTRIES) throw new Error('Imported storage ownership inventory exceeds its bound')
  const identity = pageHelper.getPagePath(relativePath)
  assertNativeStoragePageIdentity(identity, relativePath)
  const candidates = [identity]
  if (config.mapReadmeToHome === true && (contentType === 'markdown' || contentType === 'asciidoc') && /^readme$/iu.test(identity.path)) {
    candidates.push({ locale: identity.locale, path: 'home' })
  }
  if (pages.some(page => {
    // The durable page producer recorded this exact former native filename.
    // A format conversion does not turn its own old encoding into an unknown import.
    if (mutation.entityType === 'page' && page.id === mutation.entityId &&
        pagePath({ ...page, contentType }, target) === relativePath) return false
    return candidates.some(candidate =>
      storageImportIdentityKey({ locale: page.localeCode, path: page.path }) === storageImportIdentityKey(candidate))
  })) {
    throw new Error(`Imported storage ownership is unreviewed: ${relativePath}`)
  }
  return false
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
    if (job.type !== 'storage-mutation' || (job.version !== 1 && job.version !== 2)) throw new TypeError('Invalid storage mutation job identity')
    const input = StorageMutationPayloadSchema.parse(job.payload)
    if (job.version === 1 && (input.sourceRevision !== undefined || input.sourceOutboxId !== undefined || input.changeReason !== undefined))
      throw new TypeError('Revision-bound storage work requires protocol 2')
    if (job.version === 2 && (input.entityType !== 'page' || input.sourceRevision === undefined))
      throw new TypeError('Protocol 2 requires a canonical page revision')
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
              if (!page && !asset && (await hasImportedPageOwner(transaction, relativePath, target, input, job))) continue
              if (page) {
                // Old reasonless jobs keep canonical convergence. New work must not
                // consume a newer revision before its own durable reason can run.
                if (
                  input.entityType === 'page' &&
                  page.id === input.entityId &&
                  input.sourceRevision !== undefined &&
                  String(page.sourceRevision) !== input.sourceRevision
                )
                  continue
                const changeReason =
                  input.targetKey === 'git' && input.entityType === 'page' && page.id === input.entityId && String(page.sourceRevision) === input.sourceRevision
                    ? input.changeReason
                    : undefined
                const exportedPage = changeReason === undefined ? page : { ...page, changeReason }
                const nativeTargetKey = target.key === 'disk' || target.key === 'git' ? target.key : undefined
                const [association] = nativeTargetKey !== undefined && job.version === 2 &&
                  input.entityType === 'page' && page.id === input.entityId && input.sourceOutboxId !== undefined &&
                  String(page.sourceRevision) === input.sourceRevision && page.ownerId === null
                  ? await loadStoragePageImportOwners(transaction, { pageIds: [page.id], limit: 1 })
                  : []
                const canAcknowledge = association !== undefined && association.status === 'active' &&
                  association.nativePath === page.path && association.nativeLocaleCode === page.localeCode &&
                  association.sourcePath === relativePath && association.locationKey === storageImportLocationKey(nativeTargetKey === 'git' ? 'GIT' : 'DISK', readConfig(target.config)) &&
                  BigInt(association.nativeRevision) <= BigInt(String(page.sourceRevision)) && association.moveBinding?.phase !== 'moved'
                if (canAcknowledge && nativeTargetKey !== undefined && input.sourceOutboxId !== undefined) {
                  let completionCount = 0
                  let proof: StoragePageExportProof | undefined
                  let invalidProof = false
                  let writing = true
                  const onWritten: StoragePageExportHook = async written => {
                    completionCount += 1
                    if (!writing || completionCount !== 1 || written.sourceKey !== association.sourceKey ||
                        written.locationKey !== association.locationKey || written.sourcePath !== relativePath ||
                        typeof written.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(written.sourceSha256)) {
                      invalidProof = true
                      throw new Error('Storage page export did not provide one exact same-source publication proof')
                    }
                    proof = {
                      sourceKey: written.sourceKey, locationKey: written.locationKey,
                      sourcePath: written.sourcePath, sourceSha256: written.sourceSha256
                    }
                  }
                  try {
                    await dispatch.writePage(exportedPage, onWritten)
                  } finally {
                    writing = false
                  }
                  if (invalidProof || completionCount !== 1 || proof === undefined) throw new Error('Storage page export did not complete its positive publication proof')
                  signal.throwIfAborted()
                  const currentTarget = await transaction<StorageTargetRow>('storage').where({ key: input.targetKey })
                    .first('key', 'isEnabled', 'mode', 'syncInterval', 'config')
                  if (!currentTarget || !currentTarget.isEnabled ||
                      nativeStorageMutationConfigurationKey({ ...currentTarget, config: readConfig(currentTarget.config) }) !== input.targetConfigurationRevision) {
                    throw new Error('Storage mutation target configuration is no longer current')
                  }
                  const turn = nativeTargetKey === 'git' ? currentGitMutationTurn() : undefined
                  if (turn !== undefined) {
                    if (turn.targetKey !== nativeTargetKey) throw new Error('Storage mutation Git turn does not match its target')
                    await turn.assertHeld(transaction)
                  }
                  await acknowledgeStoragePageExport(transaction, {
                    job, pageId: page.id, sourceRevision: String(page.sourceRevision), sourceOutboxId: input.sourceOutboxId,
                    targetKey: nativeTargetKey, targetConfigurationRevision: input.targetConfigurationRevision, proof
                  })
                  if (turn !== undefined) await turn.assertHeld(transaction)
                } else {
                  await dispatch.writePage(exportedPage)
                }
              } else if (asset) {
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
