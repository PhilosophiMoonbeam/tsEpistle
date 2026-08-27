import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { canReadPage, scopePageQuery, type PagePrincipal } from '../helpers/page-access.ts'
import {
  claimPageMutationEffects,
  enqueuePageMutationEffects,
  executePageMutationEffect,
  type PageProjectionPayload,
  type PageProjectionSink
} from '../core/page-mutation-outbox.ts'
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

interface SourceRow {
  readonly id?: number
  readonly pageId?: number
  readonly sourceRevision: string | number
  readonly localeCode: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly contentType: string
  readonly content: string
  readonly title: string
  readonly description: string | null
  readonly updatedAt: string | Date
  readonly authorId: number
  readonly extra: unknown
  readonly ownerId: number | null
}

interface StoredProjectionRow {
  readonly pageId: number
  readonly sourceRevision: string | number
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
      return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const revision = (value: string | number): string => String(value)
const currentProfileVersionId = async (knex: Knex): Promise<string | null> => {
  const row = await knex('agentProviderProfiles')
    .join('agentProviderProfileVersions', 'agentProviderProfileVersions.id', 'agentProviderProfiles.currentVersionId')
    .where({
      'agentProviderProfiles.status': 'enabled',
      'agentProviderProfiles.isGlobalDefault': true,
      'agentProviderProfiles.conformed': true,
      'agentProviderProfileVersions.conformed': true
    })
    .whereNull('agentProviderProfiles.deletedAt')
    .first('agentProviderProfileVersions.id') as { id: string } | undefined
  return row?.id ?? null
}

const loadTags = async (knex: Knex, pageId: number, historyId?: number): Promise<string[]> => {
  const rows = historyId === undefined
    ? await knex('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', pageId).orderBy('tags.tag').pluck<string>('tags.tag')
    : await knex('pageHistoryTags').join('tags', 'tags.id', 'pageHistoryTags.tagId').where('pageHistoryTags.pageId', historyId).orderBy('tags.tag').pluck<string>('tags.tag')
  return rows
}

const loadSource = async (knex: Knex, pageId: number, sourceRevision: string): Promise<KnowledgePageSource | null> => {
  let row = await knex<SourceRow>('pages').where({ id: pageId, sourceRevision }).first()
  let historyId: number | undefined
  if (!row) {
    row = await knex<SourceRow>('pageHistory').where({ pageId, sourceRevision }).orderBy('id', 'desc').first()
    historyId = row?.id
  }
  if (!row) return null
  const extra = parsedExtra(row.extra)
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
    updatedAt: row.updatedAt,
    authorId: row.authorId,
    metadata: extra.okf
  }
}

const projectionColumns = (
  projection: KnowledgeProjection,
  enrichmentState: string,
  error: string | null,
  now: string
): Record<string, unknown> => ({
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

  constructor(knex: Knex, enricher?: AgentKnowledgeEnricher) {
    this.#knex = knex
    this.#enricher = enricher
  }

  async reconcile(payload: PageProjectionPayload, signal: AbortSignal) {
    if (payload.desiredState === 'absent') {
      const current = await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision') as { sourceRevision: string | number } | undefined
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
      const current = await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision') as { sourceRevision: string | number } | undefined
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
    let enrichmentState = projection.completeness.state === 'complete' ? 'not-needed' : 'unavailable'
    let error: string | null = null
    const currentBeforeEnrichment = await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision') as { sourceRevision: string | number } | undefined
    const isCurrentRevision = currentBeforeEnrichment !== undefined && revision(currentBeforeEnrichment.sourceRevision) === sourceRevision
    const profileVersionId = this.#enricher && isCurrentRevision && source.visibility === 'public' && projection.completeness.missingFields.length > 0
      ? await currentProfileVersionId(this.#knex)
      : null
    if (!isCurrentRevision && projection.completeness.missingFields.length > 0) enrichmentState = 'superseded'
    else if (source.visibility === 'private' && projection.completeness.missingFields.length > 0) enrichmentState = 'withheld-private'
    if (this.#enricher && profileVersionId !== null && projection.completeness.missingFields.length > 0) {
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
          missingFields: projection.completeness.missingFields,
          signal
        })
        if (signal.aborted) throw signal.reason
        const currentAfterEnrichment = await this.#knex('pages').where({ id: payload.pageId }).first('sourceRevision') as { sourceRevision: string | number } | undefined
        const reloaded = await loadSource(this.#knex, payload.pageId, sourceRevision)
        if (
          currentAfterEnrichment === undefined ||
          revision(currentAfterEnrichment.sourceRevision) !== sourceRevision ||
          !reloaded ||
          sha256(reloaded.content) !== payload.sourceSha256
        ) {
          enrichmentState = 'superseded'
        } else {
          const generatedAt = new Date().toISOString()
          projection = mergeKnowledgeUtilityResult(projection, result.value, {
            profileVersionId,
            model: result.model,
            inputSha256: result.inputSha256,
            outputSha256: result.outputSha256,
            generatedAt
          })
          enrichmentState = 'succeeded'
        }
      } catch (cause: unknown) {
        if (signal.aborted) throw signal.reason
        enrichmentState = 'failed'
        error = cause instanceof Error ? cause.message.slice(0, 4_000) : 'Utility knowledge enrichment failed'
      }
    }

    const now = new Date().toISOString()
    const columns = projectionColumns(projection, enrichmentState, error, now)
    await this.#knex('pageKnowledgeProjections')
      .insert({ ...columns, createdAt: now })
      .onConflict(['pageId', 'sourceRevision'])
      .merge(columns)
    const stored = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections')
      .where({ pageId: payload.pageId, sourceRevision })
      .first('sourceRevision', 'sourceSha256') as (StoredProjectionRow & { sourceSha256: string }) | undefined
    const satisfied = stored?.sourceSha256 === projection.source.sha256 && sha256(source.content) === payload.sourceSha256
    return {
      result: { state: projection.completeness.state, enrichmentState, missingFields: projection.completeness.missingFields },
      postcondition: {
        satisfied,
        observedSourceRevision: stored ? revision(stored.sourceRevision) : null,
        detail: satisfied ? 'Knowledge projection matches the exact source revision and authoritative snapshot hash' : 'Knowledge projection postcondition failed'
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
    const operator = String(this.#knex.client.config.client).includes('pg') ? 'ILIKE' : 'LIKE'
    const rows = await this.#knex('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .where(builder => {
        scopePageQuery(builder, input.requester, { table: 'pages' })
        builder.andWhere('projections.searchText', operator, `%${query}%`)
        if (input.locale !== undefined) builder.andWhere('pages.localeCode', input.locale)
        if (input.path !== undefined) builder.andWhere(pathScope => {
          pathScope.where('pages.path', input.path).orWhere('pages.path', 'LIKE', `${input.path}/%`)
        })
      })
      .select('pages.id', 'pages.localeCode', 'pages.path', 'pages.visibility', 'pages.ownerId', 'projections.projection')
      .limit(Math.max(1, Math.min(100, input.limit))) as Array<{ id: number; localeCode: string; path: string; visibility: 'public' | 'private'; ownerId: number | null; projection: string }>
    const protectedRows = rows.length === 0 ? [] : await this.#knex('pageAccessPasswords').whereIn('pageId', rows.map(row => row.id)).select('pageId') as Array<{ pageId: number }>
    const protectedIds = new Set(protectedRows.map(row => Number(row.pageId)))
    const tagRows = rows.length === 0 ? [] : await this.#knex('pageTags').join('tags', 'tags.id', 'pageTags.tagId').whereIn('pageTags.pageId', rows.map(row => row.id)).select('pageTags.pageId', 'tags.tag') as Array<{ pageId: number; tag: string }>
    const tagsByPage = new Map<number, string[]>()
    for (const tag of tagRows) tagsByPage.set(tag.pageId, [...(tagsByPage.get(tag.pageId) ?? []), tag.tag])
    return rows.flatMap(row => {
      if (protectedIds.has(row.id) || !canReadPage(input.requester, { ...row, tags: tagsByPage.get(row.id) ?? [] })) return []
      const projection = KnowledgeProjectionSchema.parse(JSON.parse(row.projection) as unknown)
      const knowledge = knowledgeProjectionView(projection)
      if (!matchesKnowledgeFilter(knowledge, input.filter)) return []
      const exact = knowledge.conceptType?.toLocaleLowerCase() === query || knowledge.tags.some((tag: string) => tag.toLocaleLowerCase() === query)
      return [{ id: row.id, locale: row.localeCode, path: row.path, visibility: row.visibility, score: exact ? 7 : 2, matchedFields: ['knowledge'] as const, knowledge }]
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  }
}

const enqueueMissing = async (knex: Knex, limit: number): Promise<number> => {
  const missing = knex('pageMutationOutbox')
    .select(knex.raw('1'))
    .whereRaw('"pageMutationOutbox"."pageId" = "pages"."id"')
    .whereRaw('"pageMutationOutbox"."sourceRevision" = "pages"."sourceRevision"')
    .where('pageMutationOutbox.effectKind', 'knowledge')
  const rows = await knex<SourceRow>('pages')
    .whereNotExists(missing)
    .select('id', 'sourceRevision', 'content', 'localeCode', 'path', 'visibility', 'ownerId')
    .orderBy('id')
    .limit(limit)
  for (const row of rows) {
    await enqueuePageMutationEffects(knex, {
      pageId: Number(row.id),
      sourceRevision: row.sourceRevision,
      desiredState: 'present',
      action: 'update',
      source: row.content,
      location: { locale: row.localeCode, path: row.path, visibility: row.visibility, ownerId: row.ownerId },
      effects: ['knowledge']
    })
  }
  return rows.length
}

const requeueRetryable = async (knex: Knex, profileVersionId: string | null, now: Date): Promise<number> => {
  if (profileVersionId === null) return 0
  const retryBefore = new Date(now.valueOf() - RETRY_FAILED_AFTER_MILLISECONDS).toISOString()
  const rows = await knex<StoredProjectionRow>('pageKnowledgeProjections as projections')
    .join('pages', function () {
      this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
    })
    .join('pageMutationOutbox as effects', function () {
      this.on('effects.pageId', '=', 'projections.pageId').andOn('effects.sourceRevision', '=', 'projections.sourceRevision')
    })
    .where('effects.effectKind', 'knowledge')
    .where('effects.status', 'succeeded')
    .where('pages.visibility', 'public')
    .where(builder => builder
      .where('projections.enrichmentState', 'unavailable')
      .orWhere(retry => retry.where('projections.enrichmentState', 'failed').andWhere('projections.updatedAt', '<=', retryBefore)))
    .select('effects.id')
    .limit(25) as Array<{ id: string }>
  if (rows.length === 0) return 0
  return knex('pageMutationOutbox').whereIn('id', rows.map(row => row.id)).update({
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
  readonly #sink: KnowledgeProjectionSink
  readonly #workerId: string
  #running = false

  constructor(knex: Knex, workerId: string, enricher?: AgentKnowledgeEnricher) {
    this.#knex = knex
    this.#workerId = workerId
    this.#sink = new KnowledgeProjectionSink(knex, enricher)
  }

  async runOnce(signal = new AbortController().signal): Promise<{ backfilled: number; requeued: number; processed: number }> {
    if (this.#running) return { backfilled: 0, requeued: 0, processed: 0 }
    this.#running = true
    try {
      const profileVersionId = await currentProfileVersionId(this.#knex).catch(() => null)
      const backfilled = await enqueueMissing(this.#knex, 25)
      const requeued = await requeueRetryable(this.#knex, profileVersionId, new Date())
      const claims = await claimPageMutationEffects(this.#knex, { leaseOwner: this.#workerId, limit: 10, leaseMs: 120_000, effects: ['knowledge'] })
      const sinks = new Map([['knowledge', this.#sink] as const])
      await Promise.allSettled(claims.map(claim => executePageMutationEffect(this.#knex, claim, sinks, signal)))
      return { backfilled, requeued, processed: claims.length }
    } finally {
      this.#running = false
    }
  }
}

