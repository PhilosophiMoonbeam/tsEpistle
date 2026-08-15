import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

export type DurableJobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

interface DurableJobRow {
  id: string
  type: string
  version: number
  payload: string
  state: DurableJobState
  attempts: number
  maxAttempts: number
  nextRunAt: Date | string | number
  leaseOwner: string | null
  leaseExpiresAt: Date | string | number | null
  lastError: string | null
  deduplicationKey: string | null
  createdAt: Date | string | number
  updatedAt: Date | string | number
  completedAt: Date | string | number | null
}

export interface DurableJob<Payload = Record<string, unknown>> extends Omit<DurableJobRow, 'payload' | 'nextRunAt' | 'leaseExpiresAt' | 'createdAt' | 'updatedAt' | 'completedAt'> {
  payload: Payload
  nextRunAt: Date
  leaseExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface EnqueueDurableJob {
  type: string
  version: number
  payload: Record<string, unknown>
  maxAttempts?: number
  nextRunAt?: Date
  deduplicationKey?: string
}

export interface ClaimDurableJobs {
  workerId: string
  limit?: number
  leaseMs?: number
  now?: Date
}

export interface RunDurableJobsOptions extends ClaimDurableJobs {
  handlers: Readonly<Record<string, DurableJobHandler>>
  retryDelay?: (attempt: number) => number
}

export type DurableJobHandler = (job: DurableJob, context: { knex: Knex }) => Promise<void>

const tableName = 'durableJobs'
const defaultLeaseMs = 30_000
const defaultRetryDelay = (attempt: number): number => Math.min(300_000, 1_000 * (2 ** Math.max(0, attempt - 1)))
const validJobType = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const asDate = (value: Date | string | number): Date => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Durable job contains an invalid date')
  return date
}

const deserializeJob = (row: DurableJobRow): DurableJob => {
  const payload: unknown = JSON.parse(row.payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError(`Durable job ${row.id} payload must be an object`)
  }
  return {
    ...row,
    payload: payload as Record<string, unknown>,
    nextRunAt: asDate(row.nextRunAt),
    leaseExpiresAt: row.leaseExpiresAt === null ? null : asDate(row.leaseExpiresAt),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
    completedAt: row.completedAt === null ? null : asDate(row.completedAt)
  }
}

const applyEligiblePredicate = (query: Knex.QueryBuilder, now: Date): Knex.QueryBuilder =>
  query
    .where('nextRunAt', '<=', now)
    .whereRaw('?? < ??', ['attempts', 'maxAttempts'])
    .where((eligible: Knex.QueryBuilder) => {
      eligible.where('state', 'pending').orWhere((expired: Knex.QueryBuilder) => {
        expired.where('state', 'running').andWhere('leaseExpiresAt', '<=', now)
      })
    })

export class DurableJobStore {
  private readonly knex: Knex

  constructor(knex: Knex) {
    this.knex = knex
  }

  async enqueue(input: EnqueueDurableJob): Promise<DurableJob> {
    if (!validJobType.test(input.type)) throw new TypeError(`Invalid durable job type: ${input.type}`)
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new TypeError('Durable job version must be a positive integer')
    const maxAttempts = input.maxAttempts ?? 5
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new TypeError('Durable job maxAttempts must be an integer from 1 through 100')
    }
    const now = new Date()
    const row: DurableJobRow = {
      id: randomUUID(),
      type: input.type,
      version: input.version,
      payload: JSON.stringify(input.payload),
      state: 'pending',
      attempts: 0,
      maxAttempts,
      nextRunAt: input.nextRunAt ?? now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      deduplicationKey: input.deduplicationKey ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }

    try {
      await this.knex<DurableJobRow>(tableName).insert(row)
      return deserializeJob(row)
    } catch (error) {
      if (!input.deduplicationKey) throw error
      const existing = await this.knex<DurableJobRow>(tableName)
        .where('deduplicationKey', input.deduplicationKey)
        .first()
      if (!existing) throw error
      return deserializeJob(existing)
    }
  }

  async claim(input: ClaimDurableJobs): Promise<DurableJob[]> {
    if (!input.workerId || input.workerId.length > 128) throw new TypeError('workerId must contain 1 through 128 characters')
    const limit = input.limit ?? 10
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('claim limit must be an integer from 1 through 100')
    const leaseMs = input.leaseMs ?? defaultLeaseMs
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
      throw new TypeError('leaseMs must be an integer from 1000 through 3600000')
    }
    const now = input.now ?? new Date()
    const leaseExpiresAt = new Date(now.getTime() + leaseMs)
    const candidates = await applyEligiblePredicate(
      this.knex<DurableJobRow>(tableName).select('id'),
      now
    ).orderBy('nextRunAt', 'asc').orderBy('id', 'asc').limit(limit * 3) as Array<Pick<DurableJobRow, 'id'>>

    const claimed: DurableJob[] = []
    for (const candidate of candidates) {
      if (claimed.length >= limit) break
      const updated = await applyEligiblePredicate(
        this.knex<DurableJobRow>(tableName).where('id', candidate.id),
        now
      ).update({
        state: 'running',
        leaseOwner: input.workerId,
        leaseExpiresAt,
        attempts: this.knex.raw('?? + 1', ['attempts']),
        updatedAt: now
      })
      if (updated !== 1) continue
      const row = await this.knex<DurableJobRow>(tableName).where({ id: candidate.id, leaseOwner: input.workerId }).first()
      if (row) claimed.push(deserializeJob(row))
    }
    return claimed
  }

  async extendLease(job: DurableJob, leaseMs = defaultLeaseMs, now = new Date()): Promise<boolean> {
    const updated = await this.knex<DurableJobRow>(tableName)
      .where({ id: job.id, leaseOwner: job.leaseOwner, state: 'running' })
      .update({ leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    return updated === 1
  }

  async complete(job: DurableJob, now = new Date()): Promise<boolean> {
    const updated = await this.knex<DurableJobRow>(tableName)
      .where({ id: job.id, leaseOwner: job.leaseOwner, state: 'running' })
      .update({
        state: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: now,
        updatedAt: now
      })
    return updated === 1
  }

  async fail(job: DurableJob, error: unknown, retryDelay = defaultRetryDelay, now = new Date()): Promise<boolean> {
    const terminal = job.attempts >= job.maxAttempts
    const message = (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 8_000)
    const updated = await this.knex<DurableJobRow>(tableName)
      .where({ id: job.id, leaseOwner: job.leaseOwner, state: 'running' })
      .update({
        state: terminal ? 'failed' : 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: message,
        nextRunAt: terminal ? job.nextRunAt : new Date(now.getTime() + retryDelay(job.attempts)),
        completedAt: terminal ? now : null,
        updatedAt: now
      })
    return updated === 1
  }

  async cancel(id: string, now = new Date()): Promise<boolean> {
    const updated = await this.knex<DurableJobRow>(tableName)
      .where('id', id)
      .whereIn('state', ['pending', 'running'])
      .update({
        state: 'cancelled',
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now
      })
    return updated === 1
  }

  async retry(id: string, now = new Date()): Promise<boolean> {
    const updated = await this.knex<DurableJobRow>(tableName)
      .where({ id, state: 'failed' })
      .update({
        state: 'pending',
        attempts: 0,
        nextRunAt: now,
        lastError: null,
        completedAt: null,
        updatedAt: now
      })
    return updated === 1
  }

  async get(id: string): Promise<DurableJob | null> {
    const row = await this.knex<DurableJobRow>(tableName).where('id', id).first()
    return row ? deserializeJob(row) : null
  }
}

export const runDurableJobBatch = async (knex: Knex, options: RunDurableJobsOptions): Promise<DurableJob[]> => {
  const store = new DurableJobStore(knex)
  const claimed = await store.claim(options)
  await Promise.all(claimed.map(async job => {
    const handler = options.handlers[`${job.type}@${job.version}`]
    if (!handler) {
      await store.fail(job, new Error(`No handler registered for durable job ${job.type}@${job.version}`), options.retryDelay)
      return
    }
    try {
      await handler(job, { knex })
      await store.complete(job)
    } catch (error) {
      await store.fail(job, error, options.retryDelay)
    }
  }))
  return claimed
}
