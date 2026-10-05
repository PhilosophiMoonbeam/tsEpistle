import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { canonicalJson as encodeCanonicalJson, CanonicalJsonError } from '../helpers/canonical-json.ts'
import { load } from 'cheerio'
import { lockSearchIndex, lockSearchPage } from '../helpers/search-contract.ts'

export const PAGE_PROJECTION_EFFECT_KINDS = ['render', 'links', 'search', 'knowledge'] as const
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
export type PageRenderEffectStatus = 'pending' | 'leased' | 'succeeded' | 'failed' | 'superseded'

export interface PageRenderEffectStatusView {
  readonly effectId: string
  readonly pageId: number
  readonly sourceRevision: string
  readonly status: PageRenderEffectStatus
  readonly result: unknown
  readonly postcondition: unknown
}

type PageLocationInput = z.infer<typeof PageLocationSchema>

export interface PageProjectionSink {
  readonly kind: PageProjectionEffectKind
  reconcile(
    payload: PageProjectionPayload,
    signal: AbortSignal,
    claim?: Pick<ClaimedPageProjectionEffect, 'id' | 'leaseToken'>
  ): Promise<PageProjectionSinkResult>
}
export type PageProjectionSinks =
  | ReadonlyMap<PageProjectionEffectKind, PageProjectionSink>
  | Readonly<Partial<Record<PageProjectionEffectKind, PageProjectionSink>>>

export interface ClaimedPageProjectionEffect {
  readonly id: string
  readonly leaseToken: string
  readonly attempts: number
  readonly payload: PageProjectionPayload
}

export interface PageRenderPublicationFence {
  readonly effectId: string
  readonly leaseToken: string
  readonly sourceRevision: string
  readonly sourceSha256: string
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

export const rearmPageMutationEffect = async (
  knex: Knex | Knex.Transaction,
  input: {
    readonly id: string
    readonly payload: PageProjectionPayload
    readonly now?: Date
  }
): Promise<boolean> => {
  const expected = PageProjectionPayloadSchema.safeParse(input.payload)
  if (!expected.success) throw new PageMutationOutboxError('INVALID_OUTBOX_PAYLOAD', 'Expected page projection payload is invalid')
  const existing = await knex<PageMutationOutboxRow>('pageMutationOutbox').where({ id: input.id }).first()
  if (!existing) return false
  parseRowPayload(existing)
  const encoded = canonicalJson(expected.data)
  const payloadSha256 = sha256(encoded)
  const effectKey = `page:${expected.data.pageId}:${expected.data.effectKind}`
  if (existing.payload !== encoded || existing.payloadSha256 !== payloadSha256 || existing.effectKey !== effectKey) {
    throw new PageMutationOutboxError('OUTBOX_IDEMPOTENCY_CONFLICT', 'Existing page projection effect has different immutable content')
  }
  const now = input.now ?? new Date()
  const updated = await knex<PageMutationOutboxRow>('pageMutationOutbox')
    .where({
      id: existing.id,
      pageId: expected.data.pageId,
      sourceRevision: expected.data.sourceRevision,
      effectKind: expected.data.effectKind,
      effectKey,
      desiredState: expected.data.desiredState,
      payload: encoded,
      payloadSha256
    })
    .whereIn('status', ['succeeded', 'failed'])
    .whereNull('leaseToken')
    .update({
      status: 'retry',
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
export const admitPageRenderEffect = async (
  knex: Knex | Knex.Transaction,
  input: {
    readonly pageId: number
    readonly sourceRevision: string | number | bigint
    readonly source: string | Uint8Array
    readonly location: PageLocationInput
    readonly action?: PageProjectionPayload['action']
    readonly now?: Date
  }
): Promise<{ readonly effectId: string; readonly sourceRevision: string }> => {
  if (!Number.isSafeInteger(input.pageId) || input.pageId < 1) throw new PageMutationOutboxError('INVALID_PAGE_ID', 'Page mutation page ID is invalid')
  const sourceRevision = revisionString(input.sourceRevision)
  const location = PageLocationSchema.parse(input.location)
  return withLockedProjectionPage(knex, input.pageId, async (transaction, page) => {
    if (
      !page ||
      revisionString(page.sourceRevision) !== sourceRevision ||
      sha256(page.content) !== sha256(input.source) ||
      !pageLocationMatches(page, location)
    ) {
      throw new PageMutationOutboxError('OUTBOX_IDEMPOTENCY_CONFLICT', 'Render admission does not match the current page source')
    }
    const render = await admitCurrentEffect(transaction, page, 'render', {
      rearm: true,
      action: input.action ?? 'update',
      ...(input.now === undefined ? {} : { now: input.now })
    })
    if (render.changed) {
      await invalidateRenderedProjections(transaction, page.id)
      for (const kind of ['links', 'search'] as const) {
        await admitCurrentEffect(transaction, page, kind, {
          rearm: true,
          fenceRunning: true,
          ...(input.now === undefined ? {} : { now: input.now })
        })
      }
    }
    return { effectId: render.id, sourceRevision }
  })
}

export const supersedeStalePageRenderEffects = async (
  knex: Knex | Knex.Transaction,
  input: { readonly pageId: number; readonly sourceRevision: string | number | bigint; readonly now?: Date }
): Promise<void> => {
  if (!Number.isSafeInteger(input.pageId) || input.pageId < 1) throw new PageMutationOutboxError('INVALID_PAGE_ID', 'Page mutation page ID is invalid')
  const sourceRevision = revisionString(input.sourceRevision)
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  await knex<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ pageId: input.pageId, effectKind: 'render' })
    .whereNot('sourceRevision', sourceRevision)
    .whereIn('status', ['pending', 'retry'])
    .whereNull('leaseToken')
    .update({
      status: 'superseded',
      result: canonicalJson({ superseded: true }),
      postcondition: canonicalJson({
        satisfied: true,
        observedSourceRevision: sourceRevision,
        detail: 'Render intent was superseded by a newer page source revision'
      }),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso
    })
}

const storedJson = (value: string | null): unknown => {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const resultIsSuperseded = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Reflect.get(value, 'superseded') === true

export const readPageRenderEffectStatus = async (
  knex: Knex | Knex.Transaction,
  input: { readonly effectId: string; readonly now?: Date }
): Promise<PageRenderEffectStatusView | null> => {
  if (typeof input.effectId !== 'string' || input.effectId.length === 0 || input.effectId.length > 255) return null
  const effect = await knex<PageMutationOutboxRow>('pageMutationOutbox').where({ id: input.effectId, effectKind: 'render' }).first()
  if (!effect) return null
  const payload = parseRowPayload(effect)
  const currentPage = await knex<{ id: number; sourceRevision: string | number }>('pages').select('sourceRevision').where({ id: effect.pageId }).first()
  const currentRevision = currentPage ? revisionString(currentPage.sourceRevision) : null
  const result = storedJson(effect.result)
  const superseded = currentRevision !== payload.sourceRevision || effect.status === 'superseded' || resultIsSuperseded(result)
  const now = input.now ?? new Date()
  const leaseExpiresAt = effect.leaseExpiresAt === null ? null : new Date(effect.leaseExpiresAt).getTime()
  const leased = effect.leaseToken !== null && leaseExpiresAt !== null && leaseExpiresAt > now.getTime()
  const status: PageRenderEffectStatus = superseded
    ? 'superseded'
    : effect.status === 'succeeded'
      ? 'succeeded'
      : effect.status === 'failed'
        ? 'failed'
        : leased
          ? 'leased'
          : 'pending'
  return {
    effectId: effect.id,
    pageId: Number(effect.pageId),
    sourceRevision: payload.sourceRevision,
    status,
    result,
    postcondition: storedJson(effect.postcondition)
  }
}

const PAGE_MUTATION_OUTBOX_CLAIM_LOCK_NAMESPACE = 0x57494b4f

const isPostgres = (knex: Knex | Knex.Transaction): boolean => {
  const client = String(knex.client.config.client)
  return client === 'pg' || client === 'postgres' || client === 'postgresql'
}

const acquirePageMutationClaimLocks = async (transaction: Knex.Transaction, effects: readonly PageProjectionEffectKind[]): Promise<void> => {
  if (!isPostgres(transaction)) return
  for (const effect of [...effects].sort()) {
    await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [PAGE_MUTATION_OUTBOX_CLAIM_LOCK_NAMESPACE, effect])
  }
}

export const claimPageMutationEffects = async (
  knex: Knex,
  input: {
    readonly leaseOwner: string
    readonly limit?: number
    readonly maxActive?: number
    readonly leaseMs?: number
    readonly now?: Date
    readonly effects?: readonly PageProjectionEffectKind[]
  }
): Promise<readonly ClaimedPageProjectionEffect[]> => {
  if (!input.leaseOwner || input.leaseOwner.length > 255) throw new PageMutationOutboxError('INVALID_LEASE_OWNER', 'Projection lease owner is invalid')
  const limit = input.limit ?? 10
  const leaseMs = input.leaseMs ?? 60_000
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 128 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1_000 ||
    leaseMs > 10 * 60_000 ||
    (input.maxActive !== undefined && (!Number.isSafeInteger(input.maxActive) || input.maxActive < 1 || input.maxActive > 128))
  ) {
    throw new PageMutationOutboxError('INVALID_LEASE', 'Projection lease bounds are invalid')
  }
  const effects = input.effects ?? PAGE_PROJECTION_EFFECT_KINDS
  if (effects.length === 0 || new Set(effects).size !== effects.length || effects.some(effect => !PAGE_PROJECTION_EFFECT_KINDS.includes(effect))) {
    throw new PageMutationOutboxError('INVALID_EFFECT_SET', 'Projection claim effects must be unique and supported')
  }
  return knex.transaction(async transaction => {
    if (input.maxActive !== undefined) await acquirePageMutationClaimLocks(transaction, effects)
    const now = input.now ?? new Date()
    const nowIso = now.toISOString()
    let expiredLeases = transaction<PageMutationOutboxRow>('pageMutationOutbox').where('status', 'running').where('leaseExpiresAt', '<=', nowIso)
    if (input.maxActive !== undefined) expiredLeases = expiredLeases.whereIn('effectKind', effects)
    await expiredLeases.update({ status: 'pending', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: nowIso })
    const active =
      input.maxActive === undefined
        ? 0
        : Number(
            (
              await transaction<PageMutationOutboxRow>('pageMutationOutbox')
                .where('status', 'running')
                .whereIn('effectKind', effects)
                .where('leaseExpiresAt', '>', nowIso)
                .count<{ count: string }>({ count: '*' })
                .first()
            )?.count ?? 0
          )
    const claimLimit = input.maxActive === undefined ? limit : Math.min(limit, Math.max(0, input.maxActive - active))
    if (claimLimit === 0) return []
    const claimed: ClaimedPageProjectionEffect[] = []
    while (claimed.length < claimLimit) {
      let claimQuery = transaction<PageMutationOutboxRow>('pageMutationOutbox')
        .whereIn('status', ['pending', 'retry'])
        .whereIn('effectKind', effects)
        .where('availableAt', '<=', nowIso)
        .where(builder => builder.whereNull('leaseToken').orWhere('leaseExpiresAt', '<=', nowIso))
        .where(builder =>
          builder
            .whereNot('effectKind', 'links')
            .orWhereNot('desiredState', 'present')
            .orWhereExists(function () {
              this.select(transaction.raw('1'))
                .from('pages as currentPage')
                .whereRaw('?? = ??', ['currentPage.id', 'pageMutationOutbox.pageId'])
                .whereRaw('?? = ??', ['currentPage.sourceRevision', 'pageMutationOutbox.sourceRevision'])
                .whereRaw('?? = ??', ['currentPage.renderedSourceRevision', 'currentPage.sourceRevision'])
                .whereExists(function () {
                  this.select(transaction.raw('1'))
                    .from('pageMutationOutbox as renderDependency')
                    .whereRaw('?? = ??', ['renderDependency.pageId', 'pageMutationOutbox.pageId'])
                    .whereRaw('?? = ??', ['renderDependency.sourceRevision', 'pageMutationOutbox.sourceRevision'])
                    .where('renderDependency.effectKind', 'render')
                    .where('renderDependency.status', 'succeeded')
                })
            })
            .orWhereNotExists(function () {
              this.select(transaction.raw('1'))
                .from('pages as currentPage')
                .whereRaw('?? = ??', ['currentPage.id', 'pageMutationOutbox.pageId'])
                .whereRaw('?? = ??', ['currentPage.sourceRevision', 'pageMutationOutbox.sourceRevision'])
            })
        )
        .where(builder =>
          builder
            .whereNot('effectKind', 'search')
            .orWhereNot('desiredState', 'present')
            .orWhereNotExists(function () {
              this.select(transaction.raw('1'))
                .from('pages as currentPage')
                .whereRaw('?? = ??', ['currentPage.id', 'pageMutationOutbox.pageId'])
                .whereRaw('?? = ??', ['currentPage.sourceRevision', 'pageMutationOutbox.sourceRevision'])
                .where('currentPage.visibility', 'public')
                .where('currentPage.isPublished', true)
                .where('currentPage.isSearchable', true)
                .whereRaw(
                  transaction.client.config.client === 'pg'
                    ? "(NULLIF(??::text, '') IS NULL OR NULLIF(??::text, '')::timestamptz <= ?::timestamptz)"
                    : "(NULLIF(??, '') IS NULL OR julianday(NULLIF(??, '')) <= julianday(?))",
                  ['currentPage.publishStartDate', 'currentPage.publishStartDate', nowIso]
                )
                .whereRaw(
                  transaction.client.config.client === 'pg'
                    ? "(NULLIF(??::text, '') IS NULL OR NULLIF(??::text, '')::timestamptz >= ?::timestamptz)"
                    : "(NULLIF(??, '') IS NULL OR julianday(NULLIF(??, '')) >= julianday(?))",
                  ['currentPage.publishEndDate', 'currentPage.publishEndDate', nowIso]
                )
                .whereNotExists(function () {
                  this.select(transaction.raw('1')).from('pageAccessPasswords as protection')
                    .whereRaw('?? = ??', ['protection.pageId', 'currentPage.id'])
                })
            })
            .orWhereExists(function () {
              this.select(transaction.raw('1'))
                .from('pages as currentPage')
                .whereRaw('?? = ??', ['currentPage.id', 'pageMutationOutbox.pageId'])
                .whereRaw('?? = ??', ['currentPage.sourceRevision', 'pageMutationOutbox.sourceRevision'])
                .whereRaw('?? = ??', ['currentPage.renderedSourceRevision', 'currentPage.sourceRevision'])
                .whereExists(function () {
                  this.select(transaction.raw('1'))
                    .from('pageMutationOutbox as renderDependency')
                    .whereRaw('?? = ??', ['renderDependency.pageId', 'pageMutationOutbox.pageId'])
                    .whereRaw('?? = ??', ['renderDependency.sourceRevision', 'pageMutationOutbox.sourceRevision'])
                    .where('renderDependency.effectKind', 'render')
                    .where('renderDependency.status', 'succeeded')
                })
            })
        )
        .orderBy('availableAt', 'asc')
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(claimLimit - claimed.length)
        .forUpdate()
      const client = String(transaction.client.config.client)
      if (client === 'pg' || client === 'postgres' || client === 'postgresql' || client.includes('mysql')) claimQuery = claimQuery.skipLocked()
      const rows = await claimQuery
      if (rows.length === 0) break
      const claimsBefore = claimed.length
      let candidatesRemoved = false
      for (const row of rows) {
        let payload: PageProjectionPayload
        try {
          payload = parseRowPayload(row)
        } catch (error: unknown) {
          if (!(error instanceof PageMutationOutboxError)) throw error
          const detail = error.message.slice(0, 1_000)
          const quarantined = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
            .where({ id: row.id, status: row.status })
            .update({
              status: 'failed',
              result: canonicalJson({ quarantined: true, code: error.code, error: detail }),
              postcondition: canonicalJson({ satisfied: false, observedSourceRevision: null, detail }),
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: nowIso
            })
          candidatesRemoved ||= quarantined === 1
          continue
        }
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
        claimed.push({ id: row.id, leaseToken, attempts: Number(row.attempts) + 1, payload })
      }
      if (claimed.length === claimsBefore && !candidatesRemoved) break
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
  sinks: PageProjectionSinks,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) throw new PageMutationOutboxError('PROJECTION_ABORTED', 'Page projection execution was aborted')
  const owned = await knex<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ id: claim.id, status: 'running', leaseToken: claim.leaseToken })
    .where('leaseExpiresAt', '>', new Date().toISOString())
    .first('id')
  if (!owned) throw new PageMutationOutboxError('PROJECTION_LEASE_LOST', 'Page projection effect lease was lost before sink execution')
  if (signal.aborted) throw new PageMutationOutboxError('PROJECTION_ABORTED', 'Page projection execution was aborted')
  const sink =
    'get' in sinks && typeof sinks.get === 'function'
      ? sinks.get(claim.payload.effectKind)
      : (sinks as Readonly<Partial<Record<PageProjectionEffectKind, PageProjectionSink>>>)[claim.payload.effectKind]
  if (!sink || sink.kind !== claim.payload.effectKind) {
    await finishClaim(knex, claim, { status: 'failed', result: JSON.stringify({ error: 'No conforming projection sink is registered' }) })
    throw new PageMutationOutboxError('MISSING_PROJECTION_SINK', `No conforming sink is registered for ${claim.payload.effectKind}`)
  }
  let rawResult: unknown
  try {
    rawResult = await sink.reconcile(claim.payload, signal, claim)
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

interface ProjectionPageRow {
  readonly id: number
  readonly sourceRevision: string | number
  readonly content: string
  readonly isPublished: boolean | number
  readonly isSearchable: boolean | number
  readonly render: string
  readonly renderedSourceRevision: string | number | null
  readonly publishStartDate: string | null
  readonly publishEndDate: string | null
  readonly localeCode: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly ownerId: number | null
}

interface PageLinkIdentity {
  readonly localeCode: string
  readonly path: string
}

interface PageLinkRow extends PageLinkIdentity {
  readonly pageId: number
}

const comparePageLinkIdentities = (left: PageLinkIdentity, right: PageLinkIdentity): number => {
  if (left.localeCode < right.localeCode) return -1
  if (left.localeCode > right.localeCode) return 1
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return 0
}

export type PageProjectionLocation = NonNullable<PageProjectionPayload['location']>

export interface PageProjectionRuntime {
  renderPage(pageId: number, fence: PageRenderPublicationFence): Promise<void>
  evictLocation(location: PageProjectionLocation): Promise<void>
  reconcileSearchPage(pageId: number): Promise<void>
  removeSearchPage(pageId: number): Promise<void>
}

const projectionPageColumns = [
  'id', 'sourceRevision', 'content', 'render', 'renderedSourceRevision', 'isPublished', 'isSearchable',
  'publishStartDate', 'publishEndDate', 'localeCode', 'path', 'visibility', 'ownerId'
] as const

const loadProjectionPage = async (knex: Knex | Knex.Transaction, pageId: number): Promise<ProjectionPageRow | undefined> =>
  knex<ProjectionPageRow>('pages').select(...projectionPageColumns).where({ id: pageId }).first()

const withLockedProjectionPage = async <T>(
  db: Knex | Knex.Transaction,
  pageId: number,
  work: (transaction: Knex.Transaction, page: ProjectionPageRow | undefined) => Promise<T>
): Promise<T> => {
  const run = async (transaction: Knex.Transaction): Promise<T> => {
    await lockSearchIndex(transaction, false)
    await lockSearchPage(transaction, pageId)
    const page = await transaction<ProjectionPageRow>('pages').select(...projectionPageColumns).where({ id: pageId }).forUpdate().first()
    return work(transaction, page)
  }
  return db.isTransaction ? run(db as Knex.Transaction) : db.transaction(run)
}

const pageSearchEligible = (page: ProjectionPageRow, now = Date.now()): boolean =>
  page.visibility === 'public' &&
  (page.isPublished === true || page.isPublished === 1) &&
  (page.isSearchable === true || page.isSearchable === 1) &&
  (!page.publishStartDate || Date.parse(page.publishStartDate) <= now) &&
  (!page.publishEndDate || Date.parse(page.publishEndDate) >= now)

const hasCertifiedRender = (page: ProjectionPageRow): boolean =>
  page.renderedSourceRevision !== null && String(page.renderedSourceRevision) === String(page.sourceRevision)

const projectionLocation = (page: ProjectionPageRow): PageProjectionLocation => ({
  locale: page.localeCode, path: page.path, visibility: page.visibility, ownerId: page.ownerId
})

const admitCurrentEffect = async (
  transaction: Knex.Transaction,
  page: ProjectionPageRow,
  kind: PageProjectionEffectKind,
  input: { readonly rearm?: boolean; readonly fenceRunning?: boolean; readonly action?: PageProjectionPayload['action']; readonly now?: Date } = {}
): Promise<{ readonly id: string; readonly changed: boolean }> => {
  const sourceRevision = revisionString(page.sourceRevision)
  const existing = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ pageId: page.id, sourceRevision, effectKind: kind }).forUpdate().first()
  if (!existing) {
    const [id] = await enqueuePageMutationEffects(transaction, {
      pageId: page.id, sourceRevision, desiredState: 'present', action: input.action ?? 'update',
      source: page.content, location: projectionLocation(page), effects: [kind]
    })
    if (!id) throw new PageMutationOutboxError('OUTBOX_ADMISSION_FAILED', 'Current page projection intent could not be admitted')
    return { id, changed: true }
  }
  const payload = parseRowPayload(existing)
  if (existing.effectKey !== `page:${page.id}:${kind}` || payload.desiredState !== 'present' || !isExactProjectionSource(page, payload)) {
    throw new PageMutationOutboxError('OUTBOX_IDEMPOTENCY_CONFLICT', 'Existing projection effect has different immutable content')
  }
  const rearm = input.rearm === true && ['succeeded', 'failed'].includes(existing.status) && existing.leaseToken === null
  const fence = input.fenceRunning === true && existing.status === 'running'
  if (!rearm && !fence) return { id: existing.id, changed: false }
  const now = (input.now ?? new Date()).toISOString()
  const changed = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ id: existing.id, status: existing.status })
    .update({
      status: 'retry', attempts: 0, availableAt: now, result: null, postcondition: null,
      leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: now
    })
  return { id: existing.id, changed: changed === 1 }
}

const invalidateRenderedProjections = async (transaction: Knex.Transaction, pageId: number): Promise<void> => {
  await transaction('pages').where({ id: pageId }).update({ render: '', toc: '[]', renderedSourceRevision: null })
  await transaction('pageLinks').where({ pageId }).delete()
  await transaction('pagesVector').where({ pageId }).delete()
  await transaction('pagesWords').where({ pageId }).delete()
}

const ensureRenderDependency = async (transaction: Knex.Transaction, page: ProjectionPageRow): Promise<boolean> => {
  const existing = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
    .where({ pageId: page.id, sourceRevision: revisionString(page.sourceRevision), effectKind: 'render' }).forUpdate().first()
  if (existing) {
    const payload = parseRowPayload(existing)
    if (payload.desiredState !== 'present' || !isExactProjectionSource(page, payload)) {
      throw new PageMutationOutboxError('OUTBOX_IDEMPOTENCY_CONFLICT', 'Render dependency does not match current page source')
    }
    if (existing.status !== 'succeeded' || hasCertifiedRender(page)) return false
  }
  const render = await admitCurrentEffect(transaction, page, 'render', { rearm: true })
  if (render.changed) {
    await invalidateRenderedProjections(transaction, page.id)
    for (const kind of ['links', 'search'] as const) {
      await admitCurrentEffect(transaction, page, kind, { rearm: true, fenceRunning: true })
    }
  }
  return render.changed
}

export const admitPageSearchEffect = async (
  db: Knex | Knex.Transaction,
  input: { readonly pageId: number; readonly now?: Date }
): Promise<string> => {
  if (!Number.isSafeInteger(input.pageId) || input.pageId < 1) throw new PageMutationOutboxError('INVALID_PAGE_ID', 'Page mutation page ID is invalid')
  return withLockedProjectionPage(db, input.pageId, async (transaction, page) => {
    if (!page) throw new PageMutationOutboxError('PAGE_NOT_FOUND', 'Current page search intent requires an existing page')
    const effect = await admitCurrentEffect(transaction, page, 'search', {
      rearm: true, fenceRunning: true, ...(input.now === undefined ? {} : { now: input.now })
    })
    const protectedPage = await transaction('pageAccessPasswords').where({ pageId: page.id }).first('pageId')
    if (pageSearchEligible(page) && !protectedPage) await ensureRenderDependency(transaction, page)
    return effect.id
  })
}

const pageLocationMatches = (page: ProjectionPageRow, location: PageProjectionLocation): boolean =>
  page.localeCode === location.locale && page.path === location.path && page.visibility === location.visibility && page.ownerId === location.ownerId

const isExactProjectionSource = (page: ProjectionPageRow, payload: PageProjectionPayload): boolean =>
  payload.location !== null &&
  payload.sourceSha256 !== null &&
  revisionString(page.sourceRevision) === payload.sourceRevision &&
  sha256(page.content) === payload.sourceSha256 &&
  pageLocationMatches(page, payload.location)

const supersededResult = (page: ProjectionPageRow | undefined, projection: PageProjectionEffectKind): PageProjectionSinkResult => ({
  result: { projection, superseded: true },
  postcondition: {
    satisfied: true,
    observedSourceRevision: page === undefined ? null : revisionString(page.sourceRevision),
    detail: 'Exact source revision is no longer current; no projection was written'
  }
})

const evictPreviousIdentity = async (runtime: PageProjectionRuntime, payload: PageProjectionPayload): Promise<boolean> => {
  if (payload.previousLocation === null) return false
  if (payload.location !== null && canonicalJson(payload.previousLocation) === canonicalJson(payload.location)) return false
  await runtime.evictLocation(payload.previousLocation)
  return true
}

class RenderProjectionSink implements PageProjectionSink {
  readonly kind = 'render' as const
  readonly #knex: Knex
  readonly #runtime: PageProjectionRuntime

  constructor(knex: Knex, runtime: PageProjectionRuntime) {
    this.#knex = knex
    this.#runtime = runtime
  }

  async reconcile(
    payload: PageProjectionPayload,
    signal: AbortSignal,
    claim?: Pick<ClaimedPageProjectionEffect, 'id' | 'leaseToken'>
  ): Promise<PageProjectionSinkResult> {
    const previousIdentityEvicted = await evictPreviousIdentity(this.#runtime, payload)
    if (signal.aborted) throw signal.reason
    const before = await loadProjectionPage(this.#knex, payload.pageId)
    if (payload.desiredState === 'absent') {
      if (before !== undefined) return supersededResult(before, this.kind)
      return {
        result: { projection: this.kind, removed: true, previousIdentityEvicted },
        postcondition: {
          satisfied: true,
          observedSourceRevision: payload.sourceRevision,
          detail: 'Page is absent and its former cache identity is evicted'
        }
      }
    }
    if (before === undefined || revisionString(before.sourceRevision) !== payload.sourceRevision) return supersededResult(before, this.kind)
    if (!isExactProjectionSource(before, payload)) {
      return {
        result: { projection: this.kind, rendered: false },
        postcondition: {
          satisfied: false,
          observedSourceRevision: revisionString(before.sourceRevision),
          detail: 'Current page identity or source hash does not match immutable render intent'
        }
      }
    }

    if (!claim || payload.sourceSha256 === null) {
      throw new PageMutationOutboxError('RENDER_PUBLICATION_FENCE_REQUIRED', 'Render execution requires a live immutable effect lease')
    }
    await this.#runtime.renderPage(payload.pageId, {
      effectId: claim.id,
      leaseToken: claim.leaseToken,
      sourceRevision: payload.sourceRevision,
      sourceSha256: payload.sourceSha256
    })
    if (signal.aborted) throw signal.reason
    const after = await loadProjectionPage(this.#knex, payload.pageId)
    if (after === undefined || revisionString(after.sourceRevision) !== payload.sourceRevision) return supersededResult(after, this.kind)
    const satisfied = isExactProjectionSource(after, payload) && hasCertifiedRender(after)
    return {
      result: { projection: this.kind, rendered: satisfied, previousIdentityEvicted },
      postcondition: {
        satisfied,
        observedSourceRevision: revisionString(after.sourceRevision),
        detail: satisfied
          ? 'Rendered bytes are persisted for the exact current source revision and the former cache identity is evicted'
          : 'Render persistence did not prove the exact current source revision'
      }
    }
  }
}

const extractRenderedPageLinks = (render: string, defaultLocale: string): readonly PageLinkIdentity[] => {
  const $ = load(render)
  const links = new Map<string, PageLinkIdentity>()
  $('a.is-internal-link').each((_index, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      const segments = decodeURIComponent(new URL(href, 'http://projection.invalid').pathname)
        .split('/')
        .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
      if (segments[0]?.length === 1) segments.shift()
      const explicitLocale = segments[0] && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]) ? segments.shift() : undefined
      const localeCode = explicitLocale ?? defaultLocale
      const pagePath = segments.join('/') || 'home'
      links.set(`${localeCode}\u0000${pagePath}`, { localeCode, path: pagePath })
    } catch {
      // The renderer already ignores malformed internal references; projection persistence does the same.
    }
  })
  return [...links.values()].sort(comparePageLinkIdentities)
}

class LinksProjectionSink implements PageProjectionSink {
  readonly kind = 'links' as const
  readonly #knex: Knex
  readonly #runtime: PageProjectionRuntime

  constructor(knex: Knex, runtime: PageProjectionRuntime) {
    this.#knex = knex
    this.#runtime = runtime
  }

  async reconcile(payload: PageProjectionPayload, signal: AbortSignal): Promise<PageProjectionSinkResult> {
    const previousIdentityEvicted = await evictPreviousIdentity(this.#runtime, payload)
    if (signal.aborted) throw signal.reason
    const before = await loadProjectionPage(this.#knex, payload.pageId)
    if (payload.desiredState === 'absent') {
      if (before !== undefined) return supersededResult(before, this.kind)
      await this.#knex('pageLinks').where({ pageId: payload.pageId }).delete()
      const remaining = await this.#knex('pageLinks').where({ pageId: payload.pageId }).first('id')
      return {
        result: { projection: this.kind, removed: remaining === undefined, previousIdentityEvicted },
        postcondition: {
          satisfied: remaining === undefined,
          observedSourceRevision: payload.sourceRevision,
          detail: remaining === undefined ? 'Page and its persisted links are absent and the former cache identity is evicted' : 'Persisted links remain'
        }
      }
    }
    const location = payload.location
    if (location === null) {
      return {
        result: { projection: this.kind, replaced: false },
        postcondition: {
          satisfied: false,
          observedSourceRevision: before === undefined ? null : revisionString(before.sourceRevision),
          detail: 'Present link projection intent has no current location'
        }
      }
    }
    if (before === undefined || revisionString(before.sourceRevision) !== payload.sourceRevision) return supersededResult(before, this.kind)
    if (!isExactProjectionSource(before, payload)) {
      return {
        result: { projection: this.kind, replaced: false },
        postcondition: {
          satisfied: false,
          observedSourceRevision: revisionString(before.sourceRevision),
          detail: 'Current page identity or source hash does not match immutable link intent'
        }
      }
    }
    const renderEffect = await this.#knex<PageMutationOutboxRow>('pageMutationOutbox')
      .where({ pageId: payload.pageId, sourceRevision: payload.sourceRevision, effectKind: 'render', status: 'succeeded' })
      .first('id')
    if (!renderEffect || !hasCertifiedRender(before)) throw new PageMutationOutboxError('RENDER_PROJECTION_NOT_READY', 'Exact certified render projection has not completed')
    const links = extractRenderedPageLinks(before.render, location.locale)

    const outcome = await withLockedProjectionPage(this.#knex, payload.pageId, async (transaction, current) => {
      if (!current || revisionString(current.sourceRevision) !== payload.sourceRevision) return { superseded: true, observed: current }
      if (!isExactProjectionSource(current, payload) || !hasCertifiedRender(current) || current.render !== before.render) {
        return { superseded: false, observed: current, invalid: true }
      }
      const currentRender = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
        .where({ pageId: payload.pageId, sourceRevision: payload.sourceRevision, effectKind: 'render', status: 'succeeded' }).first('id')
      if (!currentRender) return { superseded: false, observed: current, invalid: true }
      await transaction('pageLinks').where({ pageId: payload.pageId }).delete()
      if (links.length > 0) {
        await transaction('pageLinks').insert(links.map(link => ({ pageId: payload.pageId, ...link })))
      }
      const persistedRows = await transaction<PageLinkRow>('pageLinks').select('localeCode', 'path').where({ pageId: payload.pageId })
      const persisted = persistedRows.map(row => ({ localeCode: row.localeCode, path: row.path })).sort(comparePageLinkIdentities)
      const satisfied = canonicalJson(persisted) === canonicalJson(links)
      return { superseded: false, observed: current, invalid: false, satisfied }
    })
    if (outcome.superseded) return supersededResult(outcome.observed, this.kind)
    const observedSourceRevision = outcome.observed === undefined ? null : revisionString(outcome.observed.sourceRevision)
    const satisfied = outcome.invalid !== true && outcome.satisfied === true
    return {
      result: { projection: this.kind, replaced: satisfied, linkCount: links.length, previousIdentityEvicted },
      postcondition: {
        satisfied,
        observedSourceRevision,
        detail: satisfied
          ? 'Persisted links exactly match the revision-fenced rendered projection and the former cache identity is evicted'
          : 'Link persistence did not prove the exact current rendered revision'
      }
    }
  }
}

interface SearchVectorRow {
  readonly pageId: number
  readonly sourceRevision: string | number
}

const loadSearchRows = async (knex: Knex | Knex.Transaction, pageId: number): Promise<{ vector: SearchVectorRow | undefined; hasWords: boolean }> => {
  const [vector, words] = await Promise.all([
    knex<SearchVectorRow>('pagesVector').select('pageId', 'sourceRevision').where({ pageId }).first(),
    knex('pagesWords').select('pageId').where({ pageId }).first()
  ])
  return { vector, hasWords: words !== undefined }
}

class SearchProjectionSink implements PageProjectionSink {
  readonly kind = 'search' as const
  readonly #knex: Knex
  readonly #runtime: PageProjectionRuntime

  constructor(knex: Knex, runtime: PageProjectionRuntime) {
    this.#knex = knex
    this.#runtime = runtime
  }

  async reconcile(payload: PageProjectionPayload, signal: AbortSignal): Promise<PageProjectionSinkResult> {
    const before = await loadProjectionPage(this.#knex, payload.pageId)
    if (payload.desiredState === 'absent') {
      if (before !== undefined) return supersededResult(before, this.kind)
      await this.#runtime.removeSearchPage(payload.pageId)
      if (signal.aborted) throw signal.reason
      const after = await loadProjectionPage(this.#knex, payload.pageId)
      if (after !== undefined) return supersededResult(after, this.kind)
      const rows = await loadSearchRows(this.#knex, payload.pageId)
      const satisfied = rows.vector === undefined && !rows.hasWords
      return {
        result: { projection: this.kind, removed: satisfied },
        postcondition: {
          satisfied,
          observedSourceRevision: payload.sourceRevision,
          detail: satisfied ? 'The absent page has no derived search rows' : 'Derived search rows remain for the absent page'
        }
      }
    }
    if (before === undefined || revisionString(before.sourceRevision) !== payload.sourceRevision) return supersededResult(before, this.kind)
    if (!isExactProjectionSource(before, payload)) {
      return {
        result: { projection: this.kind, indexed: false },
        postcondition: {
          satisfied: false,
          observedSourceRevision: revisionString(before.sourceRevision),
          detail: 'Current page identity or source hash does not match immutable search intent'
        }
      }
    }
    const publishedPublic = pageSearchEligible(before)
    const protectedPage = await this.#knex('pageAccessPasswords').where({ pageId: payload.pageId }).first('pageId')
    if (publishedPublic && !protectedPage) {
      const renderEffect = await this.#knex<PageMutationOutboxRow>('pageMutationOutbox')
        .where({ pageId: payload.pageId, sourceRevision: payload.sourceRevision, effectKind: 'render', status: 'succeeded' }).first('id')
      if (!renderEffect || !hasCertifiedRender(before)) {
        await withLockedProjectionPage(this.#knex, payload.pageId, async (transaction, page) => {
          if (page && isExactProjectionSource(page, payload)) await ensureRenderDependency(transaction, page)
        })
        throw new PageMutationOutboxError('RENDER_PROJECTION_NOT_READY', 'Exact certified render projection has not completed')
      }
    }
    if (publishedPublic) await this.#runtime.reconcileSearchPage(payload.pageId)
    else await this.#runtime.removeSearchPage(payload.pageId)
    if (signal.aborted) throw signal.reason

    const after = await loadProjectionPage(this.#knex, payload.pageId)
    if (after === undefined || revisionString(after.sourceRevision) !== payload.sourceRevision) return supersededResult(after, this.kind)
    if (!isExactProjectionSource(after, payload)) {
      return {
        result: { projection: this.kind, indexed: false },
        postcondition: {
          satisfied: false,
          observedSourceRevision: revisionString(after.sourceRevision),
          detail: 'Current page identity changed while search reconciliation was running'
        }
      }
    }
    const rows = await loadSearchRows(this.#knex, payload.pageId)
    const satisfied = publishedPublic
      ? rows.vector !== undefined && revisionString(rows.vector.sourceRevision) === payload.sourceRevision
      : rows.vector === undefined && !rows.hasWords
    return {
      result: { projection: this.kind, indexed: publishedPublic && satisfied, removed: !publishedPublic && satisfied },
      postcondition: {
        satisfied,
        observedSourceRevision: rows.vector === undefined ? payload.sourceRevision : revisionString(rows.vector.sourceRevision),
        detail: satisfied
          ? publishedPublic
            ? 'Search vector proves the exact current published-public source revision'
            : 'The current non-public or unpublished page has no derived search rows'
          : publishedPublic
            ? 'Search vector does not prove the exact current source revision'
            : 'Derived search rows remain for a current non-public or unpublished page'
      }
    }
  }
}

const searchStateDisagrees = async (knex: Knex | Knex.Transaction, page: ProjectionPageRow): Promise<boolean> => {
  const rows = await loadSearchRows(knex, page.id)
  const publishedPublic = pageSearchEligible(page)
  return publishedPublic
    ? rows.vector === undefined || revisionString(rows.vector.sourceRevision) !== revisionString(page.sourceRevision)
    : rows.vector !== undefined || rows.hasWords
}

const PAGE_PROJECTION_LEASE_MILLISECONDS = 60_000
const PAGE_PROJECTION_HEARTBEAT_MILLISECONDS = 20_000
const SEARCH_MAINTENANCE_LIMIT = 10
const GRAPH_MAINTENANCE_LIMIT = 10
const GRAPH_MAINTENANCE_SCAN_BATCH = 32
const GRAPH_MAINTENANCE_SCAN_LIMIT = 128
const SEARCH_MAINTENANCE_SCAN_BATCH = 32
const SEARCH_MAINTENANCE_SCAN_LIMIT = 128

export class PageProjectionLifecycle {
  readonly #knex: Knex
  readonly #workerId: string
  readonly #sinks: Readonly<Partial<Record<PageProjectionEffectKind, PageProjectionSink>>>
  #running = false
  #graphMaintenanceCursor = 0
  #searchMaintenanceCursor = 0
  #searchAbsentCursor: { pageId: number; id: string } | null = null

  constructor(knex: Knex, workerId: string, runtime: PageProjectionRuntime) {
    this.#knex = knex
    this.#workerId = workerId
    this.#sinks = {
      render: new RenderProjectionSink(knex, runtime),
      links: new LinksProjectionSink(knex, runtime),
      search: new SearchProjectionSink(knex, runtime)
    }
  }

  async #maintainGraphEffects(): Promise<void> {
    let scanned = 0
    let repaired = 0
    while (scanned < GRAPH_MAINTENANCE_SCAN_LIMIT && repaired < GRAPH_MAINTENANCE_LIMIT) {
      const batchLimit = Math.min(GRAPH_MAINTENANCE_SCAN_BATCH, GRAPH_MAINTENANCE_SCAN_LIMIT - scanned)
      const candidates = await this.#knex<ProjectionPageRow>('pages')
        .select('id').where('id', '>', this.#graphMaintenanceCursor)
        .where('visibility', 'public').where('isPublished', true).orderBy('id').limit(batchLimit)
      if (candidates.length === 0) {
        this.#graphMaintenanceCursor = 0
        break
      }
      for (const candidate of candidates) {
        scanned += 1
        this.#graphMaintenanceCursor = Number(candidate.id)
        const changed = await withLockedProjectionPage(this.#knex, candidate.id, async (transaction, page) => {
          if (!page || page.visibility !== 'public' || (page.isPublished !== true && page.isPublished !== 1)) return false
          const renderChanged = await ensureRenderDependency(transaction, page)
          const links = await admitCurrentEffect(transaction, page, 'links')
          return renderChanged || links.changed
        }).catch((error: unknown) => {
          if (error instanceof PageMutationOutboxError) return false
          throw error
        })
        if (changed) repaired += 1
        if (repaired >= GRAPH_MAINTENANCE_LIMIT) break
      }
      if (repaired >= GRAPH_MAINTENANCE_LIMIT) break
      if (candidates.length < batchLimit) {
        this.#graphMaintenanceCursor = 0
        break
      }
    }
  }

  async #maintainSearchEffects(): Promise<void> {
    let repaired = 0
    let scanned = 0
    while (scanned < SEARCH_MAINTENANCE_SCAN_LIMIT && repaired < SEARCH_MAINTENANCE_LIMIT) {
      const batchLimit = Math.min(SEARCH_MAINTENANCE_SCAN_BATCH, SEARCH_MAINTENANCE_SCAN_LIMIT - scanned)
      const candidates = await this.#knex<ProjectionPageRow>('pages')
        .select('id').where('id', '>', this.#searchMaintenanceCursor).orderBy('id').limit(batchLimit)
      if (candidates.length === 0) {
        this.#searchMaintenanceCursor = 0
        break
      }
      for (const candidate of candidates) {
        scanned += 1
        this.#searchMaintenanceCursor = Number(candidate.id)
        const changed = await withLockedProjectionPage(this.#knex, candidate.id, async (transaction, page) => {
          if (!page) return false
          const existing = await transaction<PageMutationOutboxRow>('pageMutationOutbox')
            .where({ pageId: page.id, sourceRevision: revisionString(page.sourceRevision), effectKind: 'search' }).forUpdate().first()
          if (existing) {
            const payload = parseRowPayload(existing)
            if (payload.desiredState !== 'present' || !isExactProjectionSource(page, payload)) return false
          }
          const protectedPage = await transaction('pageAccessPasswords').where({ pageId: page.id }).first('pageId')
          const renderChanged = pageSearchEligible(page) && !protectedPage ? await ensureRenderDependency(transaction, page) : false
          const search = await admitCurrentEffect(transaction, page, 'search', {
            rearm: await searchStateDisagrees(transaction, page)
          })
          return renderChanged || search.changed
        }).catch((error: unknown) => {
          if (error instanceof PageMutationOutboxError) return false
          throw error
        })
        if (changed) repaired += 1
        if (repaired >= SEARCH_MAINTENANCE_LIMIT) break
      }
      if (repaired >= SEARCH_MAINTENANCE_LIMIT) break
      if (candidates.length < batchLimit) {
        this.#searchMaintenanceCursor = 0
        break
      }
    }

    scanned = 0
    while (scanned < SEARCH_MAINTENANCE_SCAN_LIMIT && repaired < SEARCH_MAINTENANCE_LIMIT) {
      const knex = this.#knex
      const batchLimit = Math.min(SEARCH_MAINTENANCE_SCAN_BATCH, SEARCH_MAINTENANCE_SCAN_LIMIT - scanned)
      const query = knex<PageMutationOutboxRow>('pageMutationOutbox as searchEffect')
        .select('searchEffect.*')
        .where('searchEffect.effectKind', 'search').where('searchEffect.desiredState', 'absent')
        .whereIn('searchEffect.status', ['succeeded', 'failed'])
        .whereNotExists(function () {
          this.select(knex.raw('1')).from('pages as currentPage').whereRaw('?? = ??', ['currentPage.id', 'searchEffect.pageId'])
        })
        .where(rows => rows.whereExists(function () {
          this.select(knex.raw('1')).from('pagesVector as searchVector').whereRaw('?? = ??', ['searchVector.pageId', 'searchEffect.pageId'])
        }).orWhereExists(function () {
          this.select(knex.raw('1')).from('pagesWords as searchWords').whereRaw('?? = ??', ['searchWords.pageId', 'searchEffect.pageId'])
        }))
      const cursor = this.#searchAbsentCursor
      if (cursor) query.where(after => after.where('searchEffect.pageId', '>', cursor.pageId).orWhere(samePage =>
        samePage.where('searchEffect.pageId', cursor.pageId).where('searchEffect.id', '>', cursor.id)
      ))
      const candidates = await query.orderBy('searchEffect.pageId').orderBy('searchEffect.id').limit(batchLimit)
      if (candidates.length === 0) {
        this.#searchAbsentCursor = null
        break
      }
      for (const effect of candidates) {
        scanned += 1
        this.#searchAbsentCursor = { pageId: Number(effect.pageId), id: effect.id }
        const changed = await withLockedProjectionPage(this.#knex, effect.pageId, async (transaction, page) => {
          if (page) return false
          const payload = parseRowPayload(effect)
          if (payload.desiredState !== 'absent') return false
          const rows = await loadSearchRows(transaction, effect.pageId)
          if (!rows.vector && !rows.hasWords) return false
          return rearmPageMutationEffect(transaction, { id: effect.id, payload })
        }).catch((error: unknown) => {
          if (error instanceof PageMutationOutboxError) return false
          throw error
        })
        if (changed) repaired += 1
        if (repaired >= SEARCH_MAINTENANCE_LIMIT) break
      }
      if (repaired >= SEARCH_MAINTENANCE_LIMIT) break
      if (candidates.length < batchLimit) {
        this.#searchAbsentCursor = null
        break
      }
    }
  }

  async #executeClaim(claim: ClaimedPageProjectionEffect, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    let renewal = Promise.resolve()
    const heartbeat = async (): Promise<void> => {
      if (controller.signal.aborted) return
      const now = new Date()
      const updated = await this.#knex('pageMutationOutbox')
        .where({ id: claim.id, status: 'running', leaseToken: claim.leaseToken })
        .where('leaseExpiresAt', '>', now.toISOString())
        .update({
          leaseExpiresAt: new Date(now.valueOf() + PAGE_PROJECTION_LEASE_MILLISECONDS).toISOString(),
          updatedAt: now.toISOString()
        })
      if (updated !== 1) controller.abort(new PageMutationOutboxError('PROJECTION_LEASE_LOST', 'Page projection effect lease was lost'))
    }
    const heartbeatTimer = setInterval(() => {
      renewal = renewal.then(heartbeat).catch(error => controller.abort(error))
    }, PAGE_PROJECTION_HEARTBEAT_MILLISECONDS)
    heartbeatTimer.unref()
    try {
      await executePageMutationEffect(this.#knex, claim, this.#sinks, controller.signal)
    } finally {
      clearInterval(heartbeatTimer)
      signal.removeEventListener('abort', abort)
      await renewal
    }
  }

  async runOnce(signal = new AbortController().signal): Promise<{ processed: number }> {
    if (this.#running) return { processed: 0 }
    this.#running = true
    try {
      await this.#maintainGraphEffects()
      await this.#maintainSearchEffects()
      let processed = 0
      while (processed < 10 && !signal.aborted) {
        const [claim] = await claimPageMutationEffects(this.#knex, {
          leaseOwner: this.#workerId,
          limit: 1,
          leaseMs: PAGE_PROJECTION_LEASE_MILLISECONDS,
          effects: ['render', 'links', 'search']
        })
        if (!claim) break
        processed += 1
        try {
          await this.#executeClaim(claim, signal)
        } catch {
          // executePageMutationEffect records retry/terminal state before returning the failure.
        }
      }
      return { processed }
    } finally {
      this.#running = false
    }
  }
}
