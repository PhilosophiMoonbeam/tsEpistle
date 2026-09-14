import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { DurableJob, DurableJobHandler } from '../core/durable-jobs.ts'
import { DurableJobStore } from '../core/durable-jobs.ts'
import { isRecord } from '../models/moduleTypes.ts'
import { withAssetLocationLocks } from '../helpers/asset-location-lock.ts'
interface AssetRelocationPayload {
  operationId: string
  effectId: string
  assetId: number
  sourcePath: string
  destinationPath: string
  sourceHash: string
  destinationHash: string
  contentSha256: string
  targetKey: string
  targetConfigurationRevision: string
  authorName: string
  authorEmail: string
}

interface RelocationOperationRow {
  id: string
  assetId: number | null
  sourcePath: string
  destinationPath: string
  sourceHash: string
  destinationHash: string
  contentSha256: string
  status: string
  updatedAt: Date | string | number
  completedAt: Date | string | number | null
}

interface RelocationEffectRow {
  id: string
  operationId: string
  jobId: string
  assetId: number
  targetKey: string
  targetConfigurationRevision: string
  sourcePath: string
  destinationPath: string
  contentSha256: string
  status: string
  lastError: string | null
  updatedAt: Date | string | number
  completedAt: Date | string | number | null
}

interface AssetRow {
  id: number
  hash: string
}

interface AssetDataRow {
  id: number
  data: Buffer | Uint8Array | string
}

interface ExhaustedRelocationJobRow {
  id: string
  type: string
  version: number
  state: string
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseToken: string | null
  effectId: string
  operationId: string
  effectStatus: string
}

interface StorageModel {
  reconcileAssetRelocation(input: {
    id: number
    sourcePath: string
    destinationPath: string
    data: Buffer
    contentSha256: string
    targetKey: string
    targetConfigurationRevision: string
    authorName: string
    authorEmail: string
  }): Promise<void>
}

interface WikiContext {
  models: {
    storage: StorageModel
  }
}

const getWiki = (): WikiContext => (globalThis as unknown as { WIKI: WikiContext }).WIKI
const maxVisibleErrorLength = 1_024
const operationsTable = 'assetRelocationOperations'
const effectsTable = 'assetRelocationEffects'
const readPayload = (payload: unknown): AssetRelocationPayload => {
  if (!isRecord(payload)) throw new TypeError('Asset relocation job payload is invalid')
  const candidate = payload
  const readString = (key: Exclude<keyof AssetRelocationPayload, 'assetId'>): string => {
    const value = candidate[key]
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Asset relocation job payload is invalid')
    return value
  }
  const assetId = candidate.assetId
  if (typeof assetId !== 'number' || !Number.isSafeInteger(assetId) || assetId < 1) {
    throw new TypeError('Asset relocation job payload is invalid')
  }
  return {
    operationId: readString('operationId'),
    effectId: readString('effectId'),
    assetId,
    sourcePath: readString('sourcePath'),
    destinationPath: readString('destinationPath'),
    sourceHash: readString('sourceHash'),
    destinationHash: readString('destinationHash'),
    contentSha256: readString('contentSha256'),
    targetKey: readString('targetKey'),
    targetConfigurationRevision: readString('targetConfigurationRevision'),
    authorName: readString('authorName'),
    authorEmail: readString('authorEmail')
  }
}

const canonicalBytes = (data: AssetDataRow['data']): Buffer => {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  throw new TypeError('Asset relocation data is not binary')
}

const contentDigest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

const visibleError = (_error: unknown): string => 'Storage target reconciliation failed.'.slice(0, maxVisibleErrorLength)
class AssetRelocationIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetRelocationIntegrityError'
  }
}

type DurableLease = Pick<DurableJob, 'id' | 'leaseOwner' | 'leaseToken'>

const leaseIsCurrent = async (transaction: Knex.Transaction, job: DurableLease): Promise<boolean> => {
  if (!job.leaseOwner || !job.leaseToken) return false
  const row = await transaction('durableJobs')
    .where({ id: job.id, state: 'running', leaseOwner: job.leaseOwner, leaseToken: job.leaseToken })
    .where('leaseExpiresAt', '>', new Date())
    .first('id')
  return Boolean(row)
}

const requireCurrentLease = async (transaction: Knex.Transaction, job: DurableLease): Promise<void> => {
  if (!(await leaseIsCurrent(transaction, job))) throw new Error(`Asset relocation durable lease ${job.id} is no longer current`)
}

const refreshOperationStatus = async (transaction: Knex.Transaction, operationId: string, now: Date, job?: DurableLease): Promise<boolean> => {
  if (job && !(await leaseIsCurrent(transaction, job))) return false
  const effects = (await transaction<RelocationEffectRow>(effectsTable).where({ operationId }).select('status')) as Array<Pick<RelocationEffectRow, 'status'>>
  const terminal = effects.length > 0 && effects.every(effect => ['succeeded', 'superseded', 'failed'].includes(effect.status))
  const hasFailed = effects.some(effect => effect.status === 'failed')
  const hasSuperseded = effects.some(effect => effect.status === 'superseded')
  let status = 'pending'
  let completedAt: Date | null = null
  if (effects.length > 0 && effects.every(effect => effect.status === 'succeeded')) {
    status = 'succeeded'
    completedAt = now
  } else if (terminal && hasFailed) {
    status = 'failed'
    completedAt = now
  } else if (terminal && hasSuperseded) {
    status = 'superseded'
    completedAt = now
  } else if (effects.some(effect => effect.status === 'leased')) {
    status = 'leased'
  }
  if (job && !(await leaseIsCurrent(transaction, job))) return false
  const operationQuery = transaction<RelocationOperationRow>(operationsTable).where({ id: operationId })
  if (job) {
    operationQuery.whereExists(
      transaction('durableJobs')
        .select('id')
        .where({ id: job.id, state: 'running', leaseOwner: job.leaseOwner, leaseToken: job.leaseToken })
        .where('leaseExpiresAt', '>', new Date())
    )
  }
  await operationQuery.update({ status, updatedAt: now, completedAt })
  return true
}

const markEffect = async (
  transaction: Knex.Transaction,
  effectId: string,
  jobId: string,
  status: string,
  lastError: string | null,
  now: Date,
  job?: DurableLease
): Promise<boolean> => {
  if (job && !(await leaseIsCurrent(transaction, job))) return false
  const effectQuery = transaction<RelocationEffectRow>(effectsTable).where({ id: effectId, jobId }).whereIn('status', ['pending', 'leased', 'failed'])
  if (job) {
    effectQuery.whereExists(
      transaction('durableJobs')
        .select('id')
        .where({ id: job.id, state: 'running', leaseOwner: job.leaseOwner, leaseToken: job.leaseToken })
        .where('leaseExpiresAt', '>', new Date())
    )
  }
  const updated = await effectQuery.update({
    status,
    lastError,
    updatedAt: now,
    completedAt: status === 'succeeded' || status === 'superseded' || status === 'failed' ? now : null
  })
  return updated === 1
}

const EXHAUSTED_RELOCATION_ERROR = 'Durable job lease expired after its final allowed attempt'

export const failExhaustedAssetRelocationEffects = async (knex: Knex, now = new Date()): Promise<number> =>
  withAssetLocationLocks(
    ['assets'],
    () =>
      knex.transaction(async transaction => {
        const jobs = (await transaction('durableJobs as job')
          .join(`${effectsTable} as effect`, 'effect.jobId', 'job.id')
          .select(
            'job.id',
            'job.type',
            'job.version',
            'job.state',
            'job.attempts',
            'job.maxAttempts',
            'job.leaseOwner',
            'job.leaseToken',
            'effect.id as effectId',
            'effect.operationId as operationId',
            'effect.status as effectStatus'
          )
          .where({ 'job.type': 'asset-relocation', 'job.version': 1 })
          .whereRaw('?? >= ??', ['job.attempts', 'job.maxAttempts'])
          .whereIn('effect.status', ['pending', 'leased'])
          .andWhere(builder =>
            builder.where('job.state', 'failed').orWhere(running => running.where('job.state', 'running').where('job.leaseExpiresAt', '<=', now))
          )
          .orderBy('job.id', 'asc')
          .forUpdate('job')) as ExhaustedRelocationJobRow[]
        if (jobs.length === 0) return 0

        for (const job of jobs) {
          const effect = await transaction<RelocationEffectRow>(effectsTable).where({ id: job.effectId, jobId: job.id }).forUpdate().first()
          if (!effect) throw new Error(`Exhausted asset relocation effect ${job.effectId} is missing`)
          if (!['pending', 'leased'].includes(effect.status)) {
            await refreshOperationStatus(transaction, effect.operationId, now)
            continue
          }
          if (job.state === 'running') {
            const updated = await transaction('durableJobs')
              .where({
                id: job.id,
                type: 'asset-relocation',
                version: 1,
                state: 'running',
                leaseOwner: job.leaseOwner,
                leaseToken: job.leaseToken
              })
              .where('leaseExpiresAt', '<=', now)
              .whereRaw('?? >= ??', ['attempts', 'maxAttempts'])
              .update({
                state: 'failed',
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAt: null,
                lastError: EXHAUSTED_RELOCATION_ERROR,
                completedAt: now,
                updatedAt: now
              })
            if (updated !== 1) throw new Error(`Exhausted asset relocation job ${job.id} lost its lease fence`)
          }
          await markEffect(transaction, effect.id, job.id, 'failed', visibleError(new Error(EXHAUSTED_RELOCATION_ERROR)), now)
          await refreshOperationStatus(transaction, effect.operationId, now)
        }
        return jobs.length
      }),
    knex
  )

const recordEffectFailure = async (knex: Knex, effect: RelocationEffectRow, job: DurableJob, error: unknown): Promise<void> => {
  await knex.transaction(async transaction => {
    const integrityFailure = error instanceof AssetRelocationIntegrityError
    const terminal = integrityFailure || job.attempts >= job.maxAttempts
    const changed = await markEffect(transaction, effect.id, job.id, terminal ? 'failed' : 'pending', terminal ? visibleError(error) : null, new Date(), job)
    if (changed) await refreshOperationStatus(transaction, effect.operationId, new Date(), job)
  })
}

export const createAssetRelocationHandler =
  (): DurableJobHandler =>
  async (job, { knex, signal }) => {
    const payload = readPayload(job.payload)
    return withAssetLocationLocks(
      ['assets'],
      async assertHeld => {
        if (job.type !== 'asset-relocation' || job.version !== 1) throw new TypeError('Invalid asset relocation job identity')
        signal.throwIfAborted()
        if (typeof assertHeld !== 'function') throw new Error('Asset relocation lease assertion is unavailable')
        await assertHeld()

        let operation: RelocationOperationRow | undefined
        let effect: RelocationEffectRow | undefined
        let bytes: Buffer | undefined
        try {
          await knex.transaction(async transaction => {
            await requireCurrentLease(transaction, job)
            effect = await transaction<RelocationEffectRow>(effectsTable)
              .where({ id: payload.effectId, operationId: payload.operationId, jobId: job.id })
              .forUpdate()
              .first()
            if (!effect) throw new Error('Asset relocation effect is missing')
            if (effect.status === 'succeeded') {
              const refreshed = await refreshOperationStatus(transaction, effect.operationId, new Date(), job)
              if (!refreshed) throw new Error(`Asset relocation durable lease ${job.id} is no longer current`)
              return
            }
            if (effect.status === 'superseded') throw new Error('Asset relocation effect has an unresolved superseded state')
            operation = await transaction<RelocationOperationRow>(operationsTable).where({ id: payload.operationId }).forUpdate().first()
            if (!operation) throw new AssetRelocationIntegrityError('Asset relocation operation is missing')
            if (
              operation.assetId !== effect.assetId ||
              payload.assetId !== effect.assetId ||
              payload.sourcePath !== effect.sourcePath ||
              payload.destinationPath !== effect.destinationPath ||
              payload.contentSha256 !== effect.contentSha256 ||
              payload.targetKey !== effect.targetKey ||
              payload.targetConfigurationRevision !== effect.targetConfigurationRevision ||
              payload.sourceHash !== operation.sourceHash ||
              payload.destinationHash !== operation.destinationHash ||
              payload.contentSha256 !== operation.contentSha256 ||
              operation.sourcePath !== effect.sourcePath ||
              operation.destinationPath !== effect.destinationPath
            ) {
              throw new AssetRelocationIntegrityError('Asset relocation effect integrity check failed')
            }
            const asset = await transaction<AssetRow>('assets').where({ id: effect.assetId }).forUpdate().first('id', 'hash')
            if (!asset || asset.hash !== operation.destinationHash) {
              throw new AssetRelocationIntegrityError('Asset relocation canonical identity no longer matches its ledger')
            }
            const dataRow = await transaction<AssetDataRow>('assetData').where({ id: effect.assetId }).first('id', 'data')
            if (!dataRow) throw new AssetRelocationIntegrityError('Asset relocation canonical bytes are unavailable')
            let canonical: Buffer
            try {
              canonical = canonicalBytes(dataRow.data)
            } catch {
              throw new AssetRelocationIntegrityError('Asset relocation data is not binary')
            }
            bytes = canonical
            if (contentDigest(canonical) !== operation.contentSha256 || operation.contentSha256 !== effect.contentSha256) {
              throw new AssetRelocationIntegrityError('Asset relocation content integrity check failed')
            }
            await requireCurrentLease(transaction, job)
            const changed = await markEffect(transaction, effect.id, job.id, 'leased', null, new Date(), job)
            if (!changed) throw new Error(`Asset relocation durable lease ${job.id} is no longer current`)
            const refreshed = await refreshOperationStatus(transaction, effect.operationId, new Date(), job)
            if (!refreshed) throw new Error(`Asset relocation durable lease ${job.id} is no longer current`)
          })
        } catch (error) {
          if (effect) await recordEffectFailure(knex, effect, job, error)
          throw error
        }
        if (!operation || !effect || !bytes) return

        await assertHeld()
        await knex.transaction(async transaction => {
          await requireCurrentLease(transaction, job)
        })
        signal.throwIfAborted()
        try {
          await assertHeld()
          await getWiki().models.storage.reconcileAssetRelocation({
            id: effect.assetId,
            sourcePath: effect.sourcePath,
            destinationPath: effect.destinationPath,
            data: bytes,
            contentSha256: effect.contentSha256,
            targetKey: effect.targetKey,
            targetConfigurationRevision: effect.targetConfigurationRevision,
            authorName: payload.authorName,
            authorEmail: payload.authorEmail
          })
          signal.throwIfAborted()
          await assertHeld()
          await knex.transaction(async transaction => {
            const changed = await markEffect(transaction, effect!.id, job.id, 'succeeded', null, new Date(), job)
            if (!changed) throw new Error(`Asset relocation durable lease ${job.id} is no longer current`)
            await refreshOperationStatus(transaction, effect!.operationId, new Date(), job)
          })
        } catch (error) {
          await recordEffectFailure(knex, effect, job, error)
          throw error
        }
      },
      knex
    )
  }

export const enqueueAssetRelocationEffect = async (
  transaction: Knex.Transaction,
  input: Omit<AssetRelocationPayload, 'effectId'> & { operationId: string }
): Promise<{ effectId: string; jobId: string }> => {
  const effectId = randomUUID()
  const job = await new DurableJobStore(transaction).enqueue({
    type: 'asset-relocation',
    version: 1,
    payload: { ...input, effectId },
    deduplicationKey: `asset-relocation:${input.operationId}:${input.targetKey}:${input.targetConfigurationRevision}`
  })
  await transaction(effectsTable).insert({
    id: effectId,
    operationId: input.operationId,
    jobId: job.id,
    assetId: input.assetId,
    targetKey: input.targetKey,
    targetConfigurationRevision: input.targetConfigurationRevision,
    sourcePath: input.sourcePath,
    destinationPath: input.destinationPath,
    contentSha256: input.contentSha256,
    status: 'pending',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null
  })
  return { effectId, jobId: job.id }
}
