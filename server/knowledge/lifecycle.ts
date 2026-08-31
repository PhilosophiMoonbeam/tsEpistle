import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { canReadPage, scopePageQuery, type PagePrincipal } from '../helpers/page-access.ts'
import {
  claimPageMutationEffects,
  enqueuePageMutationEffects,
  executePageMutationEffect,
  PageMutationOutboxError,
  PageProjectionPayloadSchema,
  rearmFailedKnowledgeEffect,
  rearmPageMutationEffect,
  type ClaimedPageProjectionEffect,
  type PageProjectionPayload,
  type PageProjectionSink
} from '../core/page-mutation-outbox.ts'
import { validateStoredOkfMetadata } from '../okf/format.ts'
import type { AgentKnowledgeEnricher } from '../agents/providers/utility.ts'
import {
  KnowledgeProjectionSchema,
  knowledgeProjectionView,
  knowledgeSearchText,
  mergeKnowledgeUtilityResult,
  projectPageKnowledge,
  type KnowledgePageSource,
  type KnowledgeProjection,
  type KnowledgeProjectionView
} from './projection.ts'

const RETRY_FAILED_AFTER_MILLISECONDS = 24 * 60 * 60 * 1_000
const KNOWLEDGE_EFFECT_LEASE_MILLISECONDS = 120_000
const KNOWLEDGE_EFFECT_HEARTBEAT_MILLISECONDS = KNOWLEDGE_EFFECT_LEASE_MILLISECONDS / 2

interface SourceSnapshotRow {
  readonly sourceRevision: string | number
  readonly localeCode: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly contentType: string
  readonly content: string
  readonly title: string
  readonly description: string | null
  readonly authorId: number
  readonly extra: unknown
  readonly ownerId: number | null
}

interface CurrentSourceRow extends SourceSnapshotRow {
  readonly id: number
  readonly updatedAt: string | Date
}

interface HistorySourceRow extends SourceSnapshotRow {
  readonly id: number
  readonly pageId: number
  readonly versionDate: string | Date
}

interface ProjectionQueueSourceRow {
  readonly id: number
  readonly sourceRevision: string | number
  readonly content: string
  readonly localeCode: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly ownerId: number | null
}

interface CurrentProjectionScanRow {
  readonly id: number
  readonly sourceRevision: string | number
}

interface CurrentKnowledgeEffectRow {
  readonly id: string
  readonly attempts: number
  readonly status: string
  readonly payload: string
}

interface StoredProjectionRow {
  readonly pageId: number
  readonly sourceRevision: string | number
  readonly sourceSha256: string
  readonly state: string
  readonly enrichmentState: string
  readonly utilityProfileVersionId: string | null
  readonly updatedAt: string | Date
  readonly projection: string | Record<string, unknown>
}

export interface KnowledgeDiscoveryFilter {
  readonly state?: 'complete' | 'partial'
  readonly lifecycleStatus?: 'draft' | 'stable' | 'deprecated'
  readonly trustTier?: 'unverified' | 'machine-confirmed' | 'human-reviewed'
  readonly stale?: boolean
  readonly conceptType?: string
}

export interface KnowledgeSearchCandidate {
  readonly id: number
  readonly locale: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly score: number
  readonly matchedFields: readonly ['knowledge']
  readonly knowledge: KnowledgeProjectionView
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const parsedExtra = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      const decoded: unknown = JSON.parse(value)
      return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
const revision = (value: string | number): string => String(value)
const currentProfileVersionId = async (knex: Knex): Promise<string | null> => {
  const row = (await knex('agentProviderProfiles')
    .join('agentProviderProfileVersions', 'agentProviderProfileVersions.id', 'agentProviderProfiles.currentVersionId')
    .where({
      'agentProviderProfiles.status': 'enabled',
      'agentProviderProfiles.isGlobalDefault': true,
      'agentProviderProfiles.conformed': true,
      'agentProviderProfileVersions.conformed': true
    })
    .whereNull('agentProviderProfiles.deletedAt')
    .first('agentProviderProfileVersions.id')) as { id: string } | undefined
  return row?.id ?? null
}

const loadTags = async (knex: Knex, pageId: number, historyId?: number): Promise<string[]> => {
  const rows =
    historyId === undefined
      ? await knex('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', pageId).orderBy('tags.tag').pluck<string>('tags.tag')
      : await knex('pageHistoryTags')
          .join('tags', 'tags.id', 'pageHistoryTags.tagId')
          .where('pageHistoryTags.pageId', historyId)
          .orderBy('tags.tag')
          .pluck<string>('tags.tag')
  return rows
}

const loadSource = async (knex: Knex, pageId: number, sourceRevision: string): Promise<KnowledgePageSource | null> => {
  const current = await knex<CurrentSourceRow>('pages').where({ id: pageId, sourceRevision }).first()
  let row: SourceSnapshotRow
  let historyId: number | undefined
  let updatedAt: string | Date
  if (current) {
    row = current
    updatedAt = current.updatedAt
  } else {
    const history = await knex<HistorySourceRow>('pageHistory').where({ pageId, sourceRevision }).orderBy('id', 'desc').first()
    if (!history) return null
    row = history
    historyId = history.id
    updatedAt = history.versionDate
  }
  const extra = parsedExtra(row.extra)
  if (Object.hasOwn(extra, 'okf') && validateStoredOkfMetadata(extra.okf) === null)
    throw new Error('Invalid claimed OKF metadata in pages.extra.okf')
  return {
    pageId,
    sourceRevision,
    locale: row.localeCode,
    path: row.path,
    visibility: row.visibility,
    contentType: row.contentType,
    content: row.content,
    title: row.title,
    description: row.description,
    tags: await loadTags(knex, pageId, historyId),
    updatedAt,
    authorId: row.authorId,
    metadata: extra.okf
  }
}

const projectionColumns = (projection: KnowledgeProjection, enrichmentState: string, error: string | null, now: string): Record<string, unknown> => ({
  pageId: projection.source.pageId,
  sourceRevision: projection.source.sourceRevision,
  sourceSha256: projection.source.sha256,
  schemaVersion: projection.version,
  deterministicVersion: projection.provenance.deterministicVersion,
  state: projection.completeness.state,
  enrichmentState,
  conceptType: projection.concept.type,
  summary: projection.concept.summary,
  searchText: knowledgeSearchText(projection),
  lifecycleStatus: projection.lifecycle.status,
  trustTier: projection.lifecycle.trustTier,
  verification: projection.lifecycle.verification,
  staleAfter: projection.lifecycle.staleAfter,
  utilityProfileVersionId: projection.provenance.utility?.profileVersionId ?? null,
  utilityModel: projection.provenance.utility?.model ?? null,
  utilityInputSha256: projection.provenance.utility?.inputSha256 ?? null,
  utilityOutputSha256: projection.provenance.utility?.outputSha256 ?? null,
  utilityGeneratedAt: projection.provenance.utility?.generatedAt ?? null,
  projection: canonicalJson(projection),
  lastError: error,
  updatedAt: now
})

class KnowledgeProjectionSink implements PageProjectionSink {
  readonly kind = 'knowledge' as const
  readonly #knex: Knex
  readonly #enricher: AgentKnowledgeEnricher | undefined
  readonly #claim: Pick<ClaimedPageProjectionEffect, 'id' | 'leaseToken'>

  constructor(knex: Knex, enricher: AgentKnowledgeEnricher | undefined, claim: Pick<ClaimedPageProjectionEffect, 'id' | 'leaseToken'>) {
    this.#knex = knex
    this.#enricher = enricher
    this.#claim = claim
  }

  async reconcile(payload: PageProjectionPayload, signal: AbortSignal) {
    if (payload.desiredState === 'absent') {
      const current = (await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision')) as { sourceRevision: string | number } | undefined
      return {
        result: { removed: current === undefined },
        postcondition: {
          satisfied: current === undefined,
          observedSourceRevision: current === undefined ? null : revision(current.sourceRevision),
          detail: current === undefined ? 'Page is absent; immutable historical projections are retained' : 'Page still exists'
        }
      }
    }

    const sourceRevision = payload.sourceRevision
    const source = await loadSource(this.#knex, payload.pageId, sourceRevision)
    if (!source || payload.sourceSha256 === null || sha256(source.content) !== payload.sourceSha256) {
      const current = (await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision')) as { sourceRevision: string | number } | undefined
      return {
        result: { superseded: true },
        postcondition: {
          satisfied: true,
          observedSourceRevision: current === undefined ? null : revision(current.sourceRevision),
          detail: 'Exact source revision is unavailable or no longer matches its immutable hash; no projection was written'
        }
      }
    }
    let projection = projectPageKnowledge(source)
    const missingFields = projection.completeness.missingFields
    const currentBeforeEnrichment = (await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision')) as
      | { sourceRevision: string | number }
      | undefined
    const isCurrentRevision = currentBeforeEnrichment !== undefined && revision(currentBeforeEnrichment.sourceRevision) === sourceRevision
    const profileVersionId =
      this.#enricher && isCurrentRevision && source.visibility === 'public' && missingFields.length > 0 ? await currentProfileVersionId(this.#knex) : null
    let enrichmentState =
      missingFields.length === 0
        ? 'not-needed'
        : !isCurrentRevision
          ? 'superseded'
          : source.visibility === 'private'
            ? 'withheld-private'
            : profileVersionId === null
              ? 'unavailable'
              : 'pending'
    let error: string | null = null
    const persist = async (value: KnowledgeProjection, state: string, lastError: string | null, requireCurrentSource: boolean): Promise<boolean> => {
      const now = new Date().toISOString()
      return this.#knex.transaction(async transaction => {
        const lease = await transaction('pageMutationOutbox')
          .where({ id: this.#claim.id, status: 'running', leaseToken: this.#claim.leaseToken })
          .forUpdate()
          .first('id')
        if (!lease) {
          if (requireCurrentSource) throw new PageMutationOutboxError('PROJECTION_LEASE_LOST', 'Page projection effect lease was lost')
          return false
        }
        if (requireCurrentSource) {
          const current = (await transaction('pages').where({ id: payload.pageId }).forUpdate().first('sourceRevision', 'content')) as
            | { sourceRevision: string | number; content: string }
            | undefined
          if (
            !current ||
            revision(current.sourceRevision) !== sourceRevision ||
            payload.sourceSha256 === null ||
            sha256(current.content) !== payload.sourceSha256
          )
            return false
        }
        const columns = projectionColumns(value, state, lastError, now)
        await transaction('pageKnowledgeProjections')
          .insert({ ...columns, createdAt: now })
          .onConflict(['pageId', 'sourceRevision'])
          .merge(columns)
        return true
      })
    }

    // The deterministic projection is authoritative and must become readable before
    // any optional provider call starts.
    await persist(projection, enrichmentState, null, false)

    if (this.#enricher && profileVersionId !== null && missingFields.length > 0 && enrichmentState === 'pending') {
      try {
        const result = await this.#enricher.enrichKnowledge({
          profileVersionId,
          page: {
            title: source.title,
            description: source.description ?? '',
            locale: source.locale,
            path: source.path,
            contentType: source.contentType,
            content: source.content
          },
          missingFields,
          signal
        })
        if (signal.aborted) throw signal.reason
        const currentAfterEnrichment = (await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision', 'content')) as
          | { sourceRevision: string | number; content: string }
          | undefined
        const reloaded = await loadSource(this.#knex, payload.pageId, sourceRevision)
        if (
          currentAfterEnrichment === undefined ||
          revision(currentAfterEnrichment.sourceRevision) !== sourceRevision ||
          !reloaded ||
          payload.sourceSha256 === null ||
          sha256(currentAfterEnrichment.content) !== payload.sourceSha256 ||
          sha256(reloaded.content) !== payload.sourceSha256
        ) {
          enrichmentState = 'superseded'
          await persist(projection, enrichmentState, null, false)
        } else {
          const generatedAt = new Date().toISOString()
          const merged = mergeKnowledgeUtilityResult(projection, result.value, {
            profileVersionId,
            model: result.model,
            inputSha256: result.inputSha256,
            outputSha256: result.outputSha256,
            generatedAt
          })
          if (await persist(merged, 'succeeded', null, true)) projection = merged
          else enrichmentState = 'superseded'
        }
      } catch (cause: unknown) {
        if (signal.aborted) throw signal.reason
        enrichmentState = 'failed'
        error = cause instanceof Error ? cause.message.slice(0, 4_000) : 'Utility knowledge enrichment failed'
        await persist(projection, enrichmentState, error, true)
      }
    }

    const stored = (await this.#knex('pageKnowledgeProjections')
      .where({ pageId: payload.pageId, sourceRevision })
      .first('sourceRevision', 'sourceSha256')) as { sourceRevision: string | number; sourceSha256: string } | undefined
    const satisfied = stored?.sourceSha256 === projection.source.sha256
    return {
      result: { state: projection.completeness.state, enrichmentState, missingFields: projection.completeness.missingFields },
      postcondition: {
        satisfied,
        observedSourceRevision: stored ? revision(stored.sourceRevision) : null,
        detail: satisfied
          ? 'Knowledge projection matches the exact source revision and authoritative snapshot hash'
          : 'Knowledge projection postcondition failed'
      }
    }
  }
}

export const matchesKnowledgeFilter = (view: KnowledgeProjectionView, filter?: KnowledgeDiscoveryFilter): boolean => {
  if (!filter) return true
  if (filter.state !== undefined && view.state !== filter.state) return false
  if (filter.lifecycleStatus !== undefined && view.lifecycle.status !== filter.lifecycleStatus) return false
  if (filter.trustTier !== undefined && view.lifecycle.trustTier !== filter.trustTier) return false
  if (filter.stale !== undefined && view.lifecycle.stale !== filter.stale) return false
  return filter.conceptType === undefined || view.conceptType?.toLocaleLowerCase() === filter.conceptType.toLocaleLowerCase()
}

const parseProjection = (row: Pick<StoredProjectionRow, 'projection'>): KnowledgeProjection => {
  const decoded: unknown = typeof row.projection === 'string' ? JSON.parse(row.projection) : row.projection
  return KnowledgeProjectionSchema.parse(decoded)
}

const isValidProjection = (
  row: Pick<StoredProjectionRow, 'sourceSha256' | 'projection'> | undefined,
  pageId: number,
  sourceRevision: string,
  sourceSha256: string
): boolean => {
  if (!row || row.sourceSha256 !== sourceSha256) return false
  try {
    const projection = parseProjection(row)
    return projection.source.pageId === pageId && projection.source.sourceRevision === sourceRevision && projection.source.sha256 === sourceSha256
  } catch {
    return false
  }
}

export class PageKnowledgeRepository {
  readonly #knex: Knex

  constructor(knex: Knex) {
    this.#knex = knex
  }

  async getCurrent(pageId: number): Promise<KnowledgeProjectionView | null> {
    const row = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .where('projections.pageId', pageId)
      .first('projections.projection')
    return row ? knowledgeProjectionView(parseProjection(row)) : null
  }

  async getRevision(pageId: number, sourceRevision: string): Promise<KnowledgeProjectionView | null> {
    const row = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections').where({ pageId, sourceRevision }).first('projection')
    return row ? knowledgeProjectionView(parseProjection(row)) : null
  }

  async getCurrentMany(pageIds: readonly number[]): Promise<ReadonlyMap<number, KnowledgeProjectionView>> {
    if (pageIds.length === 0) return new Map()
    const rows = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .whereIn('projections.pageId', [...new Set(pageIds)])
      .select('projections.pageId', 'projections.projection')
    return new Map(rows.map(row => [Number(row.pageId), knowledgeProjectionView(parseProjection(row))]))
  }

  async searchVisible(input: {
    readonly query: string
    readonly requester: PagePrincipal
    readonly locale?: string
    readonly path?: string
    readonly limit: number
    readonly filter?: KnowledgeDiscoveryFilter
  }): Promise<readonly KnowledgeSearchCandidate[]> {
    const query = input.query.trim().toLocaleLowerCase()
    if (!query) return []
    const locale = input.locale
    const path = input.path
    const operator = String(this.#knex.client.config.client).includes('pg') ? 'ILIKE' : 'LIKE'
    const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, '\\$&')
    const rows = (await this.#knex('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .where(builder => {
        scopePageQuery(builder, input.requester, { table: 'pages' })
        builder.andWhereRaw(`?? ${operator} ? ESCAPE ?`, ['projections.searchText', `%${escapeLike(query)}%`, '\\'])
        if (locale !== undefined) builder.andWhere('pages.localeCode', locale)
        if (path !== undefined)
          builder.andWhere(pathScope => {
            pathScope.where('pages.path', path).orWhereRaw('?? LIKE ? ESCAPE ?', ['pages.path', `${escapeLike(path)}/%`, '\\'])
          })
      })
      .select('pages.id', 'pages.localeCode', 'pages.path', 'pages.visibility', 'pages.ownerId', 'projections.projection')
      .orderBy('pages.id')) as Array<{
      id: number
      localeCode: string
      path: string
      visibility: 'public' | 'private'
      ownerId: number | null
      projection: string | Record<string, unknown>
    }>
    const protectedRows =
      rows.length === 0
        ? []
        : ((await this.#knex('pageAccessPasswords')
            .whereIn(
              'pageId',
              rows.map(row => row.id)
            )
            .select('pageId')) as Array<{ pageId: number }>)
    const protectedIds = new Set(protectedRows.map(row => Number(row.pageId)))
    const tagRows =
      rows.length === 0
        ? []
        : ((await this.#knex('pageTags')
            .join('tags', 'tags.id', 'pageTags.tagId')
            .whereIn(
              'pageTags.pageId',
              rows.map(row => row.id)
            )
            .select('pageTags.pageId', 'tags.tag')) as Array<{ pageId: number; tag: string }>)
    const tagsByPage = new Map<number, string[]>()
    for (const tag of tagRows) tagsByPage.set(tag.pageId, [...(tagsByPage.get(tag.pageId) ?? []), tag.tag])
    const limit = Math.max(1, Math.min(100, input.limit))
    return rows
      .flatMap(row => {
        if (protectedIds.has(row.id) || !canReadPage(input.requester, { ...row, tags: tagsByPage.get(row.id) ?? [] })) return []
        const knowledge = knowledgeProjectionView(parseProjection(row))
        if (!matchesKnowledgeFilter(knowledge, input.filter)) return []
        const exact = knowledge.conceptType?.toLocaleLowerCase() === query || knowledge.tags.some((tag: string) => tag.toLocaleLowerCase() === query)
        return [
          {
            id: row.id,
            locale: row.localeCode,
            path: row.path,
            visibility: row.visibility,
            score: exact ? 7 : 2,
            matchedFields: ['knowledge'] as const,
            knowledge
          }
        ]
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.locale.localeCompare(right.locale) || left.id - right.id)
      .slice(0, limit)
  }
}

interface KnowledgeMaintenanceRow {
  readonly id: number
  readonly version: number
  readonly epochId: string | number
  readonly status: string
  readonly highWaterPageId: string | number
  readonly cursorPageId: string | number
  readonly scanned: string | number
  readonly repaired: string | number
  readonly requeued: string | number
  readonly leaseOwner: string | null
  readonly leaseToken: string | null
  readonly leaseExpiresAt: string | Date | null
  readonly startedAt: string | Date | null
}

const loadCurrentProjectionScan = async (knex: Knex, afterPageId: number, limit: number, highWaterPageId?: number): Promise<CurrentProjectionScanRow[]> => {
  const query = knex<CurrentProjectionScanRow>('pages').where('id', '>', afterPageId)
  if (highWaterPageId !== undefined) query.andWhere('id', '<=', highWaterPageId)
  return query.select('id', 'sourceRevision').orderBy('id').limit(limit)
}

const isMissingMaintenanceTable = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (Reflect.get(error, 'code') === '42P01' || (Reflect.get(error, 'code') === 'SQLITE_ERROR' && String(error).includes('no such table')))

const claimMaintenanceEpoch = async (knex: Knex, workerId: string, now: Date): Promise<KnowledgeMaintenanceRow | null> => {
  try {
    return await knex.transaction(async transaction => {
      const current = (await transaction<KnowledgeMaintenanceRow>('pageKnowledgeMaintenance').where({ id: 1 }).forUpdate().first()) as
        | KnowledgeMaintenanceRow
        | undefined
      if (!current) return null
      const expires = current.leaseExpiresAt === null ? 0 : new Date(current.leaseExpiresAt).valueOf()
      if (current.status === 'running' && expires > now.valueOf() && current.leaseOwner !== workerId) return null
      const starting = current.status !== 'running'
      const highWater = starting
        ? Number(((await transaction('pages').max('id as highWater').first()) as { highWater?: number | string } | undefined)?.highWater ?? 0)
        : Number(current.highWaterPageId)
      const epochId = starting ? Number(current.epochId) + 1 : Number(current.epochId)
      const cursorPageId = starting ? 0 : Number(current.cursorPageId)
      const leaseToken = starting || current.leaseOwner !== workerId ? randomUUID() : current.leaseToken
      const updatedAt = now.toISOString()
      await transaction('pageKnowledgeMaintenance')
        .where({ id: 1 })
        .update({
          version: 1,
          epochId,
          status: 'running',
          highWaterPageId: highWater,
          cursorPageId,
          scanned: starting ? 0 : Number(current.scanned),
          repaired: starting ? 0 : Number(current.repaired),
          requeued: starting ? 0 : Number(current.requeued),
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt: new Date(now.valueOf() + KNOWLEDGE_EFFECT_LEASE_MILLISECONDS).toISOString(),
          startedAt: starting ? updatedAt : current.startedAt,
          completedAt: null,
          updatedAt,
          lastProgressAt: updatedAt,
          lastError: null
        })
      return {
        ...current,
        epochId,
        status: 'running',
        highWaterPageId: highWater,
        cursorPageId,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: new Date(now.valueOf() + KNOWLEDGE_EFFECT_LEASE_MILLISECONDS).toISOString()
      }
    })
  } catch (error: unknown) {
    if (isMissingMaintenanceTable(error)) return null
    throw error
  }
}

const maintainCurrentProjections = async (
  knex: Knex,
  workerId: string,
  now: Date,
  limit: number
): Promise<{ repaired: number; cursor: number; durable: boolean } | null> => {
  const epoch = await claimMaintenanceEpoch(knex, workerId, now)
  if (epoch === null) return null
  const cursor = Number(epoch.cursorPageId)
  const highWater = Number(epoch.highWaterPageId)
  const rows = await loadCurrentProjectionScan(knex, cursor, limit, highWater)
  let repaired = 0
  for (const row of rows) repaired += await repairCurrentProjection(knex, row, now)
  const nextCursor = rows.at(-1)?.id ?? cursor
  const finished = rows.length === 0 || nextCursor >= highWater
  await knex('pageKnowledgeMaintenance')
    .where({ id: 1, status: 'running', leaseToken: epoch.leaseToken })
    .update({
      cursorPageId: nextCursor,
      scanned: knex.raw('?? + ?', ['scanned', rows.length]),
      repaired: knex.raw('?? + ?', ['repaired', repaired]),
      status: finished ? 'complete' : 'running',
      leaseOwner: finished ? null : epoch.leaseOwner,
      leaseToken: finished ? null : epoch.leaseToken,
      leaseExpiresAt: finished ? null : epoch.leaseExpiresAt,
      completedAt: finished ? now.toISOString() : null,
      lastProgressAt: now.toISOString(),
      updatedAt: now.toISOString()
    })
  return { repaired, cursor: nextCursor, durable: true }
}

const parseKnowledgeEffectPayload = (value: string): PageProjectionPayload => {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new PageMutationOutboxError('INVALID_OUTBOX_PAYLOAD', 'Page mutation outbox payload is invalid JSON')
  }
  const payload = PageProjectionPayloadSchema.safeParse(decoded)
  if (!payload.success) throw new PageMutationOutboxError('INVALID_OUTBOX_PAYLOAD', 'Page mutation outbox payload is invalid')
  return payload.data
}

const repairCurrentProjection = async (knex: Knex, scanned: CurrentProjectionScanRow, now: Date): Promise<number> =>
  knex.transaction(async transaction => {
    const page = await transaction<ProjectionQueueSourceRow>('pages')
      .where({ id: scanned.id, sourceRevision: scanned.sourceRevision })
      .forUpdate()
      .first('id', 'sourceRevision', 'content', 'localeCode', 'path', 'visibility', 'ownerId')
    if (!page) return 0
    const sourceRevision = revision(page.sourceRevision)
    const authoritativeSource = await loadSource(transaction, Number(page.id), sourceRevision)
    if (!authoritativeSource) return 0
    const sourceSha256 = projectPageKnowledge(authoritativeSource).source.sha256
    const projection = await transaction<StoredProjectionRow>('pageKnowledgeProjections')
      .where({ pageId: page.id, sourceRevision })
      .first('sourceSha256', 'projection')
    if (isValidProjection(projection, Number(page.id), sourceRevision, sourceSha256)) return 0

    const effect = await transaction<CurrentKnowledgeEffectRow>('pageMutationOutbox')
      .where('pageId', page.id)
      .where('sourceRevision', sourceRevision)
      .where('effectKind', 'knowledge')
      .first('id', 'status', 'attempts', 'payload')
    const location = {
      locale: page.localeCode,
      path: page.path,
      visibility: page.visibility,
      ownerId: page.ownerId
    }
    if (!effect) {
      await enqueuePageMutationEffects(transaction, {
        pageId: Number(page.id),
        sourceRevision,
        desiredState: 'present',
        action: 'update',
        source: page.content,
        location,
        effects: ['knowledge']
      })
      return 1
    }
    if (effect.status !== 'succeeded' && !(effect.status === 'failed' && effect.attempts < 5)) return 0

    const immutable = parseKnowledgeEffectPayload(effect.payload)
    const payload = PageProjectionPayloadSchema.parse({
      ...immutable,
      version: 1,
      effectKind: 'knowledge',
      desiredState: 'present',
      pageId: Number(page.id),
      sourceRevision,
      sourceSha256: sha256(page.content),
      location
    })
    return (await rearmPageMutationEffect(transaction, { id: effect.id, payload, now })) ? 1 : 0
  })


const recoverTerminalFailures = async (knex: Knex, now: Date): Promise<number> => {
  const failedBefore = new Date(now.valueOf() - RETRY_FAILED_AFTER_MILLISECONDS)
  const rows = (await knex('pageMutationOutbox as effects')
    .join('pages', function () {
      this.on('pages.id', '=', 'effects.pageId').andOn('pages.sourceRevision', '=', 'effects.sourceRevision')
    })
    .where({
      'effects.effectKind': 'knowledge',
      'effects.desiredState': 'present',
      'effects.status': 'failed'
    })
    .where('effects.attempts', '>=', 5)
    .where('effects.updatedAt', '<=', failedBefore.toISOString())
    .orderBy('effects.updatedAt')
    .orderBy('effects.id')
    .select('effects.id', 'effects.pageId', 'effects.sourceRevision')
    .limit(25)) as Array<{ id: string; pageId: number; sourceRevision: string | number }>
  let rearmed = 0
  for (const row of rows) {
    rearmed += await knex.transaction(async transaction => {
      const source = await transaction<ProjectionQueueSourceRow>('pages')
        .where({ id: row.pageId, sourceRevision: row.sourceRevision })
        .forUpdate()
        .first('id', 'sourceRevision', 'content', 'localeCode', 'path', 'visibility', 'ownerId')
      if (!source) return 0
      const sourceRevision = revision(source.sourceRevision)
      const projection = await transaction<StoredProjectionRow>('pageKnowledgeProjections')
        .where({ pageId: row.pageId, sourceRevision })
        .first('sourceSha256', 'projection')
      if (projection) {
        const authoritativeSource = await loadSource(transaction, Number(row.pageId), sourceRevision)
        if (!authoritativeSource) return 0
        const sourceSha256 = projectPageKnowledge(authoritativeSource).source.sha256
        if (isValidProjection(projection, Number(row.pageId), sourceRevision, sourceSha256)) return 0
      }
      const rearmed = await rearmFailedKnowledgeEffect(transaction, {
        id: row.id,
        pageId: Number(row.pageId),
        sourceRevision,
        source: source.content,
        location: {
          locale: source.localeCode,
          path: source.path,
          visibility: source.visibility,
          ownerId: source.ownerId
        },
        failedBefore,
        now
      })
      return rearmed ? 1 : 0
    })
  }
  return rearmed
}

const requeueRetryable = async (knex: Knex, profileVersionId: string | null, now: Date): Promise<number> => {
  if (profileVersionId === null) return 0
  const retryBefore = new Date(now.valueOf() - RETRY_FAILED_AFTER_MILLISECONDS).toISOString()
  const rows = (await knex<StoredProjectionRow>('pageKnowledgeProjections as projections')
    .join('pages', function () {
      this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
    })
    .join('pageMutationOutbox as effects', function () {
      this.on('effects.pageId', '=', 'projections.pageId').andOn('effects.sourceRevision', '=', 'projections.sourceRevision')
    })
    .where('effects.effectKind', 'knowledge')
    .where('effects.status', 'succeeded')
    .where('pages.visibility', 'public')
    .where(builder =>
      builder
        .where('projections.enrichmentState', 'unavailable')
        .orWhere(retry => retry.where('projections.enrichmentState', 'failed').andWhere('projections.updatedAt', '<=', retryBefore))
        .orWhere(retry => retry.where('projections.enrichmentState', 'succeeded').andWhereNot('projections.utilityProfileVersionId', profileVersionId))
    )
    .select('effects.id')
    .limit(25)) as Array<{ id: string }>
  if (rows.length === 0) return 0
  return knex('pageMutationOutbox')
    .whereIn(
      'id',
      rows.map(row => row.id)
    )
    .update({
      status: 'pending',
      attempts: 0,
      availableAt: now.toISOString(),
      result: null,
      postcondition: null,
      updatedAt: now.toISOString()
    })
}

export class PageKnowledgeLifecycle {
  readonly #knex: Knex
  readonly #enricher: AgentKnowledgeEnricher | undefined
  readonly #workerId: string
  #running = false
  #projectionScanCursor = 0

  constructor(knex: Knex, workerId: string, enricher?: AgentKnowledgeEnricher) {
    this.#knex = knex
    this.#workerId = workerId
    this.#enricher = enricher
  }

  async #executeClaim(claim: ClaimedPageProjectionEffect, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })

    let renewal = Promise.resolve()
    const heartbeat = async (): Promise<void> => {
      if (controller.signal.aborted) return
      try {
        const now = new Date()
        const updated = await this.#knex('pageMutationOutbox')
          .where({ id: claim.id, status: 'running', leaseToken: claim.leaseToken })
          .update({
            leaseExpiresAt: new Date(now.valueOf() + KNOWLEDGE_EFFECT_LEASE_MILLISECONDS).toISOString(),
            updatedAt: now.toISOString()
          })
        if (updated !== 1) controller.abort(new PageMutationOutboxError('PROJECTION_LEASE_LOST', 'Page projection effect lease was lost'))
      } catch (error: unknown) {
        controller.abort(error)
      }
    }
    const heartbeatTimer = setInterval(() => {
      renewal = renewal.then(heartbeat)
    }, KNOWLEDGE_EFFECT_HEARTBEAT_MILLISECONDS)
    heartbeatTimer.unref()

    try {
      const sink = new KnowledgeProjectionSink(this.#knex, this.#enricher, claim)
      await executePageMutationEffect(this.#knex, claim, new Map([['knowledge', sink]]), controller.signal)
    } finally {
      clearInterval(heartbeatTimer)
      signal.removeEventListener('abort', abort)
      await renewal
    }
  }

  async runOnce(signal = new AbortController().signal): Promise<{ backfilled: number; requeued: number; processed: number }> {
    if (this.#running) return { backfilled: 0, requeued: 0, processed: 0 }
    this.#running = true
    try {
      const now = new Date()
      const profileVersionId = await currentProfileVersionId(this.#knex).catch(() => null)
      let backfilled = 0
      let hasMaintenanceTable = false
      try {
        hasMaintenanceTable = await this.#knex.schema.hasTable('pageKnowledgeMaintenance')
      } catch {
        hasMaintenanceTable = false
      }
      if (hasMaintenanceTable) {
        backfilled = (await maintainCurrentProjections(this.#knex, this.#workerId, now, 25))?.repaired ?? 0
      } else {
        const validation = await validateVolatileCurrentProjections(this.#knex, this.#projectionScanCursor, 25, now)
        this.#projectionScanCursor = validation.cursor
        backfilled = validation.repaired
      }
      const requeued = (await recoverTerminalFailures(this.#knex, now)) + (this.#enricher ? await requeueRetryable(this.#knex, profileVersionId, now) : 0)
      const claims = await claimPageMutationEffects(this.#knex, {
        leaseOwner: this.#workerId,
        limit: 10,
        leaseMs: KNOWLEDGE_EFFECT_LEASE_MILLISECONDS,
        effects: ['knowledge']
      })
      await Promise.allSettled(claims.map(claim => this.#executeClaim(claim, signal)))
      return { backfilled, requeued, processed: claims.length }
    } finally {
      this.#running = false
    }
  }
}
const validateVolatileCurrentProjections = async (
  knex: Knex,
  afterPageId: number,
  limit: number,
  now: Date
): Promise<{ repaired: number; cursor: number }> => {
  const rows = await loadCurrentProjectionScan(knex, afterPageId, limit)
  let repaired = 0
  for (const row of rows) repaired += await repairCurrentProjection(knex, row, now)
  return { repaired, cursor: rows.at(-1)?.id ?? 0 }
}
