import type { Knex } from 'knex'
import { z } from 'zod'
import type { DurableJob } from '../core/durable-jobs.ts'
import { hasAsciiControlCharacters } from '../../shared/text-safety.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n)
const sourcePath = z.string().min(1).max(4096).refine(value =>
  !value.includes('\\') && !hasAsciiControlCharacters(value) && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
)
const nativePath = z.string().min(1).max(2048)
const locale = z.string().min(1).max(255).regex(/^[^\s/\\]+$/u).refine(value => !hasAsciiControlCharacters(value))
const ownerSchema = z.strictObject({ sourceKey: digest, sourcePath, sourceSha256: digest, locationKey: digest, mapped: z.boolean() })
const moveBindingSchema = z.strictObject({
  phase: z.enum(['moved', 'completed']),
  fromGitRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  toGitRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  oldSourcePath: sourcePath,
  newSourcePath: sourcePath,
  oldSourceSha256: digest,
  newSourceSha256: digest,
  previousNativeRevision: revision,
  previousNativePath: nativePath,
  previousNativeLocaleCode: locale,
  moveOperationId: z.string().uuid(),
  moveNativeRevision: revision
})
export type StoragePageImportMoveBinding = z.infer<typeof moveBindingSchema>

const recordSchema = ownerSchema.extend({
  pageId: z.number().int().positive().safe(),
  nativeRevision: z.union([z.string(), z.number().int().positive().safe(), z.bigint()]).transform(String).pipe(revision),
  nativePath,
  nativeLocaleCode: locale,
  status: z.enum(['active', 'deleted']),
  operationId: z.string().uuid(),
  moveBinding: moveBindingSchema.nullable(),
  updatedAt: z.union([z.date(), z.string().datetime({ offset: true })]),
  deletedAt: z.union([z.date(), z.string().datetime({ offset: true })]).nullable()
})
export type StoragePageImportOwnerRecord = z.infer<typeof recordSchema>

export interface StoragePageExportProof {
  readonly sourceKey: string
  readonly locationKey: string
  readonly sourcePath: string
  readonly sourceSha256: string
}
export type StoragePageExportHook = (proof: StoragePageExportProof) => Promise<void>
const exportProofSchema = ownerSchema.omit({ mapped: true })
const nativeExportIntentSchema = z.object({
  entityType: z.literal('page'),
  entityId: z.number().int().positive().safe(),
  sourceRevision: revision,
  sourceOutboxId: z.string().uuid(),
  targetKey: z.enum(['disk', 'git']),
  targetConfigurationRevision: z.string().min(1),
  paths: z.array(sourcePath).min(1).max(2)
})

interface CanonicalPageIdentity {
  id: number
  sourceRevision: string | number | bigint
  path: string
  localeCode: string
}
interface CanonicalOwnerPage extends CanonicalPageIdentity {
  visibility: string
  ownerId: number | null
}
interface CanonicalRootEvent {
  id: string
  type: string
  aggregateType: string
  aggregateId: string
  payload: string
}
const acceptedInputSchema = z.strictObject({ pageId: z.number().int().positive().safe(), sourceRevision: revision, outboxId: z.string().uuid() })
const inventoryLimit = 10_000

const readOwnerRecord = (row: Record<string, unknown>): StoragePageImportOwnerRecord => {
  const moveBinding: unknown = typeof row.moveBinding === 'string' ? JSON.parse(row.moveBinding) : row.moveBinding
  const result = recordSchema.parse({ ...row, moveBinding })
  if ((result.status === 'active') !== (result.deletedAt === null)) throw new Error('Storage import owner status is inconsistent')
  return result
}

/** Inventory is always bounded, including filtered reads and retired identities. */
export async function loadStoragePageImportOwners(
  db: Knex | Knex.Transaction,
  input: { sourceKey?: string; pageIds?: readonly number[]; limit: number }
): Promise<StoragePageImportOwnerRecord[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > inventoryLimit) throw new RangeError('Storage import owner inventory limit must be from 1 through 10000')
  if (input.sourceKey !== undefined) digest.parse(input.sourceKey)
  if (input.pageIds !== undefined) {
    z.array(z.number().int().positive().safe()).max(inventoryLimit).parse(input.pageIds)
    if (input.pageIds.length === 0) return []
  }
  let query = db<Record<string, unknown>>('storagePageImportOwners').orderBy('pageId').limit(input.limit + 1)
  if (input.sourceKey !== undefined) query = query.where({ sourceKey: input.sourceKey })
  if (input.pageIds !== undefined) query = query.whereIn('pageId', input.pageIds)
  const rows = await query
  if (rows.length > input.limit) throw new RangeError('Storage import owner inventory exceeds its bound')
  return rows.map(readOwnerRecord)
}

/** A source receipt never follows later human/Agent revisions merely by page id. */
export function storagePageImportOwnerMatches(record: StoragePageImportOwnerRecord, page: CanonicalPageIdentity): boolean {
  return record.status === 'active' && record.pageId === page.id && record.nativeRevision === String(page.sourceRevision) &&
    record.nativePath === page.path && record.nativeLocaleCode === page.localeCode
}

const loadCanonicalAcceptance = async (
  transaction: Knex.Transaction,
  input: z.infer<typeof acceptedInputSchema>,
  eventTypes: readonly string[]
): Promise<{ page: CanonicalOwnerPage; event: CanonicalRootEvent }> => {
  const page = await transaction<CanonicalOwnerPage>('pages').where({ id: input.pageId }).forUpdate().first('id', 'sourceRevision', 'path', 'localeCode', 'visibility', 'ownerId')
  const event = await transaction<CanonicalRootEvent>('outboxEvents').where({ id: input.outboxId, aggregateType: 'page', aggregateId: String(input.pageId) }).first('id', 'type', 'aggregateType', 'aggregateId', 'payload')
  if (!page || String(page.sourceRevision) !== input.sourceRevision || !event || !eventTypes.includes(event.type)) {
    throw new Error('Storage import ownership requires the exact same-transaction native acceptance')
  }
  const payload: unknown = JSON.parse(event.payload)
  if (typeof payload !== 'object' || payload === null || Reflect.get(payload, 'pageId') !== page.id ||
      Reflect.get(payload, 'path') !== page.path || Reflect.get(payload, 'localeCode') !== page.localeCode) {
    throw new Error('Storage import ownership native root event does not match its canonical page')
  }
  return { page, event }
}

/** Called only by the accepted native import hook, never by generic metadata writes. */
export async function recordStoragePageImportOwner(
  transaction: Knex.Transaction,
  input: {
    owner: { sourceKey: string; sourcePath: string; sourceSha256: string; locationKey: string; mapped: boolean }
    pageId: number
    sourceRevision: string
    outboxId: string
    moveBinding?: StoragePageImportMoveBinding | null
  }
): Promise<StoragePageImportOwnerRecord> {
  const accepted = acceptedInputSchema.parse({ pageId: input.pageId, sourceRevision: input.sourceRevision, outboxId: input.outboxId })
  const owner = ownerSchema.parse(input.owner)
  const moveBinding = input.moveBinding === undefined || input.moveBinding === null ? null : moveBindingSchema.parse(input.moveBinding)
  const { page, event } = await loadCanonicalAcceptance(transaction, accepted, ['page.created', 'page.updated', 'page.moved'])
  if (page.visibility !== 'public' || page.ownerId !== null) throw new Error('Storage import ownership requires a public native page')
  const existingRow = await transaction<Record<string, unknown>>('storagePageImportOwners').where({ pageId: input.pageId }).forUpdate().first()
  const existing = existingRow === undefined ? undefined : readOwnerRecord(existingRow)
  if (moveBinding !== null) {
    const actualMove = event.type === 'page.moved' && moveBinding.moveOperationId === accepted.outboxId && moveBinding.moveNativeRevision === accepted.sourceRevision
    if (actualMove) {
      if (!existing || existing.status !== 'active' || existing.nativeRevision !== moveBinding.previousNativeRevision ||
          existing.nativePath !== moveBinding.previousNativePath || existing.nativeLocaleCode !== moveBinding.previousNativeLocaleCode ||
          existing.sourceKey !== owner.sourceKey || existing.locationKey !== owner.locationKey ||
          existing.sourcePath !== moveBinding.oldSourcePath || existing.sourceSha256 !== moveBinding.oldSourceSha256) {
        throw new Error('Storage import move requires its exact previously accepted native source')
      }
    } else {
      const previousBinding = existing?.moveBinding
      if (moveBinding.phase !== 'completed' || !existing || existing.status !== 'active' || previousBinding === null || previousBinding === undefined ||
          existing.nativeRevision !== moveBinding.moveNativeRevision || existing.sourceKey !== owner.sourceKey || existing.locationKey !== owner.locationKey ||
          Object.entries(moveBinding).some(([key, value]) => key !== 'phase' && Reflect.get(previousBinding, key) !== value)) {
        throw new Error('Storage import completion requires its exact durable native move receipt')
      }
    }
  }
  const now = new Date()
  const [row] = await transaction<Record<string, unknown>>('storagePageImportOwners').insert({
    ...owner, pageId: page.id, nativeRevision: accepted.sourceRevision, nativePath: page.path, nativeLocaleCode: page.localeCode,
    status: 'active', operationId: accepted.outboxId, moveBinding, updatedAt: now, deletedAt: null
  }).onConflict('pageId').merge().returning('*')
  if (!row) throw new Error('Storage import ownership acceptance did not persist its receipt')
  return readOwnerRecord(row)
}

/** Canonical deletion retires an association even when storage targets are disabled. */
export async function markStoragePageImportOwnerDeleted(
  transaction: Knex.Transaction,
  input: { pageId: number; sourceRevision: string; outboxId: string }
): Promise<void> {
  const accepted = acceptedInputSchema.parse(input)
  // Canonical callers hold the page lock before entering the ownership ledger.
  const existing = await transaction('storagePageImportOwners').where({ pageId: input.pageId }).forUpdate().first('pageId')
  if (!existing) return
  const { page } = await loadCanonicalAcceptance(transaction, accepted, ['page.deleted'])
  const now = new Date()
  await transaction('storagePageImportOwners').where({ pageId: input.pageId }).update({
    status: 'deleted', nativeRevision: accepted.sourceRevision, nativePath: page.path, nativeLocaleCode: page.localeCode,
    operationId: accepted.outboxId, updatedAt: now, deletedAt: now
  })
}

/** A positive native publication can advance only its already active source association. */
export async function acknowledgeStoragePageExport(
  transaction: Knex.Transaction,
  input: {
    job: Pick<DurableJob, 'id' | 'leaseOwner' | 'leaseToken'>
    pageId: number
    sourceRevision: string
    sourceOutboxId: string
    targetKey: 'disk' | 'git'
    targetConfigurationRevision: string
    proof: StoragePageExportProof
  }
): Promise<void> {
  const accepted = acceptedInputSchema.parse({ pageId: input.pageId, sourceRevision: input.sourceRevision, outboxId: input.sourceOutboxId })
  const proof = exportProofSchema.parse(input.proof)
  if (!input.job.leaseOwner || !input.job.leaseToken) throw new Error('Storage export acknowledgement requires its current durable lease')
  // Read the actual immutable intent, not a caller-supplied payload or a surviving
  // root-event lookup. Its original UUID remains authoritative after root pruning.
  const durable = await transaction<Pick<DurableJob, 'id' | 'type' | 'version' | 'state' | 'leaseOwner' | 'leaseToken'> & { payload: string }>('durableJobs')
    .where({ id: input.job.id, type: 'storage-mutation', version: 2, state: 'running',
      leaseOwner: input.job.leaseOwner, leaseToken: input.job.leaseToken })
    .where('leaseExpiresAt', '>', new Date()).forShare().first('payload')
  if (!durable) throw new Error('Storage export acknowledgement durable intent or lease is no longer current')
  const payload: unknown = JSON.parse(durable.payload)
  const intent = nativeExportIntentSchema.parse(payload)
  if (intent.entityId !== accepted.pageId || intent.sourceRevision !== accepted.sourceRevision ||
      intent.sourceOutboxId !== accepted.outboxId || intent.targetKey !== input.targetKey ||
      intent.targetConfigurationRevision !== input.targetConfigurationRevision || !intent.paths.includes(proof.sourcePath)) {
    throw new Error('Storage export acknowledgement does not match its actual durable intent')
  }
  const page = await transaction<CanonicalOwnerPage>('pages').where({ id: accepted.pageId, visibility: 'public', ownerId: null })
    .forShare().first('id', 'sourceRevision', 'path', 'localeCode', 'visibility', 'ownerId')
  if (!page || String(page.sourceRevision) !== accepted.sourceRevision) throw new Error('Storage export acknowledgement native revision is no longer current')
  const event = await transaction<CanonicalRootEvent>('outboxEvents').where({ id: accepted.outboxId })
    .first('id', 'type', 'aggregateType', 'aggregateId', 'payload')
  if (event) {
    const rootPayload: unknown = JSON.parse(event.payload)
    if (event.aggregateType !== 'page' || event.aggregateId !== String(page.id) ||
        !['page.created', 'page.updated', 'page.moved', 'page.visibility-changed', 'page.restored'].includes(event.type) ||
        typeof rootPayload !== 'object' || rootPayload === null || Reflect.get(rootPayload, 'pageId') !== page.id ||
        Reflect.get(rootPayload, 'path') !== page.path || Reflect.get(rootPayload, 'localeCode') !== page.localeCode) {
      throw new Error('Storage export acknowledgement canonical root does not match its native page')
    }
  }
  const row = await transaction<Record<string, unknown>>('storagePageImportOwners').where({ pageId: accepted.pageId }).forUpdate().first()
  const owner = row === undefined ? undefined : readOwnerRecord(row)
  if (!owner || owner.status !== 'active' || owner.sourceKey !== proof.sourceKey || owner.locationKey !== proof.locationKey ||
      owner.sourcePath !== proof.sourcePath || owner.nativePath !== page.path || owner.nativeLocaleCode !== page.localeCode ||
      BigInt(owner.nativeRevision) > BigInt(accepted.sourceRevision) || owner.moveBinding?.phase === 'moved') {
    throw new Error('Storage export acknowledgement requires its existing active same-source association')
  }
  if (owner.nativeRevision === accepted.sourceRevision && owner.sourceSha256 === proof.sourceSha256 && owner.operationId === accepted.outboxId) return
  const moveBinding = owner.moveBinding?.phase === 'completed' ? null : owner.moveBinding
  const updated = await transaction('storagePageImportOwners').where({ pageId: page.id, status: 'active' }).update({
    nativeRevision: accepted.sourceRevision, sourceSha256: proof.sourceSha256, operationId: accepted.outboxId,
    moveBinding, updatedAt: new Date()
  })
  if (updated !== 1) throw new Error('Storage export acknowledgement did not update its existing association')
}
