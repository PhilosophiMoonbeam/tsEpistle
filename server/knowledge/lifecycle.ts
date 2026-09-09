import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { canReadPage, scopePageQuery, type PagePrincipal } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { isStructuredSearchQuery } from '../helpers/search-query.ts'
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
  KNOWLEDGE_DETERMINISTIC_VERSION,
  KNOWLEDGE_SCHEMA_VERSION,
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
  readonly pageId: number
  readonly sourceRevision: string | number
  readonly effectKind: string
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
  readonly deterministicVersion: string
  readonly searchDictionary: string | null
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
  readonly sourceRevision: string
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

const usesPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLocaleLowerCase())

const knowledgeSearchDictionary = (): string => {
  const wiki = Reflect.get(globalThis, 'WIKI')
  const data = wiki && typeof wiki === 'object' ? Reflect.get(wiki, 'data') : undefined
  const searchEngine = data && typeof data === 'object' ? Reflect.get(data, 'searchEngine') : undefined
  const config = searchEngine && typeof searchEngine === 'object' ? Reflect.get(searchEngine, 'config') : undefined
  const dictionary = config && typeof config === 'object' ? Reflect.get(config, 'dictLanguage') : undefined
  return typeof dictionary === 'string' && /^[a-z][a-z0-9_]{0,62}$/iu.test(dictionary) ? dictionary : 'english'
}

type UtilityEligibility = 'eligible' | 'superseded' | 'withheld-private' | 'withheld-unpublished' | 'withheld-protected'

interface PublicationWindowRow {
  readonly publishStartDate: string | Date | null
  readonly publishEndDate: string | Date | null
}

interface CurrentUtilityPageRow extends PublicationWindowRow {
  readonly id: number
  readonly sourceRevision: string | number
  readonly content: string
  readonly visibility: 'public' | 'private'
  readonly isPublished: boolean | number
}

const publicationWindowOpen = (page: PublicationWindowRow, now = Date.now()): boolean => {
  const start = page.publishStartDate
  const end = page.publishEndDate
  return (!start || new Date(String(start)).valueOf() <= now) && (!end || new Date(String(end)).valueOf() >= now)
}

const utilityEligibility = async (
  knex: Knex,
  payload: Pick<PageProjectionPayload, 'pageId' | 'sourceRevision' | 'sourceSha256'>
): Promise<UtilityEligibility> => {
  const page = (await knex<CurrentUtilityPageRow>('pages')
    .where({ id: payload.pageId })
    .first('sourceRevision', 'content', 'visibility', 'isPublished', 'publishStartDate', 'publishEndDate')) as CurrentUtilityPageRow | undefined
  if (!page || revision(page.sourceRevision) !== payload.sourceRevision || payload.sourceSha256 === null || sha256(page.content) !== payload.sourceSha256)
    return 'superseded'
  if (page.visibility !== 'public') return 'withheld-private'
  if (page.isPublished !== true && page.isPublished !== 1) return 'withheld-unpublished'
  if (!publicationWindowOpen(page)) return 'withheld-unpublished'
  const protectedPage = await knex('pageAccessPasswords').where({ pageId: payload.pageId }).first('pageId')
  return protectedPage ? 'withheld-protected' : 'eligible'
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
  if (Object.hasOwn(extra, 'okf') && validateStoredOkfMetadata(extra.okf) === null) throw new Error('Invalid claimed OKF metadata in pages.extra.okf')
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

const projectionColumns = (
  knex: Knex,
  projection: KnowledgeProjection,
  enrichmentState: string,
  error: string | null,
  now: string
): Record<string, unknown> => {
  const searchText = knowledgeSearchText(projection)
  const dictionary = knowledgeSearchDictionary()
  return {
    pageId: projection.source.pageId,
    sourceRevision: projection.source.sourceRevision,
    sourceSha256: projection.source.sha256,
    schemaVersion: projection.version,
    deterministicVersion: projection.provenance.deterministicVersion,
    state: projection.completeness.state,
    enrichmentState,
    conceptType: projection.concept.type,
    summary: projection.concept.summary,
    searchText,
    ...(usesPostgres(knex)
      ? {
          searchDictionary: dictionary,
          searchTokens: knex.raw('to_tsvector(?::regconfig, ?)', [dictionary, searchText])
        }
      : {}),
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
  }
}

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
    const initialEligibility = missingFields.length > 0 ? await utilityEligibility(this.#knex, payload) : 'eligible'
    const profileVersionId = this.#enricher && initialEligibility === 'eligible' && missingFields.length > 0 ? await currentProfileVersionId(this.#knex) : null
    let enrichmentState =
      missingFields.length === 0 ? 'not-needed' : initialEligibility !== 'eligible' ? initialEligibility : profileVersionId === null ? 'unavailable' : 'pending'
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
        const columns = projectionColumns(transaction, value, state, lastError, now)
        await transaction('pageKnowledgeProjections')
          .insert({ ...columns, createdAt: now })
          .onConflict(['pageId', 'sourceRevision'])
          .merge(columns)
        return true
      })
    }
    const persistSuperseded = async (): Promise<boolean> => {
      const now = new Date().toISOString()
      return this.#knex.transaction(async transaction => {
        const lease = await transaction('pageMutationOutbox')
          .where({ id: this.#claim.id, status: 'running', leaseToken: this.#claim.leaseToken })
          .forUpdate()
          .first('id')
        if (!lease) return false
        const current = (await transaction('pages').where({ id: payload.pageId }).forUpdate().first('sourceRevision', 'content')) as
          | { sourceRevision: string | number; content: string }
          | undefined
        if (current && revision(current.sourceRevision) === sourceRevision && payload.sourceSha256 !== null && sha256(current.content) === payload.sourceSha256)
          return false
        const columns = projectionColumns(transaction, projection, 'superseded', null, now)
        await transaction('pageKnowledgeProjections')
          .insert({ ...columns, createdAt: now })
          .onConflict(['pageId', 'sourceRevision'])
          .merge(columns)
        return true
      })
    }

    const persistOrSupersede = async (value: KnowledgeProjection, state: string, lastError: string | null): Promise<'persisted' | 'superseded'> => {
      if (await persist(value, state, lastError, true)) return 'persisted'
      if (await persistSuperseded()) return 'superseded'
      if (await persist(value, state, lastError, true)) return 'persisted'
      throw new PageMutationOutboxError('PROJECTION_SOURCE_FENCE_LOST', 'Exact source revision changed while finalizing the knowledge projection')
    }

    // The deterministic projection is authoritative and must become readable before
    // any optional provider call starts.
    await persist(projection, enrichmentState, null, false)

    if (this.#enricher && profileVersionId !== null && missingFields.length > 0 && enrichmentState === 'pending') {
      const beforeDispatch = await utilityEligibility(this.#knex, payload)
      if (beforeDispatch !== 'eligible') {
        enrichmentState = beforeDispatch
        if ((await persistOrSupersede(projection, enrichmentState, null)) !== 'persisted') enrichmentState = 'superseded'
      } else {
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
          const afterDispatch = await utilityEligibility(this.#knex, payload)
          if (afterDispatch !== 'eligible') {
            enrichmentState = afterDispatch
            if ((await persistOrSupersede(projection, enrichmentState, null)) !== 'persisted') enrichmentState = 'superseded'
          } else {
            const generatedAt = new Date().toISOString()
            const merged = mergeKnowledgeUtilityResult(projection, result.value, {
              profileVersionId,
              model: result.model,
              inputSha256: result.inputSha256,
              outputSha256: result.outputSha256,
              generatedAt
            })
            if ((await persistOrSupersede(merged, 'succeeded', null)) === 'persisted') projection = merged
            else enrichmentState = 'superseded'
          }
        } catch (cause: unknown) {
          if (signal.aborted) throw signal.reason
          const afterFailure = await utilityEligibility(this.#knex, payload)
          enrichmentState = afterFailure === 'eligible' ? 'failed' : afterFailure
          error = enrichmentState === 'failed' ? (cause instanceof Error ? cause.message.slice(0, 4_000) : 'Utility knowledge enrichment failed') : null
          if ((await persistOrSupersede(projection, enrichmentState, error)) !== 'persisted') enrichmentState = 'superseded'
        }
      }
    }

    const stored = (await this.#knex('pageKnowledgeProjections').where({ pageId: payload.pageId, sourceRevision }).first('sourceRevision', 'sourceSha256')) as
      | { sourceRevision: string | number; sourceSha256: string }
      | undefined
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
  row: Pick<StoredProjectionRow, 'sourceSha256' | 'deterministicVersion' | 'searchDictionary' | 'projection'> | undefined,
  pageId: number,
  sourceRevision: string,
  sourceSha256: string,
  expectedDictionary: string | null
): boolean => {
  if (!row || row.sourceSha256 !== sourceSha256 || (expectedDictionary !== null && row.searchDictionary !== expectedDictionary)) return false
  try {
    const projection = parseProjection(row)
    return (
      row.deterministicVersion === projection.provenance.deterministicVersion &&
      projection.source.pageId === pageId &&
      projection.source.sourceRevision === sourceRevision &&
      projection.source.sha256 === sourceSha256
    )
  } catch {
    return false
  }
}

const projectionView = (
  row: Pick<StoredProjectionRow, 'sourceSha256' | 'deterministicVersion' | 'searchDictionary' | 'projection'>,
  pageId: number,
  sourceRevision: string,
  expectedDictionary: string | null
): KnowledgeProjectionView | null => {
  if (!isValidProjection(row, pageId, sourceRevision, row.sourceSha256, expectedDictionary)) return null
  try {
    return knowledgeProjectionView(parseProjection(row))
  } catch {
    return null
  }
}

const searchIds = (ids: readonly number[] | undefined): readonly number[] | undefined =>
  ids === undefined ? undefined : [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))]

interface KnowledgeSearchProjectionRow extends StoredProjectionRow, PublicationWindowRow {
  readonly id: number
  readonly localeCode: string
  readonly path: string
  readonly visibility: 'public' | 'private'
  readonly ownerId: number | null
  readonly isPublished: boolean | number
}

export class PageKnowledgeRepository {
  readonly #knex: Knex

  constructor(knex: Knex) {
    this.#knex = knex
  }

  async #rearmUnavailableRevision(pageId: number, sourceRevision: string): Promise<void> {
    try {
      await this.#knex.transaction(async transaction => {
        const effect = await transaction<CurrentKnowledgeEffectRow>('pageMutationOutbox')
          .where({ pageId, sourceRevision, effectKind: 'knowledge' })
          .whereIn('status', ['succeeded', 'failed'])
          .first('id', 'payload')
        if (!effect) return
        const source = await loadSource(transaction, pageId, sourceRevision)
        const payload = parseKnowledgeEffectPayload(effect.payload)
        if (
          !source ||
          payload.pageId !== pageId ||
          payload.sourceRevision !== sourceRevision ||
          payload.sourceSha256 === null ||
          sha256(source.content) !== payload.sourceSha256
        )
          return
        await rearmPageMutationEffect(transaction, { id: effect.id, payload })
      })
    } catch {
      // Historical projection repair is best effort; reads must never surface malformed derived data.
    }
  }

  async getCurrent(pageId: number): Promise<KnowledgeProjectionView | null> {
    const row = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .where('projections.pageId', pageId)
      .first(
        'projections.pageId',
        'projections.sourceRevision',
        'projections.sourceSha256',
        'projections.deterministicVersion',
        'projections.searchDictionary',
        'projections.projection'
      )
    return row ? projectionView(row, Number(row.pageId), revision(row.sourceRevision), usesPostgres(this.#knex) ? knowledgeSearchDictionary() : null) : null
  }

  async getRevision(pageId: number, sourceRevision: string): Promise<KnowledgeProjectionView | null> {
    const row = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections')
      .where({ pageId, sourceRevision })
      .first('pageId', 'sourceRevision', 'sourceSha256', 'deterministicVersion', 'searchDictionary', 'projection')
    const view = row ? projectionView(row, pageId, sourceRevision, usesPostgres(this.#knex) ? knowledgeSearchDictionary() : null) : null
    if (view === null) await this.#rearmUnavailableRevision(pageId, sourceRevision)
    return view
  }

  async getCurrentMany(pageIds: readonly number[]): Promise<ReadonlyMap<number, KnowledgeProjectionView>> {
    const ids = searchIds(pageIds)
    if (!ids || ids.length === 0) return new Map()
    const rows = await this.#knex<StoredProjectionRow>('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .whereIn('projections.pageId', ids)
      .select(
        'projections.pageId',
        'projections.sourceRevision',
        'projections.sourceSha256',
        'projections.deterministicVersion',
        'projections.searchDictionary',
        'projections.projection'
      )
    const dictionary = usesPostgres(this.#knex) ? knowledgeSearchDictionary() : null
    const values = new Map<number, KnowledgeProjectionView>()
    for (const row of rows) {
      const pageId = Number(row.pageId)
      const view = projectionView(row, pageId, revision(row.sourceRevision), dictionary)
      if (view) values.set(pageId, view)
    }
    return values
  }

  async filterVisibleCurrentIds(input: {
    readonly requester: PagePrincipal
    readonly authority: PageRuleAuthority
    readonly pageIds?: readonly number[]
    readonly authorizedPageIds?: readonly number[]
    readonly filter?: KnowledgeDiscoveryFilter
  }): Promise<readonly number[]> {
    const selectedIds = searchIds(input.pageIds)
    if (input.pageIds !== undefined && selectedIds?.length === 0) return []
    const authorizedPublicIds = searchIds(input.authorizedPageIds)
    const dictionary = usesPostgres(this.#knex) ? knowledgeSearchDictionary() : null
    const now = new Date()
    const nowIso = now.toISOString()
    const rowsQuery = this.#knex<KnowledgeSearchProjectionRow>('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .where('projections.schemaVersion', KNOWLEDGE_SCHEMA_VERSION)
      .where('projections.deterministicVersion', KNOWLEDGE_DETERMINISTIC_VERSION)
      .whereNotExists(protection =>
        protection.select(this.#knex.raw('1')).from('pageAccessPasswords').whereRaw('?? = ??', ['pageAccessPasswords.pageId', 'pages.id'])
      )
      .where(visibility => {
        visibility.where('pages.visibility', 'private').orWhere(publicPage => {
          publicPage.where('pages.isPublished', true)
        })
      })
    if (selectedIds !== undefined) rowsQuery.whereIn('pages.id', selectedIds)
    else rowsQuery.where('pages.visibility', 'private')
    if (dictionary !== null) rowsQuery.where('projections.searchDictionary', dictionary)
    if (input.filter?.state !== undefined) rowsQuery.where('projections.state', input.filter.state)
    if (input.filter?.lifecycleStatus !== undefined) rowsQuery.where('projections.lifecycleStatus', input.filter.lifecycleStatus)
    if (input.filter?.trustTier !== undefined) rowsQuery.where('projections.trustTier', input.filter.trustTier)
    if (input.filter?.stale === true) rowsQuery.whereNotNull('projections.staleAfter').andWhere('projections.staleAfter', '<=', nowIso)
    if (input.filter?.stale === false) {
      rowsQuery.andWhere(stale => stale.whereNull('projections.staleAfter').orWhere('projections.staleAfter', '>', nowIso))
    }
    if (input.filter?.conceptType !== undefined) {
      rowsQuery.whereRaw('LOWER(??) = ?', ['projections.conceptType', input.filter.conceptType.toLocaleLowerCase()])
    }
    scopePageQuery(rowsQuery, input.requester, { table: 'pages', includeAllForSystemManager: true })
    if (authorizedPublicIds !== undefined) {
      rowsQuery.andWhere(visible => {
        visible.where('pages.visibility', 'private')
        if (authorizedPublicIds.length > 0)
          visible.orWhere(publicPage => publicPage.where('pages.visibility', 'public').whereIn('pages.id', authorizedPublicIds))
      })
    }
    if (selectedIds === undefined) {
      const privateRows = await rowsQuery.select('pages.id').orderBy('pages.id')
      return privateRows.map(row => Number(row.id))
    }
    const rows = await rowsQuery.select(
      'pages.id',
      'pages.localeCode',
      'pages.path',
      'pages.visibility',
      'pages.ownerId',
      'pages.isPublished',
      'pages.publishStartDate',
      'pages.publishEndDate',
      'projections.sourceRevision',
      'projections.sourceSha256',
      'projections.deterministicVersion',
      'projections.searchDictionary',
      'projections.projection'
    )
    const tagRows = (await this.#knex('pageTags')
      .join('tags', 'tags.id', 'pageTags.tagId')
      .whereIn(
        'pageTags.pageId',
        rows.map(row => Number(row.id))
      )
      .select('pageTags.pageId', 'tags.tag')) as Array<{ pageId: number; tag: string }>
    const tagsByPage = new Map<number, string[]>()
    for (const tag of tagRows) {
      const pageId = Number(tag.pageId)
      tagsByPage.set(pageId, [...(tagsByPage.get(pageId) ?? []), tag.tag])
    }
    const visibleIds = new Set<number>()
    for (const row of rows) {
      const pageId = Number(row.id)
      if (row.visibility === 'public' && ((row.isPublished !== true && row.isPublished !== 1) || !publicationWindowOpen(row, now.valueOf()))) continue
      if (!canReadPage(input.requester, { ...row, tags: tagsByPage.get(pageId) ?? [] }, input.authority)) continue
      const knowledge = projectionView(row, pageId, revision(row.sourceRevision), dictionary)
      if (knowledge && matchesKnowledgeFilter(knowledge, input.filter)) visibleIds.add(pageId)
    }
    return selectedIds.filter(pageId => visibleIds.has(pageId))
  }

  async searchVisible(input: {
    readonly query: string
    readonly requester: PagePrincipal
    readonly authority: PageRuleAuthority
    readonly locale?: string
    readonly path?: string
    readonly limit: number
    readonly pageIds?: readonly number[]
    readonly authorizedPageIds?: readonly number[]
    readonly filter?: KnowledgeDiscoveryFilter
  }): Promise<readonly KnowledgeSearchCandidate[]> {
    const query = input.query.trim()
    if (!query) return []
    const limit = Math.max(1, Math.min(100, input.limit))
    const selectedIds = searchIds(input.pageIds)
    if (selectedIds?.length === 0 || isStructuredSearchQuery(query)) return []
    const authorizedPublicIds = searchIds(input.authorizedPageIds)
    const postgresql = usesPostgres(this.#knex)
    const dictionary = postgresql ? knowledgeSearchDictionary() : null
    const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, '\\$&')
    const now = new Date()
    const candidateLimit = Math.max(limit, Math.min(500, limit * 10))
    const batchSize = 50
    const candidates: KnowledgeSearchCandidate[] = []
    let afterId = 0

    while (candidates.length < candidateLimit) {
      const rowsQuery = this.#knex<KnowledgeSearchProjectionRow>('pageKnowledgeProjections as projections')
        .join('pages', function () {
          this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
        })
        .where('pages.id', '>', afterId)
        .whereNotExists(protection =>
          protection.select(this.#knex.raw('1')).from('pageAccessPasswords').whereRaw('?? = ??', ['pageAccessPasswords.pageId', 'pages.id'])
        )
        .where(visibility => {
          visibility.where('pages.visibility', 'private').orWhere(publicPage => {
            publicPage.where('pages.visibility', 'public').where('pages.isPublished', true)
          })
        })
      scopePageQuery(rowsQuery, input.requester, { table: 'pages', includeAllForSystemManager: true })
      if (selectedIds !== undefined) rowsQuery.whereIn('pages.id', selectedIds)
      if (authorizedPublicIds !== undefined) {
        rowsQuery.andWhere(visible => {
          visible.where('pages.visibility', 'private')
          if (authorizedPublicIds.length > 0)
            visible.orWhere(publicPage => publicPage.where('pages.visibility', 'public').whereIn('pages.id', authorizedPublicIds))
        })
      }
      if (input.locale !== undefined) rowsQuery.where('pages.localeCode', input.locale)
      const path = input.path
      if (path !== undefined) {
        rowsQuery.andWhere(pathScope => {
          pathScope.where('pages.path', path).orWhereRaw('?? LIKE ? ESCAPE ?', ['pages.path', `${escapeLike(path)}/%`, '\\'])
        })
      }
      if (postgresql)
        rowsQuery
          .where('projections.searchDictionary', dictionary)
          .whereRaw('?? @@ websearch_to_tsquery(?::regconfig, ?)', ['projections.searchTokens', dictionary, query])
      else rowsQuery.whereRaw('?? LIKE ? ESCAPE ?', ['projections.searchText', `%${escapeLike(query.toLocaleLowerCase())}%`, '\\'])
      const rows = await rowsQuery
        .select(
          'pages.id',
          'pages.localeCode',
          'pages.path',
          'pages.visibility',
          'pages.isPublished',
          'pages.publishStartDate',
          'pages.publishEndDate',
          'pages.ownerId',
          'projections.sourceRevision',
          'projections.sourceSha256',
          'projections.deterministicVersion',
          'projections.searchDictionary',
          'projections.projection'
        )
        .orderBy('pages.id')
        .limit(batchSize)
      if (rows.length === 0) break
      afterId = Number(rows.at(-1)?.id ?? afterId)
      const tagRows = (await this.#knex('pageTags')
        .join('tags', 'tags.id', 'pageTags.tagId')
        .whereIn(
          'pageTags.pageId',
          rows.map(row => Number(row.id))
        )
        .select('pageTags.pageId', 'tags.tag')) as Array<{ pageId: number; tag: string }>
      const tagsByPage = new Map<number, string[]>()
      for (const tag of tagRows) {
        const pageId = Number(tag.pageId)
        tagsByPage.set(pageId, [...(tagsByPage.get(pageId) ?? []), tag.tag])
      }
      for (const row of rows) {
        const pageId = Number(row.id)
        if (row.visibility === 'public' && ((row.isPublished !== true && row.isPublished !== 1) || !publicationWindowOpen(row, now.valueOf()))) continue
        if (!canReadPage(input.requester, { ...row, tags: tagsByPage.get(pageId) ?? [] }, input.authority)) continue
        const sourceRevision = revision(row.sourceRevision)
        const knowledge = projectionView(row, pageId, sourceRevision, dictionary)
        if (!knowledge || !matchesKnowledgeFilter(knowledge, input.filter)) continue
        const exact =
          knowledge.conceptType?.toLocaleLowerCase() === query.toLocaleLowerCase() ||
          knowledge.tags.some(tag => tag.toLocaleLowerCase() === query.toLocaleLowerCase())
        candidates.push({
          id: pageId,
          sourceRevision,
          locale: row.localeCode,
          path: row.path,
          visibility: row.visibility,
          score: exact ? 7 : 2,
          matchedFields: ['knowledge'],
          knowledge
        })
      }
    }
    return candidates
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
    const dictionary = usesPostgres(transaction) ? knowledgeSearchDictionary() : null
    const projection = await transaction<StoredProjectionRow>('pageKnowledgeProjections')
      .where({ pageId: page.id, sourceRevision })
      .first('sourceSha256', 'deterministicVersion', 'searchDictionary', 'projection')
    if (isValidProjection(projection, Number(page.id), sourceRevision, sourceSha256, dictionary)) return 0

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
      const dictionary = usesPostgres(transaction) ? knowledgeSearchDictionary() : null
      const projection = await transaction<StoredProjectionRow>('pageKnowledgeProjections')
        .where({ pageId: row.pageId, sourceRevision })
        .first('sourceSha256', 'deterministicVersion', 'searchDictionary', 'projection')
      if (projection) {
        const authoritativeSource = await loadSource(transaction, Number(row.pageId), sourceRevision)
        if (!authoritativeSource) return 0
        const sourceSha256 = projectPageKnowledge(authoritativeSource).source.sha256
        if (isValidProjection(projection, Number(row.pageId), sourceRevision, sourceSha256, dictionary)) return 0
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
  const rows: Array<{ id: string }> = []
  let afterPageId = 0
  while (rows.length < 25) {
    const batch = (await knex<PublicationWindowRow & { id: string; pageId: number }>('pageKnowledgeProjections as projections')
      .join('pages', function () {
        this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
      })
      .join('pageMutationOutbox as effects', function () {
        this.on('effects.pageId', '=', 'projections.pageId').andOn('effects.sourceRevision', '=', 'projections.sourceRevision')
      })
      .where('pages.id', '>', afterPageId)
      .where('effects.effectKind', 'knowledge')
      .where('effects.status', 'succeeded')
      .where('pages.visibility', 'public')
      .where('pages.isPublished', true)
      .whereNotExists(function () {
        this.select(knex.raw('1')).from('pageAccessPasswords').whereRaw('?? = ??', ['pageAccessPasswords.pageId', 'pages.id'])
      })
      .where(builder =>
        builder
          .where('projections.enrichmentState', 'unavailable')
          .orWhere(retry => retry.where('projections.enrichmentState', 'failed').andWhere('projections.updatedAt', '<=', retryBefore))
          .orWhere(retry => retry.whereIn('projections.enrichmentState', ['withheld-unpublished', 'withheld-protected']))
          .orWhere(retry => retry.where('projections.enrichmentState', 'succeeded').andWhereNot('projections.utilityProfileVersionId', profileVersionId))
      )
      .select('effects.id', 'pages.id as pageId', 'pages.publishStartDate', 'pages.publishEndDate')
      .orderBy('pages.id')
      .limit(50)) as Array<PublicationWindowRow & { id: string; pageId: number }>
    if (batch.length === 0) break
    afterPageId = Number(batch.at(-1)?.pageId ?? afterPageId)
    for (const row of batch) {
      if (publicationWindowOpen(row, now.valueOf())) rows.push({ id: row.id })
      if (rows.length === 25) break
    }
  }
  if (rows.length === 0) return 0
  return knex.transaction(async transaction => {
    let requeued = 0
    for (const row of rows) {
      const effect = await transaction<CurrentKnowledgeEffectRow>('pageMutationOutbox')
        .where({ id: row.id, status: 'succeeded' })
        .whereNull('leaseOwner')
        .whereNull('leaseToken')
        .whereNull('leaseExpiresAt')
        .forUpdate()
        .first('id', 'pageId', 'sourceRevision')
      if (!effect) continue
      const retryable = await transaction<PublicationWindowRow>('pageKnowledgeProjections as projections')
        .join('pages', function () {
          this.on('pages.id', '=', 'projections.pageId').andOn('pages.sourceRevision', '=', 'projections.sourceRevision')
        })
        .where({ 'projections.pageId': effect.pageId, 'projections.sourceRevision': effect.sourceRevision })
        .where('pages.visibility', 'public')
        .where('pages.isPublished', true)
        .whereNotExists(function () {
          this.select(transaction.raw('1')).from('pageAccessPasswords').whereRaw('?? = ??', ['pageAccessPasswords.pageId', 'pages.id'])
        })
        .where(builder =>
          builder
            .where('projections.enrichmentState', 'unavailable')
            .orWhere(retry => retry.where('projections.enrichmentState', 'failed').andWhere('projections.updatedAt', '<=', retryBefore))
            .orWhere(retry => retry.whereIn('projections.enrichmentState', ['withheld-unpublished', 'withheld-protected']))
            .orWhere(retry => retry.where('projections.enrichmentState', 'succeeded').andWhereNot('projections.utilityProfileVersionId', profileVersionId))
        )
        .forUpdate()
        .first('projections.pageId', 'pages.publishStartDate', 'pages.publishEndDate')
      if (!retryable || !publicationWindowOpen(retryable, now.valueOf())) continue
      const updated = await transaction('pageMutationOutbox')
        .where({ id: effect.id, status: 'succeeded' })
        .whereNull('leaseOwner')
        .whereNull('leaseToken')
        .whereNull('leaseExpiresAt')
        .update({
          status: 'pending',
          attempts: 0,
          availableAt: now.toISOString(),
          result: null,
          postcondition: null,
          updatedAt: now.toISOString()
        })
      if (updated === 1) requeued += 1
    }
    return requeued
  })
}

export interface PageKnowledgeLifecycleOptions {
  readonly utilityConcurrency?: number
}

export class PageKnowledgeLifecycle {
  readonly #knex: Knex
  readonly #enricher: AgentKnowledgeEnricher | undefined
  readonly #workerId: string
  readonly #utilityConcurrency: number
  #running = false
  #projectionScanCursor = 0

  constructor(knex: Knex, workerId: string, enricher?: AgentKnowledgeEnricher, options: PageKnowledgeLifecycleOptions = {}) {
    this.#knex = knex
    this.#workerId = workerId
    this.#enricher = enricher
    this.#utilityConcurrency =
      options.utilityConcurrency !== undefined && Number.isSafeInteger(options.utilityConcurrency) ? Math.max(1, Math.min(128, options.utilityConcurrency)) : 10
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
        limit: this.#utilityConcurrency,
        maxActive: this.#utilityConcurrency,
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
const validateVolatileCurrentProjections = async (knex: Knex, afterPageId: number, limit: number, now: Date): Promise<{ repaired: number; cursor: number }> => {
  const rows = await loadCurrentProjectionScan(knex, afterPageId, limit)
  let repaired = 0
  for (const row of rows) repaired += await repairCurrentProjection(knex, row, now)
  return { repaired, cursor: rows.at(-1)?.id ?? 0 }
}
