import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { canonicalJson as encodeCanonicalJson, CanonicalJsonError } from '../helpers/canonical-json.ts'

export const PAGE_PROJECTION_EFFECT_KINDS = ['render', 'links', 'knowledge'] as const
export type PageProjectionEffectKind = (typeof PAGE_PROJECTION_EFFECT_KINDS)[number]
export type PageProjectionDesiredState = 'present' | 'absent'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const DecimalRevisionSchema = z.string().regex(/^[1-9][0-9]*$/)
const PageLocationSchema = z.strictObject({
  locale: z.string().min(1).max(35),
  path: z.string().min(1).max(1024),
  visibility: z.enum(['public', 'private']),
  ownerId: z.number().int().positive().nullable()
})
export const PageProjectionPayloadSchema = z.strictObject({
  version: z.literal(1),
  effectKind: z.enum(PAGE_PROJECTION_EFFECT_KINDS),
  desiredState: z.enum(['present', 'absent']),
  action: z.enum(['create', 'update', 'restore', 'convert', 'move', 'visibility', 'ownership', 'delete']),
  pageId: z.number().int().positive(),
  sourceRevision: DecimalRevisionSchema,
  sourceSha256: Sha256Schema.nullable(),
  location: PageLocationSchema.nullable(),
  previousLocation: PageLocationSchema.nullable()
})
export type PageProjectionPayload = z.infer<typeof PageProjectionPayloadSchema>

const PageProjectionSinkResultSchema = z.strictObject({
  result: z.record(z.string(), z.unknown()),
  postcondition: z.strictObject({
    satisfied: z.boolean(),
    observedSourceRevision: DecimalRevisionSchema.nullable(),
    detail: z.string().max(4_000)
  })
})
export type PageProjectionSinkResult = z.infer<typeof PageProjectionSinkResultSchema>

interface PageMutationOutboxRow {
  readonly id: string
  readonly pageId: number
  readonly sourceRevision: string | number
  readonly effectKind: string
  readonly effectKey: string
  readonly desiredState: string
  readonly payloadSha256: string
  readonly payload: string
  readonly status: string
  readonly attempts: number
  readonly leaseOwner: string | null
  readonly leaseToken: string | null
  readonly leaseExpiresAt: Date | string | null
  readonly availableAt: Date | string
  readonly result: string | null
  readonly postcondition: string | null
  readonly createdAt: Date | string
  readonly updatedAt: Date | string
}

export interface PageProjectionSink {
  readonly kind: PageProjectionEffectKind
  reconcile(payload: PageProjectionPayload, signal: AbortSignal): Promise<PageProjectionSinkResult>
}

export interface ClaimedPageProjectionEffect {
  readonly id: string
  readonly leaseToken: string
  readonly attempts: number
  readonly payload: PageProjectionPayload
}

export class PageMutationOutboxError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const canonicalJson = (value: unknown): string => {
  try {
    return encodeCanonicalJson(value)
  } catch (error: unknown) {
    if (error instanceof CanonicalJsonError) throw new PageMutationOutboxError(error.code, error.message)
    throw error
  }
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const revisionString = (value: string | number | bigint): string => {
  const revision = String(value)
  if (!/^[1-9][0-9]*$/.test(revision)) throw new PageMutationOutboxError('INVALID_SOURCE_REVISION', 'Page source revision is invalid')
  return revision
}

const parseRowPayload = (
  row: Pick<PageMutationOutboxRow, 'payload' | 'payloadSha256' | 'effectKind' | 'desiredState' | 'pageId' | 'sourceRevision'>
): PageProjectionPayload => {
  if (sha256(row.payload) !== row.payloadSha256)
    throw new PageMutationOutboxError('OUTBOX_PAYLOAD_TAMPERED', 'Page mutation outbox payload hash does not match')
  let decoded: unknown
  try {
    decoded = JSON.parse(row.payload)
  } catch {
    throw new PageMutationOutboxError('INVALID_OUTBOX_PAYLOAD', 'Page mutation outbox payload is invalid JSON')
  }
  const payload = PageProjectionPayloadSchema.safeParse(decoded)
  if (
    !payload.success ||
    payload.data.effectKind !== row.effectKind ||
    payload.data.desiredState !== row.desiredState ||
    payload.data.pageId !== Number(row.pageId) ||
    payload.data.sourceRevision !== revisionString(row.sourceRevision)
  ) {
    throw new PageMutationOutboxError('INVALID_OUTBOX_PAYLOAD', 'Page mutation outbox envelope does not match its indexed fields')
  }
  return payload.data
}

export const enqueuePageMutationEffects = async (
  knex: Knex | Knex.Transaction,
  input: {
    readonly pageId: number
    readonly sourceRevision: string | number | bigint
    readonly desiredState: PageProjectionDesiredState
    readonly action: PageProjectionPayload['action']
    readonly source?: string | Uint8Array
    readonly location?: z.infer<typeof PageLocationSchema>
    readonly previousLocation?: z.infer<typeof PageLocationSchema>
    readonly effects?: readonly PageProjectionEffectKind[]
  }
): Promise<readonly string[]> => {
  if (!Number.isSafeInteger(input.pageId) || input.pageId < 1) throw new PageMutationOutboxError('INVALID_PAGE_ID', 'Page mutation page ID is invalid')
  const sourceRevision = revisionString(input.sourceRevision)
  if (input.desiredState === 'present' && (input.source === undefined || input.location === undefined)) {
    throw new PageMutationOutboxError('INCOMPLETE_PRESENT_STATE', 'Present projection state requires exact source and location')
  }
  if (input.desiredState === 'absent' && (input.source !== undefined || input.location !== undefined)) {
    throw new PageMutationOutboxError('INVALID_ABSENT_STATE', 'Absent projection state cannot carry current source or location')
  }
  const effects = input.effects ?? PAGE_PROJECTION_EFFECT_KINDS
  if (new Set(effects).size !== effects.length || effects.some(effect => !PAGE_PROJECTION_EFFECT_KINDS.includes(effect))) {
    throw new PageMutationOutboxError('INVALID_EFFECT_SET', 'Page projection effects must be unique and supported')
  }
  const ids: string[] = []
  for (const effectKind of effects) {
    const payload = PageProjectionPayloadSchema.parse({
      version: 1,
      effectKind,
      desiredState: input.desiredState,
      action: input.action,
      pageId: input.pageId,
      sourceRevision,
      sourceSha256: input.source === undefined ? null : sha256(input.source),
      location: input.location ?? null,
      previousLocation: input.previousLocation ?? null
    })
    const encoded = canonicalJson(payload)
    const payloadSha256 = sha256(encoded)
    const id = randomUUID()
    const now = new Date().toISOString()
    await knex<PageMutationOutboxRow>('pageMutationOutbox')
      .insert({
        id,
        pageId: input.pageId,
        sourceRevision,
        effectKind,
        effectKey: `page:${input.pageId}:${effectKind}`,
        desiredState: input.desiredState,
        payloadSha256,
        payload: encoded,
        status: 'pending',
        attempts: 0,
        availableAt: now,
        createdAt: now,
        updatedAt: now
      })
      .onConflict(['pageId', 'sourceRevision', 'effectKind'])
      .ignore()
    const existing = await knex<PageMutationOutboxRow>('pageMutationOutbox').where({ pageId: input.pageId, sourceRevision, effectKind }).first()
    if (!existing || existing.payloadSha256 !== payloadSha256 || existing.payload !== encoded || existing.desiredState !== input.desiredState) {
      throw new PageMutationOutboxError('OUTBOX_IDEMPOTENCY_CONFLICT', 'Existing page projection effect has different immutable content')
    }
    ids.push(existing.id)
  }
  return ids
}

export const rearmFailedKnowledgeEffect = async (
  knex: Knex | Knex.Transaction,
  input: {
    readonly id: string
    readonly pageId: number
    readonly sourceRevision: string | number | bigint
    readonly source: string | Uint8Array
    readonly location: z.infer<typeof PageLocationSchema>
    readonly failedBefore: Date
    readonly now?: Date
  }
): Promise<boolean> => {
  if (!Number.isSafeInteger(input.pageId) || input.pageId < 1) throw new PageMutationOutboxError('INVALID_PAGE_ID', 'Page mutation page ID is invalid')
  const sourceRevision = revisionString(input.sourceRevision)
  const location = PageLocationSchema.parse(input.location)
  const existing = await knex<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ id: input.id, pageId: input.pageId, sourceRevision, effectKind: 'knowledge' })
    .first()
  if (!existing) return false
  const payload = parseRowPayload(existing)
  if (payload.desiredState !== 'present' || payload.sourceSha256 !== sha256(input.source) || canonicalJson(payload.location) !== canonicalJson(location)) {
    throw new PageMutationOutboxError('OUTBOX_IDEMPOTENCY_CONFLICT', 'Existing page projection effect has different immutable content')
  }
  const now = input.now ?? new Date()
  const updated = await knex<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ id: existing.id, status: 'failed' })
    .where('attempts', '>=', 5)
    .whereNull('leaseToken')
    .where('updatedAt', '<=', input.failedBefore.toISOString())
    .update({
      status: 'pending',
      attempts: 0,
      availableAt: now.toISOString(),
      result: null,
      postcondition: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now.toISOString()
    })
  return updated === 1
}

export const claimPageMutationEffects = async (
  knex: Knex,
  input: {
    readonly leaseOwner: string
    readonly limit?: number
    readonly leaseMs?: number
    readonly now?: Date
    readonly effects?: readonly PageProjectionEffectKind[]
  }
): Promise<readonly ClaimedPageProjectionEffect[]> => {
  if (!input.leaseOwner || input.leaseOwner.length > 255) throw new PageMutationOutboxError('INVALID_LEASE_OWNER', 'Projection lease owner is invalid')
  const limit = input.limit ?? 10
  const leaseMs = input.leaseMs ?? 60_000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
    throw new PageMutationOutboxError('INVALID_LEASE', 'Projection lease bounds are invalid')
  }
  const effects = input.effects ?? PAGE_PROJECTION_EFFECT_KINDS
  if (effects.length === 0 || new Set(effects).size !== effects.length || effects.some(effect => !PAGE_PROJECTION_EFFECT_KINDS.includes(effect))) {
    throw new PageMutationOutboxError('INVALID_EFFECT_SET', 'Projection claim effects must be unique and supported')
  }
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  return knex.transaction(async transaction => {
    await transaction<PageMutationOutboxRow>('pageMutationOutbox')
      .where('status', 'running')
      .where('leaseExpiresAt', '<=', nowIso)
      .update({ status: 'pending', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: nowIso })
    let claimQuery = transaction<PageMutationOutboxRow>('pageMutationOutbox')
      .whereIn('status', ['pending', 'retry'])
      .whereIn('effectKind', effects)
      .where('availableAt', '<=', nowIso)
      .orderBy('availableAt', 'asc')
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .forUpdate()
    const client = String(transaction.client.config.client)
    if (client === 'pg' || client === 'postgres' || client === 'postgresql' || client.includes('mysql')) claimQuery = claimQuery.skipLocked()
    const rows = await claimQuery
    const claimed: ClaimedPageProjectionEffect[] = []
    for (const row of rows) {
      const leaseToken = randomUUID()
      const updated = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
        .where({ id: row.id, status: row.status })
        .where(builder => builder.whereNull('leaseToken').orWhere('leaseExpiresAt', '<=', nowIso))
        .update({
          status: 'running',
          attempts: Number(row.attempts) + 1,
          leaseOwner: input.leaseOwner,
          leaseToken,
          leaseExpiresAt: new Date(now.valueOf() + leaseMs).toISOString(),
          updatedAt: nowIso
        })
      if (updated !== 1) continue
      claimed.push({ id: row.id, leaseToken, attempts: Number(row.attempts) + 1, payload: parseRowPayload(row) })
    }
    return claimed
  })
}

const finishClaim = async (knex: Knex, claim: Pick<ClaimedPageProjectionEffect, 'id' | 'leaseToken'>, update: Record<string, unknown>): Promise<void> => {
  const updated = await knex<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ id: claim.id, status: 'running', leaseToken: claim.leaseToken })
    .update({ ...update, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() })
  if (updated !== 1) throw new PageMutationOutboxError('PROJECTION_LEASE_LOST', 'Page projection effect lease was lost')
}

export const executePageMutationEffect = async (
  knex: Knex,
  claim: ClaimedPageProjectionEffect,
  sinks: ReadonlyMap<PageProjectionEffectKind, PageProjectionSink>,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) throw new PageMutationOutboxError('PROJECTION_ABORTED', 'Page projection execution was aborted')
  const sink = sinks.get(claim.payload.effectKind)
  if (!sink || sink.kind !== claim.payload.effectKind) {
    await finishClaim(knex, claim, { status: 'failed', result: JSON.stringify({ error: 'No conforming projection sink is registered' }) })
    throw new PageMutationOutboxError('MISSING_PROJECTION_SINK', `No conforming sink is registered for ${claim.payload.effectKind}`)
  }
  let rawResult: unknown
  try {
    rawResult = await sink.reconcile(claim.payload, signal)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.slice(0, 4_000) : 'Projection sink failed'
    await finishClaim(knex, claim, {
      status: claim.attempts < 5 ? 'retry' : 'failed',
      availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(claim.attempts, 6))).toISOString(),
      result: JSON.stringify({ error: message })
    })
    throw error
  }
  const result = PageProjectionSinkResultSchema.safeParse(rawResult)
  if (!result.success || !result.data.postcondition.satisfied) {
    await finishClaim(knex, claim, {
      status: 'failed',
      result: JSON.stringify(result.success ? result.data.result : { error: 'Sink returned an invalid result' }),
      postcondition: JSON.stringify(
        result.success ? result.data.postcondition : { satisfied: false, observedSourceRevision: null, detail: 'invalid sink result' }
      )
    })
    throw new PageMutationOutboxError('PROJECTION_POSTCONDITION_FAILED', 'Projection sink did not prove its postcondition')
  }
  await finishClaim(knex, claim, {
    status: 'succeeded',
    result: canonicalJson(result.data.result),
    postcondition: canonicalJson(result.data.postcondition)
  })
}
