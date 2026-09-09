import taxonomy from './taxonomy.ts'
import { resolveTagName } from '../helpers/tag-aliases.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import { tagNames } from '../helpers/taxonomy-plan.ts'
import _ from 'lodash'
import { searchExcerpt } from '../helpers/search-excerpt.ts'
import { isStructuredSearchQuery } from '../helpers/search-query.ts'
import { PageKnowledgeRepository, type KnowledgeDiscoveryFilter } from '../knowledge/lifecycle.ts'
import type { KnowledgeProjectionView } from '../knowledge/projection.ts'
import type { WikiSource } from '../../shared/wiki-source.ts'
import type { Knex } from 'knex'
import type { SearchResult as ProviderSearchResult } from '../modules/types.ts'
import { canDeletePage, canReadPage, canWritePage, managesSystem, pageAuthorizationContext, pageRoute, principalId, scopePageQuery, type PageVisibility } from '../helpers/page-access.ts'
import { listPageIndexCandidates, PAGE_INDEX_CANDIDATE_LIMIT } from '../repositories/page-index.ts'
import { pageTreeAccess, treeAncestorIds } from '../repositories/page-tree-access.ts'
import { isPageEditorKey, normalizeAvailableEditors } from '../../shared/page-editors.ts'
import { OKF_PRODUCER_CONTEXT } from '../okf/mutation-context.ts'
import { assertPageUnlocked } from './page-protection.ts'
import errors from './errors.ts'
import { PageBrandingAssignmentSchema, type PageBrandingAssignment, type PageBrandingView } from '../../shared/page-branding.ts'
import { resolveAssetBrandingView } from '../helpers/asset-branding.ts'

const { ApplicationError } = errors
const PRIVATE_SEARCH_WINDOW_LIMIT = 50
const KNOWLEDGE_SEARCH_WINDOW_LIMIT = 100
const DEFAULT_PUBLIC_SEARCH_WINDOW_LIMIT = 100

interface TagRecord extends Record<string, unknown> {
  id: number
  tag: string
  title?: string | null
}
interface PageRecord extends Record<string, unknown> {
  id: number
  path: string
  locale?: string
  localeCode: string
  title: string
  description?: string | null
  updatedAt: Date
  sourceRevision?: string | number
  editorKey: string
  extra: Record<string, unknown>
  visibility: PageVisibility
  ownerId: number | null
  isPublished: boolean
  tags: TagRecord[]
}
interface PageSourceRecord extends PageRecord {
  content: string
}
interface PageVersionRecord extends Record<string, unknown> {
  pageId: number
  content: string
  description: string
  editor: string
  title: string
  extra: unknown
}
interface PageVersionProjection extends PageVersionRecord {
  extra: Record<string, unknown>
  branding: PageBrandingView | null
  brandingAssignment?: PageBrandingAssignment | null
}
interface PageDetail extends PageRecord {
  branding: PageBrandingView | null
  brandingAssignment?: PageBrandingAssignment | null
  editor: string
  locale: string
  scriptCss: unknown
  scriptJs: unknown
}
interface PageTreeRecord extends Record<string, unknown> {
  id: number
  parent?: number | null
  ancestors?: string | number[]
  path: string
  localeCode: string
  visibility: PageVisibility
  ownerId: number | null
}
interface LinkRow {
  id: number
  title: string
  path: string
  sourceRevision?: string | number
  sourceLocale?: string
  link?: string
  locale?: string
  targetId?: number
  targetRevision?: string | number
  targetPath?: string
  targetLocale?: string
}
interface PageGraphEdgeRow {
  sourceId: number
  targetId: number
  sourceRevision?: string | number
  targetRevision?: string | number
  sourcePath?: string
  sourceLocale?: string
  targetPath?: string
  targetLocale?: string
}
interface PageMutationReceiptRow {
  pageId: number
  sourceRevision: string | number
}
interface RelatedPageRecord extends PageRecord {
  distance: number
  direction: 'incoming' | 'outgoing' | 'bidirectional'
  viaPageId: number
}
interface RelatedPagesResult {
  pages: RelatedPageRecord[]
  truncated: boolean
  nextOffset: number | null
}
interface LinkResult {
  id: number
  title: string
  path: string
  links: string[]
}
interface QueryBuilder {
  select(...columns: string[]): QueryBuilder
  where(column: string, operatorOrValue: unknown, value?: unknown): QueryBuilder
  where(callback: (builder: QueryBuilder) => void): QueryBuilder
  where(criteria: Record<string, unknown>): QueryBuilder
  whereNull(column: string): QueryBuilder
  whereIn(column: string, values: readonly unknown[]): QueryBuilder
  whereExists(callback: (builder: QueryBuilder) => void): QueryBuilder
  from(table: string): QueryBuilder
  join(table: string, first: string, second: string): QueryBuilder
  orWhere(column: string, operatorOrValue: unknown, value?: unknown): QueryBuilder
  orWhere(criteria: Record<string, unknown>): QueryBuilder
  orWhereIn(column: string, values: readonly unknown[]): QueryBuilder
  andWhere(column: string, operatorOrValue: unknown, value?: unknown): QueryBuilder
  andWhere(callback: (builder: QueryBuilder) => void): QueryBuilder
  whereNotNull(column: string): QueryBuilder
  whereRaw(sql: string, bindings: unknown[]): QueryBuilder
  limit(value: number): QueryBuilder
  offset(value: number): QueryBuilder
  orderBy(column: unknown, direction?: string): QueryBuilder
}
interface PageQuery extends PromiseLike<PageRecord[]> {
  column(columns: unknown[]): PageQuery
  select(...columns: string[]): PageQuery
  withGraphFetched(relation: string): PageQuery
  withGraphJoined(relation: string): PageQuery
  modifyGraph(relation: string, callback: (builder: PageQuery) => void): PageQuery
  modify(callback: (builder: QueryBuilder) => void): PageQuery
  where(criteria: Record<string, unknown>): PageQuery
  orderBy(column: unknown, direction?: string): PageQuery
  limit(value: number): PageQuery
  findById(id: number): Promise<PageRecord | undefined>
}
interface TagPatchQuery extends PromiseLike<number> {
  patch(data: Record<string, unknown>): Promise<number>
}
interface TagWithRelations extends TagRecord {
  $relatedQuery(relation: 'pages'): { unrelate(): Promise<number> }
}
interface RelatedTagQuery extends PromiseLike<TagRecord[]> {
  for(pageId: number): RelatedTagQuery
}
const SEARCH_MATCH_FIELDS = ['title', 'tag', 'path', 'description', 'content', 'graph', 'knowledge'] as const
type SearchMatchField = (typeof SEARCH_MATCH_FIELDS)[number]
interface SearchResult extends Record<string, unknown> {
  id: number
  sourceRevision: string
  path: string
  locale: string
  title?: unknown
  description?: unknown
  tags?: unknown
  score?: unknown
  matchedFields?: unknown
  metadataOnly?: boolean
}
interface RankedSearchResult extends SearchResult {
  tags: string[]
  score: number
  matchedFields: SearchMatchField[]
}
interface SearchResponse extends ProviderSearchResult {
  results: SearchResult[]
}
interface PrivateSearchRankRow {
  id: number
  score: number
  sourceRevision: string | number
  metadataOnly?: boolean
}
interface WikiPageOperations {
  Error: {
    PageNotFound: new () => Error
    PageHistoryForbidden: new () => Error
    PageViewForbidden: new () => Error
    PageUpdateForbidden: new () => Error
    PageRestoreForbidden: new () => Error
    PageDeleteForbidden: new () => Error
    PageMoveForbidden: new () => Error
  }
  auth: {
    checkPageAccess(user: Express.User | undefined, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
    loadPageRuleAuthority(requester: Express.User | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  config: { db: { type: string }; editors?: { available?: unknown }; lang: { code: string }; search?: { maxHits?: number } }
  data: { searchEngine?: { supportsPageFilters?: boolean; query(query: string, options: Record<string, unknown>): Promise<SearchResponse> } }
  models: {
    knex: Knex
    pages: {
      query(): PageQuery
      assertCreateAccess(input: { path: string; locale: string; visibility: PageVisibility; tags?: unknown; user: Express.User; authority: PageRuleAuthority }): string[]
      relatedQuery(relation: 'tags'): RelatedTagQuery
      getPageFromDb(input: number | { path: string; locale: string; visibility: PageVisibility; ownerId: number | null }): Promise<PageSourceRecord | undefined>
      deletePage(input: { id: number; expectedSourceRevision?: string; user?: Express.User }): unknown
      createPage(input: Record<string, unknown> & { user?: Express.User }): unknown
      updatePage(input: Record<string, unknown> & { user?: Express.User }): unknown
      convertPage(input: Record<string, unknown> & { user?: Express.User }): unknown
      movePage(input: Record<string, unknown> & { user?: Express.User }): unknown
      changeVisibility(input: {
        id: number
        visibility: PageVisibility
        confirmPublication?: boolean
        expectedSourceRevision?: string
        user?: Express.User
      }): unknown
      transferOwnership(input: { id: number; ownerId: number; expectedSourceRevision?: string; user?: Express.User }): unknown
    }
    tags: {
      query(): {
        findById(id: number): TagPatchQuery & PromiseLike<TagWithRelations | undefined>
        deleteById(id: number): Promise<number>
      }
    }
    pageHistory: {
      getHistory(input: { pageId: number; offsetPage: number; offsetSize: number; requester: Express.User | undefined }): unknown
      getVersion(input: { pageId: number; versionId: number; requester: Express.User | undefined }): Promise<PageVersionRecord | undefined>
    }
  }
}

export interface PageOperationInput extends Record<string, unknown> {
  requester?: Express.User
  authority?: PageRuleAuthority
  sessionId?: string
  readonly [OKF_PRODUCER_CONTEXT]?: string
}
type OperationInput = PageOperationInput
const authorityFor = async (input: OperationInput, transaction?: Knex.Transaction): Promise<PageRuleAuthority> => {
  if (!transaction && input.authority !== undefined && input.authority.requester === input.requester) return input.authority
  return wiki.auth.loadPageRuleAuthority(input.requester, transaction)
}
const authorityForInput = async (input: OperationInput, supplied?: PageRuleAuthority): Promise<PageRuleAuthority> =>
  supplied !== undefined && supplied.requester === input.requester ? supplied : authorityFor(input)
const assertUnlocked = (input: OperationInput, pageId: number): Promise<void> =>
  assertPageUnlocked({
    requester: input.requester,
    pageId,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : ''
  })
const wiki = WIKI as unknown as WikiPageOperations
const completePageForAuthorization = async (page: PageRecord | undefined): Promise<PageRecord | undefined> => {
  if (!page || Array.isArray(page.tags)) return page
  const hydrated = await wiki.models.pages.getPageFromDb(page.id)
  return hydrated as PageRecord | undefined
}
const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ApplicationError(`${label} must be a positive integer`, { code: 'INVALID_INPUT' })
  return value as number
}
const nonNegativeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ApplicationError(`${label} must be a non-negative integer`, { code: 'INVALID_INPUT' })
  return value as number
}
const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new ApplicationError(`${label} must be a string`, { code: 'INVALID_INPUT' })
  return value
}
const expectedSourceRevision = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  const revision = stringValue(value, 'expectedSourceRevision')
  if (!/^[1-9][0-9]*$/.test(revision)) throw new ApplicationError('expectedSourceRevision must be a canonical positive decimal', { code: 'INVALID_INPUT' })
  return revision
}
const expectedCollaborationGeneration = (value: unknown): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError('expectedCollaborationGeneration must be a positive safe integer', { code: 'INVALID_INPUT' })
  }
  return value
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const recordValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new ApplicationError(`${label} must be an object`, { code: 'INVALID_INPUT' })
  return value
}
const mutationPayload = (input: OperationInput, omitted: readonly string[] = []): Record<string, unknown> => {
  const payload = _.omit(recordValue(input.input, 'input'), [
    ...omitted,
    'okfProducer',
    'okfRestoreRevision',
    'replaceOkfMetadata',
    'user',
    'requester',
    'sessionId',
    'brandingContext',
    'brandingRequester',
    'brandingSessionId'
  ])
  const producer = input[OKF_PRODUCER_CONTEXT]
  return typeof producer === 'string' ? { ...payload, okfProducer: producer } : payload
}
const withRequester = (payload: Record<string, unknown>, requester: Express.User | undefined): Record<string, unknown> & { user?: Express.User } =>
  requester === undefined ? payload : { ...payload, user: requester }

const resolveReaderBranding = async (input: OperationInput, page: PageRecord): Promise<PageBrandingView | null> => {
  const assignment = PageBrandingAssignmentSchema.safeParse(_.isPlainObject(page.extra) ? page.extra.branding : undefined)
  if (!assignment.success) return null
  try {
    return await resolveAssetBrandingView({
      assetId: assignment.data.assetId,
      requester: input.requester,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : ''
    })
  } catch {
    return null
  }
}
const canonicalBrandingAssignmentFor = (
  requester: Express.User | undefined,
  page: Pick<PageRecord, 'path' | 'localeCode' | 'visibility' | 'ownerId' | 'tags'>,
  extra: unknown,
  authority: PageRuleAuthority
): PageBrandingAssignment | null | undefined => {
  if (!canWritePage(requester, page, authority) && !managesSystem(requester)) return undefined
  const rawBranding = isRecord(extra) ? extra.branding : undefined
  const assignment = PageBrandingAssignmentSchema.safeParse(rawBranding)
  return assignment.success ? assignment.data : null
}

const projectReaderPage = async <T extends PageRecord>(input: OperationInput, page: T): Promise<T & { branding: PageBrandingView | null }> => {
  const branding = await resolveReaderBranding(input, page)
  const extra = _.isPlainObject(page.extra) ? { ...page.extra } : {}
  delete extra.branding
  return { ...page, extra, branding }
}

const list = async (input: OperationInput) => {
  const { requester, ...rawArgs } = input
  const authority = await authorityFor(input)
  const args = {
    limit: rawArgs.limit === undefined ? undefined : positiveInteger(rawArgs.limit, 'limit'),
    offset: rawArgs.offset === undefined ? 0 : nonNegativeInteger(rawArgs.offset, 'offset'),
    locale: rawArgs.locale === undefined ? undefined : stringValue(rawArgs.locale, 'locale'),
    creatorId: rawArgs.creatorId === undefined ? undefined : positiveInteger(rawArgs.creatorId, 'creatorId'),
    authorId: rawArgs.authorId === undefined ? undefined : positiveInteger(rawArgs.authorId, 'authorId'),
    tags:
      rawArgs.tags === undefined
        ? undefined
        : Array.isArray(rawArgs.tags) && rawArgs.tags.every(tag => typeof tag === 'string')
          ? (rawArgs.tags as string[])
          : [],
    orderBy: typeof rawArgs.orderBy === 'string' ? rawArgs.orderBy : '',
    orderByDirection: typeof rawArgs.orderByDirection === 'string' ? rawArgs.orderByDirection : ''
  }
  if (args.tags?.length) {
    const aliases = authority.tagAliases
    const resolved = args.tags.map(tag => resolveTagName(aliases, tag.trim().toLowerCase()))
    if (resolved.some(tag => tag === null)) return []
    args.tags = resolved as string[]
  }
  const pages = await wiki.models.pages
    .query()
    .column([
      'pages.id',
      'path',
      { locale: 'localeCode' },
      'title',
      'description',
      'isPublished',
      'publishStartDate',
      'publishEndDate',
      'visibility',
      'ownerId',
      'contentType',
      'createdAt',
      'updatedAt'
    ])
    .withGraphFetched('tags')
    .modifyGraph('tags', builder => {
      builder.select('tag')
    })
    .modify(queryBuilder => {
      scopePageQuery(queryBuilder, requester, { table: 'pages' })
      if (args.limit) queryBuilder.limit(args.limit)
      if (args.offset > 0) queryBuilder.offset(args.offset)
      if (args.locale) queryBuilder.where('localeCode', args.locale)
      if (args.creatorId && args.authorId && args.creatorId > 0 && args.authorId > 0) {
        queryBuilder.where(builder => {
          builder.where('creatorId', args.creatorId).orWhere('authorId', args.authorId)
        })
      } else {
        if (args.creatorId && args.creatorId > 0) queryBuilder.where('creatorId', args.creatorId)
        if (args.authorId && args.authorId > 0) queryBuilder.where('authorId', args.authorId)
      }
      if (args.tags && args.tags.length > 0) {
        queryBuilder.whereExists(builder => {
          builder
            .select('pageTags.pageId')
            .from('pageTags')
            .join('tags', 'tags.id', 'pageTags.tagId')
            .whereRaw('?? = ??', ['pageTags.pageId', 'pages.id'])
            .whereIn('tags.tag', args.tags!)
        })
      }
      const orderDirection = args.orderByDirection === 'DESC' ? 'desc' : 'asc'
      const orderColumns = { CREATED: 'pages.createdAt', PATH: 'pages.path', TITLE: 'pages.title', UPDATED: 'pages.updatedAt' }
      const orderColumn = orderColumns[args.orderBy as keyof typeof orderColumns] ?? 'pages.id'
      queryBuilder.orderBy(orderColumn, orderDirection)
      if (orderColumn !== 'pages.id') queryBuilder.orderBy('pages.id', 'asc')
    })

  const accessiblePages = pages.filter(page => canReadPage(requester, page, authority)).map(page => ({ ...page, tags: page.tags.map(tag => tag.tag) }))
  if (args.tags && args.tags.length > 0) {
    return accessiblePages.filter(page => _.every(args.tags, tag => _.includes(page.tags, tag)))
  }
  return accessiblePages
}

export interface PageIndexItem {
  id: number
  title: string
  description: string | null
  path: string
  href: string
  updatedAt: string
}

const listIndex = async (input: OperationInput): Promise<PageIndexItem[]> => {
  const { requester, ...rawArgs } = input
  const authority = await authorityFor(input)
  const path = stringValue(rawArgs.path, 'path')
  const locale = stringValue(rawArgs.locale, 'locale')
  const depth = nonNegativeInteger(rawArgs.depth, 'depth')
  const limit = positiveInteger(rawArgs.limit, 'limit')
  const order = stringValue(rawArgs.order, 'order')
  if (depth > 5) throw new ApplicationError('depth must not exceed 5', { code: 'INVALID_INPUT', status: 400 })
  if (limit > 200) throw new ApplicationError('limit must not exceed 200', { code: 'INVALID_INPUT', status: 400 })
  if (!['path', 'title', 'updated'].includes(order)) throw new ApplicationError('order must be path, title, or updated', { code: 'INVALID_INPUT', status: 400 })

  const pages = await listPageIndexCandidates(wiki.models.knex, {
    locale,
    path,
    limit: PAGE_INDEX_CANDIDATE_LIMIT,
    scope: query => {
      scopePageQuery(query, requester, { table: 'pages', includeAllForSystemManager: true })
    }
  })
  if (pages.length >= PAGE_INDEX_CANDIDATE_LIMIT) {
    throw new ApplicationError('Page index path matches too many pages; choose a narrower path.', { code: 'PAGE_INDEX_TOO_BROAD', status: 422 })
  }

  const prefix = path.length > 0 ? `${path}/` : ''
  const accessible = pages
    .filter(page => page.path.startsWith(prefix))
    .filter(page => {
      const relativePath = page.path.slice(prefix.length)
      return relativePath.length > 0 && relativePath.split('/').length <= depth + 1
    })
    .filter(page => canReadPage(requester, { ...page, tags: page.tags.map(tag => tag.tag) }, authority))
  accessible.sort((left, right) => {
    if (order === 'title') return left.title.localeCompare(right.title) || left.path.localeCompare(right.path)
    if (order === 'updated') return new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf() || left.path.localeCompare(right.path)
    return left.path.localeCompare(right.path)
  })
  return accessible.slice(0, limit).map(page => ({
    id: page.id,
    title: page.title,
    description: page.description ?? null,
    path: page.path,
    href: pageRoute(page),
    updatedAt: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : String(page.updatedAt)
  }))
}

const discover = async (input: OperationInput) => {
  const { requester, ...rawArgs } = input
  const authority = await authorityFor(input)
  const locale = stringValue(rawArgs.locale, 'locale')
  const path = rawArgs.path === undefined ? '' : stringValue(rawArgs.path, 'path')
  const depth = rawArgs.depth === undefined ? 1 : nonNegativeInteger(rawArgs.depth, 'depth')
  const limit = rawArgs.limit === undefined ? 50 : positiveInteger(rawArgs.limit, 'limit')
  const offset = rawArgs.offset === undefined ? 0 : nonNegativeInteger(rawArgs.offset, 'offset')
  const order = rawArgs.order === undefined ? 'path' : stringValue(rawArgs.order, 'order')
  const tags =
    rawArgs.tags === undefined
      ? []
      : Array.isArray(rawArgs.tags) && rawArgs.tags.every(tag => typeof tag === 'string')
        ? [...new Set(rawArgs.tags.map(tag => tag.trim().toLocaleLowerCase()).filter(Boolean))]
        : null
  if (depth > 5) throw new ApplicationError('depth must not exceed 5', { code: 'INVALID_INPUT', status: 400 })
  if (limit > 100) throw new ApplicationError('limit must not exceed 100', { code: 'INVALID_INPUT', status: 400 })
  if (offset > PAGE_INDEX_CANDIDATE_LIMIT - 1)
    throw new ApplicationError(`offset must not exceed ${PAGE_INDEX_CANDIDATE_LIMIT - 1}`, { code: 'INVALID_INPUT', status: 400 })
  if (!['path', 'title', 'updated'].includes(order)) throw new ApplicationError('order must be path, title, or updated', { code: 'INVALID_INPUT', status: 400 })
  if (tags === null || tags.length > 20) throw new ApplicationError('tags must contain at most 20 strings', { code: 'INVALID_INPUT', status: 400 })

  const candidates = await listPageIndexCandidates(wiki.models.knex, {
    locale,
    path,
    limit: PAGE_INDEX_CANDIDATE_LIMIT,
    scope: query => {
      scopePageQuery(query, requester, { table: 'pages', includeAllForSystemManager: true })
    }
  })
  if (candidates.length >= PAGE_INDEX_CANDIDATE_LIMIT) {
    throw new ApplicationError('Page discovery path matches too many pages; choose a narrower path.', { code: 'PAGE_INDEX_TOO_BROAD', status: 422 })
  }
  const prefix = path.length > 0 ? `${path}/` : ''
  const pages = candidates.filter(page => {
    if (!page.path.startsWith(prefix)) return false
    const relativePath = page.path.slice(prefix.length)
    const pageTags = page.tags.map(tag => tag.tag.trim().toLocaleLowerCase())
    return (
      relativePath.length > 0 &&
      relativePath.split('/').length <= depth + 1 &&
      tags.every(tag => pageTags.includes(tag)) &&
      canReadPage(requester, { ...page, tags: pageTags }, authority)
    )
  })
  pages.sort((left, right) => {
    if (order === 'title') return left.title.localeCompare(right.title) || left.path.localeCompare(right.path) || left.id - right.id
    if (order === 'updated')
      return new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf() || left.path.localeCompare(right.path) || left.id - right.id
    return left.path.localeCompare(right.path) || left.id - right.id
  })
  const selected = pages.slice(offset, offset + limit)
  return {
    pages: selected.map(page => ({
      id: page.id,
      locale: page.localeCode,
      path: page.path,
      title: page.title,
      description: page.description,
      updatedAt: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : String(page.updatedAt),
      tags: page.tags.map(tag => tag.tag)
    })),
    totalInWindow: pages.length,
    windowLimit: PAGE_INDEX_CANDIDATE_LIMIT - 1,
    nextOffset: offset + selected.length < pages.length ? offset + selected.length : null
  }
}

const listTags = async (requester?: Express.User, suppliedAuthority?: PageRuleAuthority) => {
  const authorityInput: OperationInput = {
    ...(requester === undefined ? {} : { requester }),
    ...(suppliedAuthority === undefined ? {} : { authority: suppliedAuthority })
  }
  const authority = await authorityFor(authorityInput)
  const pages = await wiki.models.pages
    .query()
    .column(['path', { locale: 'localeCode' }, 'visibility', 'ownerId'])
    .modify(queryBuilder => {
      scopePageQuery(queryBuilder, requester, { table: 'pages' })
    })
    .withGraphJoined('tags')
  const tags = pages.filter(page => canReadPage(requester, page, authority)).flatMap(page => page.tags)
  return _.orderBy(_.uniqBy(tags, 'id'), ['tag'], ['asc'])
}

const listRecent = async (requester?: Express.User, suppliedAuthority?: PageRuleAuthority) => {
  const authorityInput: OperationInput = {
    ...(requester === undefined ? {} : { requester }),
    ...(suppliedAuthority === undefined ? {} : { authority: suppliedAuthority })
  }
  const authority = await authorityFor(authorityInput)
  const pages = await wiki.models.pages
    .query()
    .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt', 'visibility', 'ownerId'])
    .modify(queryBuilder => {
      scopePageQuery(queryBuilder, requester, { table: 'pages' })
    })
    .withGraphFetched('tags')
    .modifyGraph('tags', builder => {
      builder.select('tag')
    })
    .orderBy('pages.updatedAt', 'desc')
    .orderBy('pages.id', 'asc')
    .limit(10)
  return pages.filter(page => canReadPage(requester, page, authority)).map(page => _.pick(page, ['id', 'locale', 'path', 'title', 'updatedAt', 'visibility']))
}

const searchTags = async (input: OperationInput) => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const normalizedQuery = _.trim(stringValue(input.query, 'query')).toLowerCase()
  const limit = input.limit === undefined ? 5 : positiveInteger(input.limit, 'limit')
  if (!normalizedQuery) throw new ApplicationError('query must not be empty', { code: 'INVALID_INPUT', status: 400 })
  if (limit > 20) throw new ApplicationError('limit must not exceed 20', { code: 'INVALID_INPUT', status: 400 })
  const pages = await wiki.models.pages
    .query()
    .column(['path', { locale: 'localeCode' }, 'visibility', 'ownerId'])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => {
      builder.select('tag')
    })
    .modify(queryBuilder => {
      scopePageQuery(queryBuilder, requester, { table: 'pages' })
      queryBuilder.whereExists(builder => {
        builder
          .select('pageTags.pageId')
          .from('pageTags')
          .join('tags', 'tags.id', 'pageTags.tagId')
          .whereRaw('?? = ??', ['pageTags.pageId', 'pages.id'])
          .whereRaw('LOWER(??) LIKE ?', ['tags.tag', `%${normalizedQuery}%`])
      })
    })
  return _.uniq(
    pages
      .filter(page => canReadPage(requester, page, authority))
      .flatMap(page => page.tags)
      .map(tag => tag.tag)
      .filter(tag => tag.toLowerCase().includes(normalizedQuery))
  )
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit)
}

const authorizedPageSource = async (input: OperationInput, suppliedAuthority?: PageRuleAuthority): Promise<PageSourceRecord> => {
  const requester = input.requester
  const authority = await authorityForInput(input, suppliedAuthority)
  const page = await wiki.models.pages.getPageFromDb(positiveInteger(input.id, 'id'))
  if (!page || !canAccessCurrentPageSource(requester, page, authority)) {
    throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  }
  await assertUnlocked(input, page.id)
  return page
}

const get = async (input: OperationInput, suppliedAuthority?: PageRuleAuthority): Promise<PageDetail> => {
  const authority = await authorityForInput(input, suppliedAuthority)
  const source = await authorizedPageSource(input, authority)
  const page = await projectReaderPage(input, source)
  const brandingAssignment = canonicalBrandingAssignmentFor(input.requester, source, source.extra, authority)
  return {
    ...page,
    ...(brandingAssignment === undefined ? {} : { brandingAssignment }),
    locale: page.localeCode,
    editor: page.editorKey,
    scriptJs: _.get(page, 'extra.js'),
    scriptCss: _.get(page, 'extra.css')
  }
}

const publicationWindowOpen = (page: Record<string, unknown>, now = Date.now()): boolean => {
  const start = page.publishStartDate
  const end = page.publishEndDate
  return (!start || new Date(String(start)).valueOf() <= now) && (!end || new Date(String(end)).valueOf() >= now)
}
const canAccessCurrentPageSource = (requester: Express.User | undefined, page: PageRecord, authority: PageRuleAuthority): boolean =>
  page.visibility !== 'public' || (page.isPublished && publicationWindowOpen(page)) ? canReadPage(requester, page, authority) : canWritePage(requester, page, authority)

const preview = async (input: OperationInput): Promise<WikiSource> => {
  // Both readers enforce current ownership, page rules, publication, and password unlock.
  const authority = await authorityFor(input)
  const page = input.id === undefined ? await getByPath(input, authority) : await get(input, authority)
  if (page.visibility === 'public' && (!page.isPublished || !publicationWindowOpen(page)) && !canWritePage(input.requester, page, authority))
    throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  const render = Reflect.get(page, 'render')
  const rendered = typeof render === 'string' ? render : ''
  const query = typeof input.query === 'string' ? input.query.slice(0, 256) : ''
  return {
    id: page.id,
    locale: page.localeCode,
    path: page.path,
    title: page.title,
    description: page.description ?? '',
    visibility: page.visibility,
    updatedAt: new Date(page.updatedAt).toISOString(),
    sourceRevision: String(Reflect.get(page, 'sourceRevision')),
    ...searchExcerpt(rendered, query)
  }
}
const getSource = async (
  input: OperationInput,
  suppliedAuthority?: PageRuleAuthority
): Promise<{
  content: string
  description: string | null
  editor: string
  title: string
  brandingAssignment?: PageBrandingAssignment | null
}> => {
  const authority = await authorityForInput(input, suppliedAuthority)
  const page = await authorizedPageSource(input, authority)
  const brandingAssignment = canonicalBrandingAssignmentFor(input.requester, page, page.extra, authority)
  return {
    content: page.content,
    description: typeof page.description === 'string' ? page.description : null,
    editor: page.editorKey,
    title: page.title,
    ...(brandingAssignment === undefined ? {} : { brandingAssignment })
  }
}
const graphEligiblePages = async (
  requester: Express.User | undefined,
  suppliedAuthority?: PageRuleAuthority
): Promise<Map<number, PageRecord>> => {
  const authorityInput: OperationInput = {
    ...(requester === undefined ? {} : { requester }),
    ...(suppliedAuthority === undefined ? {} : { authority: suppliedAuthority })
  }
  const authority = await authorityForInput(authorityInput, suppliedAuthority)
  const [pages, protectedIds] = await Promise.all([
    wiki.models.pages
      .query()
      .column([
        'pages.id',
        'pages.path',
        'pages.localeCode',
        'pages.title',
        'pages.description',
        'pages.visibility',
        'pages.ownerId',
        'pages.isPublished',
        'pages.publishStartDate',
        'pages.publishEndDate',
        'pages.contentType',
        'pages.sourceRevision',
        'pages.updatedAt'
      ])
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => {
        builder.select('tag')
      })
      .modify(builder => {
        builder.where({ 'pages.visibility': 'public', 'pages.isPublished': true })
      }),
    protectedPageIds()
  ])
  return new Map<number, PageRecord>(
    pages.filter(page => publicationWindowOpen(page) && canReadPage(requester, page, authority) && !protectedIds.has(page.id)).map(page => [page.id, page] as const)
  )
}

const currentLinkReceiptKey = (pageId: number, sourceRevision: string): string => `${pageId}:${sourceRevision}`

const succeededLinkReceiptKeys = async (): Promise<Set<string>> => {
  const rows = (await wiki.models
    .knex('pageMutationOutbox')
    .where({ effectKind: 'links', desiredState: 'present', status: 'succeeded' })
    .select('pageId', 'sourceRevision')) as PageMutationReceiptRow[]
  return new Set(
    rows.flatMap(row => {
      const pageId = Number(row.pageId)
      const sourceRevision = currentSourceRevision(row.sourceRevision)
      return Number.isSafeInteger(pageId) && pageId > 0 && sourceRevision !== undefined ? [currentLinkReceiptKey(pageId, sourceRevision)] : []
    })
  )
}

const graphPageSnapshotMatches = (rawId: unknown, rawRevision: unknown, rawPath: unknown, rawLocale: unknown, page: PageRecord): boolean => {
  const revision = currentSourceRevision(rawRevision)
  const authorizedRevision = currentSourceRevision(page.sourceRevision)
  return (
    Number(rawId) === page.id &&
    revision !== undefined &&
    authorizedRevision !== undefined &&
    revision === authorizedRevision &&
    rawPath === page.path &&
    rawLocale === page.localeCode
  )
}

const listLinks = async (input: OperationInput) => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const locale = stringValue(input.locale, 'locale')
  const pagesById = await graphEligiblePages(requester, authority)
  // Do not list an edge if either endpoint became protected after the metadata snapshot.
  for (const protectedId of await protectedPageIds()) pagesById.delete(protectedId)
  const pagesByRoute = new Map<string, PageRecord>([...pagesById.values()].map(page => [`${page.localeCode}/${page.path}`, page] as const))
  const columns = [
    { id: 'pages.id' },
    { title: 'pages.title' },
    { path: 'pages.path' },
    { sourceRevision: 'pages.sourceRevision' },
    { sourceLocale: 'pages.localeCode' },
    { link: 'pageLinks.path' },
    { locale: 'pageLinks.localeCode' },
    { targetId: 'target.id' },
    { targetRevision: 'target.sourceRevision' },
    { targetPath: 'target.path' },
    { targetLocale: 'target.localeCode' }
  ]
  const [rows, receiptKeys] = await Promise.all([
    wiki.models
      .knex('pages')
      .column(...columns)
      .fullOuterJoin('pageLinks', 'pages.id', 'pageLinks.pageId')
      .leftJoin('pages as target', function () {
        this.on('target.localeCode', '=', 'pageLinks.localeCode').andOn('target.path', '=', 'pageLinks.path')
      })
      .where({ 'pages.localeCode': locale, 'pages.visibility': 'public', 'pages.isPublished': true }),
    succeededLinkReceiptKeys()
  ])

  return _.reduce<LinkRow, LinkResult[]>(
    rows as LinkRow[],
    (result, value) => {
      const source = pagesById.get(Number(value.id))
      if (!source || !graphPageSnapshotMatches(value.id, value.sourceRevision, value.path, value.sourceLocale, source)) return result
      const target = typeof value.link === 'string' && typeof value.locale === 'string' ? pagesByRoute.get(`${value.locale}/${value.link}`) : undefined
      const sourceRevision = currentSourceRevision(value.sourceRevision)
      const targetId = Number(value.targetId)
      const edgeAllowed =
        sourceRevision !== undefined &&
        receiptKeys.has(currentLinkReceiptKey(source.id, sourceRevision)) &&
        target !== undefined &&
        graphPageSnapshotMatches(value.targetId, value.targetRevision, value.targetPath, value.targetLocale, target) &&
        targetId === target.id &&
        value.locale === target.localeCode &&
        value.link === target.path
      const existing = _.find(result, ['id', source.id])
      if (existing) {
        if (edgeAllowed) existing.links.push(`${target.localeCode}/${target.path}`)
      } else {
        result.push({
          id: source.id,
          title: source.title,
          path: `${source.localeCode}/${source.path}`,
          links: edgeAllowed ? [`${target.localeCode}/${target.path}`] : []
        })
      }
      return result
    },
    []
  )
}
const relatedPageOrder = (left: PageRecord, right: PageRecord): number =>
  left.title.localeCompare(right.title) || left.path.localeCompare(right.path) || left.id - right.id

const listRelated = async (input: OperationInput): Promise<RelatedPagesResult> => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const pageId = positiveInteger(input.pageId, 'pageId')
  const limit = input.limit === undefined ? 20 : positiveInteger(input.limit, 'limit')
  const offset = input.offset === undefined ? 0 : nonNegativeInteger(input.offset, 'offset')
  const maxDepth = input.maxDepth === undefined ? undefined : positiveInteger(input.maxDepth, 'maxDepth')
  if (limit > 100) throw new ApplicationError('limit must not exceed 100', { code: 'INVALID_INPUT', status: 400 })
  if (!Number.isSafeInteger(offset + limit))
    throw new ApplicationError('offset and limit exceed the safe traversal range', { code: 'INVALID_INPUT', status: 400 })
  if (maxDepth !== undefined && maxDepth > 32) throw new ApplicationError('maxDepth must not exceed 32', { code: 'INVALID_INPUT', status: 400 })

  const source = await get({ ...input, id: pageId }, authority)
  if (source.visibility !== 'public' || source.isPublished === false) return { pages: [], truncated: false, nextOffset: null }

  const pagesById = await graphEligiblePages(requester, authority)
  if (!pagesById.has(pageId)) return { pages: [], truncated: false, nextOffset: null }

  // Exclude pages protected after the metadata snapshot before their edges can enter the traversal.
  for (const protectedId of await protectedPageIds()) pagesById.delete(protectedId)
  if (!pagesById.has(pageId)) return { pages: [], truncated: false, nextOffset: null }

  const rawEdges = (await wiki.models
    .knex('pageLinks as links')
    .join('pages as source', 'source.id', 'links.pageId')
    .join('pages as target', function () {
      this.on('target.localeCode', '=', 'links.localeCode').andOn('target.path', '=', 'links.path')
    })
    .where({
      'source.visibility': 'public',
      'source.isPublished': true,
      'target.visibility': 'public',
      'target.isPublished': true
    })
    .select({
      sourceId: 'source.id',
      sourceRevision: 'source.sourceRevision',
      sourcePath: 'source.path',
      sourceLocale: 'source.localeCode',
      targetId: 'target.id',
      targetRevision: 'target.sourceRevision',
      targetPath: 'target.path',
      targetLocale: 'target.localeCode'
    })) as PageGraphEdgeRow[]
  const receiptKeys = await succeededLinkReceiptKeys()

  const adjacency = new Map<number, Map<number, number>>()
  const connect = (from: number, to: number, direction: number): void => {
    if (from === to || !pagesById.has(from) || !pagesById.has(to)) return
    const neighbors = adjacency.get(from) ?? new Map<number, number>()
    neighbors.set(to, (neighbors.get(to) ?? 0) | direction)
    adjacency.set(from, neighbors)
  }
  for (const edge of rawEdges) {
    const sourceId = Number(edge.sourceId)
    const targetId = Number(edge.targetId)
    const sourcePage = pagesById.get(sourceId)
    const targetPage = pagesById.get(targetId)
    const sourceRevision = currentSourceRevision(edge.sourceRevision)
    if (
      sourcePage === undefined ||
      targetPage === undefined ||
      sourceRevision === undefined ||
      !receiptKeys.has(currentLinkReceiptKey(sourceId, sourceRevision)) ||
      !graphPageSnapshotMatches(edge.sourceId, edge.sourceRevision, edge.sourcePath, edge.sourceLocale, sourcePage) ||
      !graphPageSnapshotMatches(edge.targetId, edge.targetRevision, edge.targetPath, edge.targetLocale, targetPage)
    ) {
      continue
    }
    connect(sourceId, targetId, 1)
    connect(targetId, sourceId, 2)
  }

  const discovered: RelatedPageRecord[] = []
  const seen = new Set<number>([pageId])
  let frontier = [pageId]
  let depth = 0
  const requestedEnd = offset + limit
  while (frontier.length > 0 && discovered.length <= requestedEnd && (maxDepth === undefined || depth < maxDepth)) {
    depth++
    const candidates = new Map<number, { direction: number; viaPageId: number }>()
    for (const from of frontier) {
      for (const [to, direction] of adjacency.get(from) ?? []) {
        if (!seen.has(to) && !candidates.has(to)) candidates.set(to, { direction, viaPageId: from })
      }
    }
    const ordered = [...candidates.entries()]
      .map(([id, connection]) => ({ page: pagesById.get(id), connection }))
      .filter((entry): entry is { page: PageRecord; connection: { direction: number; viaPageId: number } } => entry.page !== undefined)
      .sort((left, right) => relatedPageOrder(left.page, right.page))
    frontier = []
    for (const { page, connection } of ordered) {
      seen.add(page.id)
      frontier.push(page.id)
      discovered.push({
        ...page,
        locale: page.localeCode,
        tags: page.tags,
        distance: depth,
        direction: connection.direction === 3 ? 'bidirectional' : connection.direction === 1 ? 'outgoing' : 'incoming',
        viaPageId: connection.viaPageId
      })
    }
  }

  const selected = discovered.slice(offset, requestedEnd)
  const truncated = discovered.length > requestedEnd
  return {
    pages: selected,
    truncated,
    nextOffset: truncated ? offset + selected.length : null
  }
}

const remove = async (input: OperationInput): Promise<unknown> => {
  const id = positiveInteger(input.id, 'id')
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  const payload = expected === undefined ? { id } : { id, expectedSourceRevision: expected }
  await assertUnlocked(input, id)
  return input.requester === undefined ? wiki.models.pages.deletePage(payload) : wiki.models.pages.deletePage({ ...payload, user: input.requester })
}

const updateTag = async (input: OperationInput): Promise<void> => {
  await taxonomy().legacyChange(
    { requester: input.requester, sessionId: input.sessionId ?? '' },
    {
      action: 'edit',
      tagId: positiveInteger(input.id, 'id'),
      tag: stringValue(input.tag, 'tag'),
      title: stringValue(input.title, 'title')
    }
  )
}

const removeTag = async (value: unknown, context: OperationInput = {}): Promise<void> => {
  await taxonomy().legacyChange(
    { requester: context.requester, sessionId: context.sessionId ?? '' },
    { action: 'archive', tagId: positiveInteger(value, 'id') }
  )
}

const getHistory = async (input: OperationInput) => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const id = positiveInteger(input.id, 'id')
  const offsetPage = input.offsetPage === undefined ? 0 : nonNegativeInteger(input.offsetPage, 'offsetPage')
  const offsetSize = input.offsetSize === undefined ? 100 : positiveInteger(input.offsetSize, 'offsetSize')
  const page = await completePageForAuthorization(
    await wiki.models.pages.query().select('path', 'localeCode', 'visibility', 'ownerId').findById(id)
  )
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page, authority))) throw new wiki.Error.PageNotFound()
  await assertUnlocked(input, id)
  if (
    page.visibility === 'public' &&
    !wiki.auth.checkPageAccess(requester, ['read:history'], {
      path: page.path,
      locale: page.localeCode,
      tags: page.tags
    }, authority)
  ) {
    throw new wiki.Error.PageHistoryForbidden()
  }
  return wiki.models.pageHistory.getHistory({ pageId: id, offsetPage, offsetSize, requester })
}

const getVersion = async (input: OperationInput): Promise<PageVersionProjection | undefined> => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const pageId = positiveInteger(input.pageId, 'pageId')
  const versionId = positiveInteger(input.versionId, 'versionId')
  const page = await wiki.models.pages
    .query()
    .select('path', 'localeCode', 'visibility', 'ownerId')
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => {
      builder.select('tag')
    })
    .findById(pageId)
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page, authority))) throw new wiki.Error.PageNotFound()
  await assertUnlocked(input, pageId)
  if (
    page.visibility === 'public' &&
    !wiki.auth.checkPageAccess(requester, ['read:history'], {
      path: page.path,
      locale: page.localeCode,
      tags: page.tags
    }, authority)
  ) {
    throw new wiki.Error.PageHistoryForbidden()
  }
  const version = await wiki.models.pageHistory.getVersion({ pageId, versionId, requester })
  if (!version) return version
  const extra = isRecord(version.extra) ? { ...version.extra } : {}
  const assignment = PageBrandingAssignmentSchema.safeParse(extra.branding)
  const brandingAssignment = canonicalBrandingAssignmentFor(requester, page, extra, authority)
  let branding: PageBrandingView | null = null
  if (assignment.success) {
    try {
      branding = await resolveAssetBrandingView({
        assetId: assignment.data.assetId,
        requester,
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : ''
      })
    } catch {
      branding = null
    }
  }
  delete extra.branding
  return {
    ...version,
    extra,
    branding,
    ...(brandingAssignment === undefined ? {} : { brandingAssignment })
  }
}

const resultTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const tags = value
    .flatMap(item => {
      if (typeof item === 'string') return [item]
      if (item && typeof item === 'object' && typeof Reflect.get(item, 'tag') === 'string') return [Reflect.get(item, 'tag') as string]
      return []
    })
    .map(tag => tag.trim().toLocaleLowerCase())
    .filter(Boolean)
  return [...new Set(tags)].sort().slice(0, 50)
}

const currentSourceRevision = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value
  return undefined
}

const rankedSearchResult = (result: SearchResult, query: string): RankedSearchResult => {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const tags = resultTags(result.tags)
  const title = typeof result.title === 'string' ? result.title.toLocaleLowerCase() : ''
  const description = typeof result.description === 'string' ? result.description.toLocaleLowerCase() : ''
  const path = result.path.toLocaleLowerCase()
  const reportedFields = Array.isArray(result.matchedFields)
    ? result.matchedFields.filter((field): field is SearchMatchField => typeof field === 'string' && SEARCH_MATCH_FIELDS.includes(field as SearchMatchField))
    : []
  const derivedFields: SearchMatchField[] = []
  const structuredQuery = isStructuredSearchQuery(query)
  if (!structuredQuery) {
    if (title.includes(normalizedQuery)) derivedFields.push('title')
    if (tags.some(tag => tag.includes(normalizedQuery))) derivedFields.push('tag')
    if (path.includes(normalizedQuery)) derivedFields.push('path')
    if (description.includes(normalizedQuery)) derivedFields.push('description')
  }
  if (derivedFields.length === 0 && !result.metadataOnly && !structuredQuery) derivedFields.push('content')
  const matchedFields = [...new Set(reportedFields.length > 0 ? reportedFields : derivedFields)]
  const exactTitle = title === normalizedQuery
  const exactTag = tags.includes(normalizedQuery)
  const derivedScore =
    (exactTitle ? 10 : title.includes(normalizedQuery) ? 4 : 0) +
    (exactTag ? 7 : tags.some(tag => tag.includes(normalizedQuery)) ? 2 : 0) +
    (path.includes(normalizedQuery) ? 3 : 0) +
    (description.includes(normalizedQuery) ? 1.5 : 0) +
    (matchedFields.includes('content') ? 1 : 0)
  const { metadataOnly: _metadataOnly, ...summary } = result
  return {
    ...summary,
    tags,
    score: typeof result.score === 'number' && Number.isFinite(result.score) ? Math.max(0, result.score) : derivedScore,
    matchedFields
  }
}
const escapeLikePattern = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

const privateSearchFilters = ({
  locale,
  path,
  ownerId,
  pageIds
}: {
  locale?: string
  path?: string
  ownerId?: number
  pageIds?: readonly number[]
}): { filters: string[]; bindings: Knex.RawBinding[] } => {
  const filters = ["page.visibility = 'private'"]
  const bindings: Knex.RawBinding[] = []
  if (ownerId !== undefined) {
    filters.push('page."ownerId" = ?')
    bindings.push(ownerId)
  }
  if (locale !== undefined) {
    filters.push('page."localeCode" = ?')
    bindings.push(locale)
  }
  if (path !== undefined) {
    filters.push(`(page.path = ? OR page.path LIKE ? ESCAPE '\\')`)
    bindings.push(path, `${escapeLikePattern(path)}/%`)
  }
  if (pageIds !== undefined) {
    filters.push('page.id = ANY(?::int[])')
    bindings.push([...pageIds])
  }
  return { filters, bindings }
}

const structuredPrivateSearch = async (
  query: string,
  filters: readonly string[],
  bindings: readonly Knex.RawBinding[],
  limit: number
): Promise<PrivateSearchRankRow[]> => {
  const ranked = await wiki.models.knex.raw<{ rows: PrivateSearchRankRow[] }>(
    `
      WITH query_input AS (
        SELECT websearch_to_tsquery('simple', ?::text) AS query
      ), matched AS MATERIALIZED (
        SELECT
          page.id,
          page."sourceRevision" AS "sourceRevision",
          lower(page.title) AS title_order,
          lower(page.path) AS path_order,
          EXISTS (SELECT 1 FROM "pageAccessPasswords" protection WHERE protection."pageId" = page.id) AS is_protected,
          to_tsvector(
            'simple',
            concat_ws(' ', page.title, page.path, coalesce(page.description, ''), coalesce(tag_matches.tag_text, ''))
          ) AS metadata_tokens,
          to_tsvector('simple', coalesce(page.content, '')) AS content_tokens
        FROM pages page
        LEFT JOIN LATERAL (
          SELECT string_agg(tag.tag, ' ') AS tag_text
          FROM "pageTags" page_tag
          JOIN tags tag ON tag.id = page_tag."tagId"
          WHERE page_tag."pageId" = page.id
        ) tag_matches ON true
        WHERE ${filters.join('\n          AND ')}
      ), ranked AS (
        SELECT
          matched.id,
          matched."sourceRevision",
          matched.is_protected,
          matched.title_order,
          matched.path_order,
          CASE
            WHEN matched.is_protected THEN ts_rank_cd(matched.metadata_tokens, input.query, 32)
            ELSE ts_rank_cd(matched.metadata_tokens || matched.content_tokens, input.query, 32)
          END AS score
        FROM matched
        CROSS JOIN query_input input
        WHERE
          (matched.is_protected AND matched.metadata_tokens @@ input.query) OR
          (NOT matched.is_protected AND (matched.metadata_tokens || matched.content_tokens) @@ input.query)
      )
      SELECT id, score, "sourceRevision", is_protected AS "metadataOnly"
      FROM ranked
      ORDER BY score DESC, title_order, path_order, id
      LIMIT ?
    `,
    [query, ...bindings, limit]
  )
  return ranked.rows
}

const searchPrivatePages = async ({
  query,
  locale,
  path,
  ownerId,
  pageIds: selectedPageIds,
  limit = PRIVATE_SEARCH_WINDOW_LIMIT
}: {
  query: string
  locale?: string
  path?: string
  ownerId?: number
  pageIds?: readonly number[]
  limit?: number
}): Promise<PageRecord[]> => {
  const { filters, bindings: scopeBindings } = privateSearchFilters({
    ...(locale === undefined ? {} : { locale }),
    ...(path === undefined ? {} : { path }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(selectedPageIds === undefined ? {} : { pageIds: selectedPageIds })
  })
  const boundedLimit = Math.min(PRIVATE_SEARCH_WINDOW_LIMIT, Math.max(1, limit))
  const rows = isStructuredSearchQuery(query)
    ? await structuredPrivateSearch(query, filters, scopeBindings, boundedLimit)
    : (
        await wiki.models.knex.raw<{ rows: PrivateSearchRankRow[] }>(
          `
            WITH query_input AS (
              SELECT
                ?::text AS exact_query,
                ?::text AS prefix_query,
                ?::text AS contains_query
            ), matched AS MATERIALIZED (
              SELECT
                page.id,
                page."sourceRevision" AS "sourceRevision",
                lower(page.title) AS title_order,
                lower(page.path) AS path_order,
                page.title ILIKE input.exact_query ESCAPE '\\' AS title_exact,
                page.title ILIKE input.prefix_query ESCAPE '\\' AS title_prefix,
                page.title ILIKE input.contains_query ESCAPE '\\' AS title_contains,
                page.path ILIKE input.exact_query ESCAPE '\\' AS path_exact,
                page.path ILIKE input.prefix_query ESCAPE '\\' AS path_prefix,
                page.path ILIKE input.contains_query ESCAPE '\\' AS path_contains,
                page.description ILIKE input.exact_query ESCAPE '\\' AS description_exact,
                page.description ILIKE input.prefix_query ESCAPE '\\' AS description_prefix,
                page.description ILIKE input.contains_query ESCAPE '\\' AS description_contains,
                (page.content ILIKE input.contains_query ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM "pageAccessPasswords" protection WHERE protection."pageId" = page.id)) AS content_contains,
                EXISTS (SELECT 1 FROM "pageAccessPasswords" protection WHERE protection."pageId" = page.id) AS is_protected,
                coalesce(tag_matches.exact_match, false) AS tag_exact,
                coalesce(tag_matches.prefix_match, false) AS tag_prefix,
                coalesce(tag_matches.contains_match, false) AS tag_contains
              FROM pages page
              CROSS JOIN query_input input
              LEFT JOIN LATERAL (
                SELECT
                  bool_or(tag.tag ILIKE input.exact_query ESCAPE '\\') AS exact_match,
                  bool_or(tag.tag ILIKE input.prefix_query ESCAPE '\\') AS prefix_match,
                  bool_or(tag.tag ILIKE input.contains_query ESCAPE '\\') AS contains_match
                FROM "pageTags" page_tag
                JOIN tags tag ON tag.id = page_tag."tagId"
                WHERE page_tag."pageId" = page.id
              ) tag_matches ON true
              WHERE ${filters.join('\n                AND ')}
            ), ranked AS (
              SELECT
                matched.id,
                matched."sourceRevision",
                matched.is_protected,
                matched.title_order,
                matched.path_order,
                (
                  CASE WHEN matched.title_exact THEN 10.0 WHEN matched.title_prefix THEN 6.0 WHEN matched.title_contains THEN 4.0 ELSE 0.0 END +
                  CASE WHEN matched.tag_exact THEN 7.0 WHEN matched.tag_prefix THEN 3.0 WHEN matched.tag_contains THEN 2.0 ELSE 0.0 END +
                  CASE WHEN matched.path_exact THEN 6.0 WHEN matched.path_prefix THEN 4.0 WHEN matched.path_contains THEN 3.0 ELSE 0.0 END +
                  CASE
                    WHEN matched.description_exact THEN 3.0
                    WHEN matched.description_prefix THEN 2.0
                    WHEN matched.description_contains THEN 1.5
                    ELSE 0.0
                  END +
                  CASE
                    WHEN matched.content_contains AND NOT (
                      matched.title_contains OR matched.tag_contains OR matched.path_contains OR matched.description_contains
                    ) THEN 1.0
                    ELSE 0.0
                  END
                )::double precision AS score
              FROM matched
              WHERE
                matched.title_contains OR
                matched.tag_contains OR
                matched.path_contains OR
                matched.description_contains OR
                matched.content_contains
            )
            SELECT id, score, "sourceRevision", is_protected AS "metadataOnly"
            FROM ranked
            ORDER BY score DESC, title_order, path_order, id
            LIMIT ?
          `,
          [escapeLikePattern(query), `${escapeLikePattern(query)}%`, `%${escapeLikePattern(query)}%`, ...scopeBindings, boundedLimit]
        )
      ).rows
  const rankById = new Map(rows.map(row => [row.id, row]))
  const pageIds = [...rankById.keys()]
  if (pageIds.length === 0) return []
  const hydratedPages = await wiki.models.pages
    .query()
    .column(['pages.id', 'pages.sourceRevision', 'path', { locale: 'localeCode' }, 'title', 'description', 'visibility', 'ownerId'])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => {
      builder.select('tag')
    })
    .modify(builder => {
      builder.whereIn('pages.id', pageIds)
      builder.andWhere('pages.visibility', 'private')
      if (ownerId !== undefined) builder.andWhere('pages.ownerId', ownerId)
      if (locale !== undefined) builder.andWhere('pages.localeCode', locale)
      if (path !== undefined) {
        builder.andWhere(pathScope => {
          pathScope.where('pages.path', path).orWhere('pages.path', 'LIKE', `${escapeLikePattern(path)}/%`)
        })
      }
    })
  const pagesById = new Map(hydratedPages.map(page => [page.id, page]))
  return pageIds.flatMap(id => {
    const page = pagesById.get(id)
    const rank = rankById.get(id)
    if (!page || !rank) return []
    const rankedRevision = currentSourceRevision(rank.sourceRevision)
    const hydratedRevision = currentSourceRevision(page.sourceRevision)
    if (rankedRevision === undefined || hydratedRevision === undefined || rankedRevision !== hydratedRevision) return []
    return [
      {
        ...page,
        sourceRevision: hydratedRevision,
        ...(rank.metadataOnly ? { metadataOnly: true } : {}),
        score: rank.score
      }
    ]
  })
}

const protectedPageIds = async (): Promise<Set<number>> =>
  new Set((await wiki.models.knex('pageAccessPasswords')).map(row => Reflect.get(row, 'pageId')).filter((id): id is number => typeof id === 'number'))

const matchingProtectedMetadataIds = async (query: string, pageIds: readonly number[]): Promise<Set<number>> => {
  if (pageIds.length === 0) return new Set()
  const matched = await wiki.models.knex.raw<{ rows: Array<{ id: number }> }>(
    `
      WITH query_input AS (
        SELECT websearch_to_tsquery('simple', ?::text) AS query
      ), metadata AS MATERIALIZED (
        SELECT
          page.id,
          to_tsvector(
            'simple',
            concat_ws(' ', page.title, page.path, coalesce(page.description, ''), coalesce(string_agg(tag.tag, ' '), ''))
          ) AS tokens
        FROM pages page
        LEFT JOIN "pageTags" page_tag ON page_tag."pageId" = page.id
        LEFT JOIN tags tag ON tag.id = page_tag."tagId"
        WHERE page.id = ANY(?::int[])
        GROUP BY page.id, page.title, page.path, page.description
      )
      SELECT metadata.id
      FROM metadata
      CROSS JOIN query_input
      WHERE metadata.tokens @@ query_input.query
    `,
    [query, [...pageIds]]
  )
  return new Set(matched.rows.map(row => row.id))
}

const knowledgeFilter = (value: unknown): KnowledgeDiscoveryFilter | undefined => {
  if (value === undefined) return undefined
  const filter = recordValue(value, 'knowledge')
  const state = filter.state
  const lifecycleStatus = filter.lifecycleStatus
  const trustTier = filter.trustTier
  const stale = filter.stale
  const conceptType = filter.conceptType
  if (state !== undefined && state !== 'complete' && state !== 'partial') throw new ApplicationError('Invalid knowledge state', { code: 'INVALID_INPUT' })
  if (lifecycleStatus !== undefined && lifecycleStatus !== 'draft' && lifecycleStatus !== 'stable' && lifecycleStatus !== 'deprecated') {
    throw new ApplicationError('Invalid knowledge lifecycle status', { code: 'INVALID_INPUT' })
  }
  if (trustTier !== undefined && trustTier !== 'unverified' && trustTier !== 'machine-confirmed' && trustTier !== 'human-reviewed') {
    throw new ApplicationError('Invalid knowledge trust tier', { code: 'INVALID_INPUT' })
  }
  if (stale !== undefined && typeof stale !== 'boolean') throw new ApplicationError('knowledge.stale must be a boolean', { code: 'INVALID_INPUT' })
  if (conceptType !== undefined && typeof conceptType !== 'string')
    throw new ApplicationError('knowledge.conceptType must be a string', { code: 'INVALID_INPUT' })
  return {
    ...(state === undefined ? {} : { state }),
    ...(lifecycleStatus === undefined ? {} : { lifecycleStatus }),
    ...(trustTier === undefined ? {} : { trustTier }),
    ...(stale === undefined ? {} : { stale }),
    ...(conceptType === undefined ? {} : { conceptType })
  }
}

const matchesKnowledgeFilter = (knowledge: KnowledgeProjectionView, filter: KnowledgeDiscoveryFilter): boolean =>
  (filter.state === undefined || knowledge.state === filter.state) &&
  (filter.lifecycleStatus === undefined || knowledge.lifecycle.status === filter.lifecycleStatus) &&
  (filter.trustTier === undefined || knowledge.lifecycle.trustTier === filter.trustTier) &&
  (filter.stale === undefined || knowledge.lifecycle.stale === filter.stale) &&
  (filter.conceptType === undefined || knowledge.conceptType?.toLocaleLowerCase() === filter.conceptType.toLocaleLowerCase())

const search = async (input: OperationInput) => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const query = stringValue(input.query, 'query')
  const locale = input.locale === undefined ? undefined : stringValue(input.locale, 'locale')
  const path = input.path === undefined ? undefined : stringValue(input.path, 'path')
  const requestedLimit = input.limit === undefined ? undefined : Math.min(1001, positiveInteger(input.limit, 'limit'))
  const selectedPageIds =
    input.pageIds === undefined
      ? undefined
      : Array.isArray(input.pageIds) && input.pageIds.length <= 8
        ? input.pageIds.map(id => positiveInteger(id, 'pageId'))
        : (() => {
            throw new ApplicationError('Invalid selected pages', { code: 'INVALID_INPUT' })
          })()
  const filter = knowledgeFilter(input.knowledge)
  const privateOwnerId = principalId(requester)
  const canSearchAllPrivatePages = requester !== undefined && managesSystem(requester)
  const canSearchPrivatePages = canSearchAllPrivatePages || privateOwnerId !== null
  const configuredPublicLimit = requestedLimit ?? wiki.config.search?.maxHits
  const publicWindowLimit =
    Number.isSafeInteger(configuredPublicLimit) && Number(configuredPublicLimit) > 0 ? Number(configuredPublicLimit) : DEFAULT_PUBLIC_SEARCH_WINDOW_LIMIT
  const privateWindowLimit = canSearchPrivatePages ? PRIVATE_SEARCH_WINDOW_LIMIT : 0
  const knowledgeWindowLimit = Math.min(KNOWLEDGE_SEARCH_WINDOW_LIMIT, publicWindowLimit)
  const windowLimit = publicWindowLimit + privateWindowLimit + knowledgeWindowLimit
  if (!query.trim()) {
    return {
      results: [],
      suggestions: [],
      totalHits: 0,
      windowLimit,
      windowTruncated: false
    }
  }

  const initialProtectedPageIds = await protectedPageIds()
  // Public authorization, publication, selected scope, and metadata-only protection are resolved before either bounded backend runs.
  const eligiblePublicPages = await wiki.models.pages
    .query()
    .select(
      'pages.id',
      'pages.sourceRevision',
      'pages.localeCode',
      'pages.path',
      'pages.title',
      'pages.description',
      'pages.visibility',
      'pages.ownerId',
      'pages.isPublished',
      'pages.publishStartDate',
      'pages.publishEndDate'
    )
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => {
      builder.select('tag')
    })
    .modify(builder => {
      builder.where({ visibility: 'public', isPublished: true })
      if (locale !== undefined) builder.andWhere('pages.localeCode', locale)
      if (path !== undefined) {
        builder.andWhere(scope => {
          scope.where('pages.path', path).orWhere('pages.path', 'LIKE', `${escapeLikePattern(path)}/%`)
        })
      }
      if (selectedPageIds !== undefined) builder.whereIn('pages.id', selectedPageIds)
    })
  const metadataEligibleProtectedIds = await matchingProtectedMetadataIds(
    query,
    eligiblePublicPages.filter(page => initialProtectedPageIds.has(page.id)).map(page => page.id)
  )
  const authorizedPublicRevisionById = new Map<number, string>()
  for (const page of eligiblePublicPages) {
    if (!publicationWindowOpen(page) || !canReadPage(requester, page, authority)) continue
    if (initialProtectedPageIds.has(page.id) && !metadataEligibleProtectedIds.has(page.id)) continue
    const sourceRevision = currentSourceRevision(page.sourceRevision)
    if (sourceRevision !== undefined) authorizedPublicRevisionById.set(page.id, sourceRevision)
  }
  const authorizedPublicIds = [...authorizedPublicRevisionById.keys()]
  const knowledgeRepository = new PageKnowledgeRepository(wiki.models.knex)
  const [filteredPublicIdsRaw, filteredPrivateIds] =
    filter === undefined
      ? [authorizedPublicIds, undefined]
      : await Promise.all([
          knowledgeRepository.filterVisibleCurrentIds({
            requester,
            pageIds: authorizedPublicIds,
            authorizedPageIds: authorizedPublicIds,
            filter,
            authority
          }),
          knowledgeRepository.filterVisibleCurrentIds({
            requester,
            authorizedPageIds: authorizedPublicIds,
            filter,
            authority
          })
        ])
  const filteredPublicIds = filteredPublicIdsRaw.filter(pageId => authorizedPublicRevisionById.has(pageId))
  const pageRevisions = Object.fromEntries(filteredPublicIds.map(pageId => [String(pageId), authorizedPublicRevisionById.get(pageId)] as const)) as Record<
    string,
    string
  >
  const effectivePrivateIds = filteredPrivateIds ?? []
  const args = {
    pageIds: filteredPublicIds,
    pageRevisions,
    ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
    ...(locale === undefined ? {} : { locale }),
    ...(path === undefined ? {} : { path })
  }
  const [privatePages, publicResponse, knowledgeCandidates] = await Promise.all([
    !canSearchPrivatePages || (filter !== undefined && effectivePrivateIds.length === 0)
      ? Promise.resolve([])
      : searchPrivatePages({
          query,
          ...(filter === undefined ? (selectedPageIds === undefined ? {} : { pageIds: selectedPageIds }) : { pageIds: effectivePrivateIds }),
          limit: privateWindowLimit,
          ...(locale === undefined ? {} : { locale }),
          ...(path === undefined ? {} : { path }),
          ...(canSearchAllPrivatePages || privateOwnerId === null ? {} : { ownerId: privateOwnerId })
        }),
    wiki.data.searchEngine
      ? wiki.data.searchEngine.query(query, { query, ...args })
      : Promise.resolve<SearchResponse>({ results: [], suggestions: [], totalHits: 0 }),
    knowledgeRepository.searchVisible({
      query,
      requester,
      limit: knowledgeWindowLimit,
      ...(locale === undefined ? {} : { locale }),
      ...(path === undefined ? {} : { path }),
      ...(selectedPageIds === undefined ? {} : { pageIds: selectedPageIds }),
      authorizedPageIds: filteredPublicIds,
      ...(filter === undefined ? {} : { filter }),
      authority
    })
  ])

  const publicResultIds = publicResponse.results.map(result => result.id)
  const candidatePageIds = [...new Set([...publicResultIds, ...knowledgeCandidates.map(candidate => candidate.id)])]
  const livePages =
    candidatePageIds.length === 0
      ? []
      : await wiki.models.pages
          .query()
          .select(
            'pages.id',
            'pages.sourceRevision',
            'pages.localeCode',
            'pages.path',
            'pages.title',
            'pages.description',
            'pages.visibility',
            'pages.ownerId',
            'pages.isPublished',
            'pages.publishStartDate',
            'pages.publishEndDate'
          )
          .withGraphJoined('tags')
          .modifyGraph('tags', builder => {
            builder.select('tag')
          })
          .modify(builder => {
            builder.whereIn('pages.id', candidatePageIds)
          })
  const livePagesById = new Map(livePages.map(page => [page.id, page]))
  const currentProtectedPageIds = await protectedPageIds()
  const currentProtectedMetadataIds = await matchingProtectedMetadataIds(
    query,
    livePages.filter(page => page.visibility === 'public' && currentProtectedPageIds.has(page.id)).map(page => page.id)
  )
  const currentPrivateMetadataIds = await matchingProtectedMetadataIds(
    query,
    privatePages.filter(page => currentProtectedPageIds.has(page.id)).map(page => page.id)
  )
  const publicResults = publicResponse.results.flatMap(result => {
    const id = result.id
    const page = livePagesById.get(id)
    const indexedRevision = currentSourceRevision(result.sourceRevision)
    const liveRevision = currentSourceRevision(page?.sourceRevision)
    if (
      !page ||
      indexedRevision === undefined ||
      liveRevision === undefined ||
      page.visibility !== 'public' ||
      page.localeCode !== result.locale ||
      page.path !== result.path ||
      indexedRevision !== liveRevision ||
      !page.isPublished ||
      !publicationWindowOpen(page) ||
      !canReadPage(requester, page, authority) ||
      (currentProtectedPageIds.has(page.id) && !currentProtectedMetadataIds.has(page.id))
    ) {
      return []
    }
    const metadataOnly = currentProtectedPageIds.has(page.id)
    return [
      {
        ...result,
        id: page.id,
        sourceRevision: liveRevision,
        title: page.title,
        description: page.description ?? '',
        tags: resultTags(page.tags),
        matchedFields: metadataOnly && Array.isArray(result.matchedFields) ? result.matchedFields.filter(field => field !== 'content') : result.matchedFields,
        metadataOnly,
        visibility: 'public' as const
      }
    ]
  })
  const privateResults = privatePages.flatMap(page => {
    const sourceRevision = currentSourceRevision(page.sourceRevision)
    const metadataOnly = currentProtectedPageIds.has(page.id)
    if (sourceRevision === undefined || (metadataOnly && !currentPrivateMetadataIds.has(page.id)) || !canReadPage(requester, page, authority)) {
      return []
    }
    return [
      rankedSearchResult(
        {
          ...page,
          locale: page.locale ?? page.localeCode,
          sourceRevision,
          metadataOnly
        },
        query
      )
    ]
  })
  const knowledgeResults = knowledgeCandidates.flatMap(candidate => {
    const page = livePagesById.get(candidate.id)
    const pageRevision = currentSourceRevision(page?.sourceRevision)
    if (
      !page ||
      pageRevision === undefined ||
      page.visibility !== candidate.visibility ||
      page.localeCode !== candidate.locale ||
      page.path !== candidate.path ||
      pageRevision !== candidate.sourceRevision ||
      (selectedPageIds !== undefined && !selectedPageIds.includes(page.id)) ||
      currentProtectedPageIds.has(page.id) ||
      !canReadPage(requester, page, authority) ||
      (page.visibility === 'public' && (!page.isPublished || !publicationWindowOpen(page)))
    ) {
      return []
    }
    return [
      {
        id: page.id,
        sourceRevision: pageRevision,
        locale: page.localeCode,
        path: page.path,
        title: page.title,
        description: page.description ?? '',
        tags: resultTags(page.tags),
        visibility: page.visibility,
        score: candidate.score,
        matchedFields: candidate.matchedFields
      }
    ]
  })
  const lexicalResults = [...privateResults, ...publicResults.map(result => rankedSearchResult(result, query))]
  const currentKnowledgeById =
    filter === undefined ? new Map<number, KnowledgeProjectionView>() : await knowledgeRepository.getCurrentMany(lexicalResults.map(result => result.id))
  const filteredLexicalResults =
    filter === undefined
      ? lexicalResults
      : lexicalResults.filter(result => {
          const id = result.id
          const knowledge = currentKnowledgeById.get(id)
          return (
            !currentProtectedPageIds.has(id) &&
            knowledge !== undefined &&
            knowledge.sourceRevision === currentSourceRevision(result.sourceRevision) &&
            matchesKnowledgeFilter(knowledge, filter)
          )
        })
  const resultsById = new Map<number, RankedSearchResult>()
  for (const result of [...filteredLexicalResults, ...knowledgeResults.map(result => rankedSearchResult(result, query))]) {
    const id = result.id
    const existing = resultsById.get(id)
    resultsById.set(
      id,
      existing === undefined
        ? result
        : {
            ...existing,
            score: Math.max(existing.score, result.score),
            matchedFields: [...new Set([...existing.matchedFields, ...result.matchedFields])]
          }
    )
  }
  const orderedResults = [...resultsById.values()].sort(
    (left, right) =>
      right.score - left.score ||
      String(left.title).localeCompare(String(right.title)) ||
      String(left.path).localeCompare(String(right.path)) ||
      left.locale.localeCompare(right.locale) ||
      Number(left.id) - Number(right.id)
  )
  const privateCandidates = orderedResults.filter(result => result.visibility === 'private')
  const admittedPrivateIds = new Set(privateCandidates.slice(0, PRIVATE_SEARCH_WINDOW_LIMIT).map(result => result.id))
  const results = orderedResults.filter(result => result.visibility !== 'private' || admittedPrivateIds.has(result.id))
  const privateContributionTruncated = privateCandidates.length > PRIVATE_SEARCH_WINDOW_LIMIT
  return {
    ...publicResponse,
    suggestions: publicResults.length === publicResponse.results.length ? publicResponse.suggestions : [],
    results,
    totalHits: results.length,
    windowLimit,
    windowTruncated:
      publicResponse.results.length >= publicWindowLimit ||
      (canSearchPrivatePages && privatePages.length >= privateWindowLimit) ||
      privateContributionTruncated ||
      knowledgeCandidates.length >= knowledgeWindowLimit
  }
}

const getByPath = async (input: OperationInput, suppliedAuthority?: PageRuleAuthority) => {
  const requester = input.requester
  const authority = await authorityForInput(input, suppliedAuthority)
  const path = stringValue(input.path, 'path')
  const locale = stringValue(input.locale, 'locale')
  const visibility: PageVisibility = input.visibility === 'private' ? 'private' : 'public'
  let page: PageSourceRecord | undefined
  if (visibility === 'private' && managesSystem(requester)) {
    // Path does not identify a private page globally: refuse a cross-owner ambiguity instead of choosing an arbitrary owner.
    const candidates = await wiki.models.pages
      .query()
      .column(['pages.id', 'pages.path', 'pages.localeCode', 'pages.visibility', 'pages.ownerId'])
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => {
        builder.select('tag')
      })
      .modify(builder => {
        builder.where({ path, localeCode: locale, visibility: 'private' })
      })
      .limit(2)
    const [candidate] = candidates
    if (candidates.length === 1 && candidate !== undefined && canReadPage(requester, candidate, authority)) page = await wiki.models.pages.getPageFromDb(candidate.id)
  } else {
    const ownerId = visibility === 'private' ? principalId(requester) : null
    page = await wiki.models.pages.getPageFromDb({ path, locale, visibility, ownerId })
  }
  if (!page || page.path !== path || page.localeCode !== locale || page.visibility !== visibility || !canAccessCurrentPageSource(requester, page, authority)) {
    throw new wiki.Error.PageNotFound()
  }
  await assertUnlocked(input, page.id)
  const projectedPage = await projectReaderPage(input, page)
  return {
    ...projectedPage,
    locale: projectedPage.localeCode,
    editor: projectedPage.editorKey,
    scriptJs: projectedPage.extra.js,
    scriptCss: projectedPage.extra.css
  }
}

const getTreeSnapshot = async (input: OperationInput, db: Knex.Transaction, authority: PageRuleAuthority) => {
  const requester = input.requester
  const locale = input.locale === undefined ? wiki.config.lang.code : stringValue(input.locale, 'locale')
  const path = input.path === undefined ? undefined : stringValue(input.path, 'path')
  let parentId = input.parent === undefined ? undefined : nonNegativeInteger(input.parent, 'parent')
  const mode = typeof input.mode === 'string' ? input.mode : ''
  const includeAncestors = input.includeAncestors === true
  const access = await pageTreeAccess(db, requester, locale, authority)
  let currentPage: PageTreeRecord | undefined
  if (path && !parentId) {
    currentPage = await db('pageTree')
      .where(builder => {
        scopePageQuery(builder, requester)
        builder.where({ path, localeCode: locale })
        if (input.visibility === 'public' || input.visibility === 'private') builder.where('visibility', input.visibility)
      })
      .first('id', 'parent', 'ancestors')
    if (!currentPage || (!access.readable.has(currentPage.id) && !access.reachable.has(currentPage.id))) return []
    parentId = currentPage.parent || 0
  }
  const results = await db('pageTree')
    .where(builder => {
      scopePageQuery(builder, requester)
      builder.where('localeCode', locale)
      if (mode === 'FOLDERS') builder.andWhere('isFolder', true)
      else if (mode === 'PAGES') builder.whereNotNull('pageId')
      builder.where(branch => {
        if (!parentId || parentId < 1) branch.whereNull('parent')
        else {
          branch.where('parent', parentId)
          if (includeAncestors && currentPage) branch.orWhereIn('id', treeAncestorIds(currentPage.ancestors))
        }
      })
    })
    .orderBy([{ column: 'isFolder', order: 'desc' }, 'title'])
  return results
    .flatMap(result => {
      const readable = access.readable.has(result.id)
      const reachable = Boolean(result.isFolder) && access.reachable.has(result.id)
      if ((!readable && !reachable) || (mode === 'PAGES' && !readable)) return []
      return [
        {
          ...result,
          // A denied page can also be a folder leading to readable descendants.
          // Preserve traversal without exposing that page's title, ID or edit action.
          title: readable ? result.title : result.path.split('/').at(-1),
          pageId: readable ? result.pageId : null,
          isFolder: Boolean(result.isFolder),
          parent: result.parent || 0,
          locale: result.localeCode,
          canEdit: readable && access.editable.has(result.id)
        }
      ]
    })
    .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || String(a.title).localeCompare(String(b.title)))
}

// Tree IDs are rebuilt on page moves; authorization and returned rows must share a snapshot.
const getTree = async (input: OperationInput) => {
  const tx = await wiki.models.knex.transaction({ isolationLevel: 'repeatable read', readOnly: true })
  try {
    const authority = await authorityFor(input, tx)
    const result = await getTreeSnapshot(input, tx, authority)
    await tx.commit()
    return result
  } catch (error) {
    await tx.rollback()
    throw error
  }
}

const checkConflict = async (input: OperationInput) => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const id = positiveInteger(input.id, 'id')
  if (!(input.checkoutDate instanceof Date)) throw new ApplicationError('checkoutDate must be a Date', { code: 'INVALID_INPUT' })
  const page = await completePageForAuthorization(
    await wiki.models.pages.query().select('path', 'localeCode', 'updatedAt', 'visibility', 'ownerId').findById(id)
  )
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page, authority))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page, authority)) throw new wiki.Error.PageUpdateForbidden()
  return page.updatedAt > input.checkoutDate
}

const getConflictLatest = async (input: OperationInput) => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const page = await wiki.models.pages.getPageFromDb(positiveInteger(input.id, 'id'))
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page, authority))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page, authority)) throw new wiki.Error.PageViewForbidden()
  await assertUnlocked(input, page.id)
  const projectedPage = await projectReaderPage(input, page)
  return { ...projectedPage, tags: projectedPage.tags.map(tag => tag.tag), locale: projectedPage.localeCode }
}

const create = (input: OperationInput): unknown => {
  const payload = mutationPayload(input, ['ownerId', 'isPrivate', 'privateNS'])
  if (isPageEditorKey(payload.editor) && !normalizeAvailableEditors(wiki.config.editors?.available).includes(payload.editor)) {
    throw new ApplicationError('The selected editor is not available for new pages.', { code: 'EDITOR_NOT_AVAILABLE' })
  }
  const visibility = payload.visibility === undefined ? 'public' : payload.visibility
  if (visibility !== 'public' && visibility !== 'private') {
    throw new ApplicationError('visibility must be public or private', { code: 'INVALID_INPUT' })
  }
  const brandingContext = Object.hasOwn(payload, 'branding')
    ? {
        brandingContext: {
          requester: input.requester,
          sessionId: typeof input.sessionId === 'string' ? input.sessionId : ''
        }
      }
    : {}
  return wiki.models.pages.createPage(
    withRequester(
      {
        ...payload,
        visibility,
        ...brandingContext
      },
      input.requester
    )
  )
}
const update = async (input: OperationInput): Promise<unknown> => {
  const operationInput = recordValue(input.input, 'input')
  const replaceOkfMetadata = Object.hasOwn(operationInput, 'okfMetadata')
  const collaborationGeneration = expectedCollaborationGeneration(operationInput.expectedCollaborationGeneration)
  const payload = mutationPayload(input, ['visibility', 'ownerId', 'isPrivate', 'privateNS', ...(replaceOkfMetadata ? [] : ['okfMetadata'])])
  await assertUnlocked(input, positiveInteger(payload.id, 'id'))
  const brandingContext = Object.hasOwn(payload, 'branding')
    ? {
        brandingContext: {
          requester: input.requester,
          sessionId: typeof input.sessionId === 'string' ? input.sessionId : ''
        }
      }
    : {}
  return wiki.models.pages.updatePage(
    withRequester(
      {
        ...(replaceOkfMetadata ? { ...payload, replaceOkfMetadata: true } : payload),
        ...(collaborationGeneration === undefined ? {} : { expectedCollaborationGeneration: collaborationGeneration }),
        ...brandingContext
      },
      input.requester
    )
  )
}
const setPublication = async (input: OperationInput): Promise<unknown> => {
  const id = positiveInteger(input.id, 'id')
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  if (!expected) throw new ApplicationError('Review the current page revision before changing publication.', { code: 'INVALID_INPUT' })
  if (typeof input.isPublished !== 'boolean') throw new ApplicationError('Publication state must be a boolean.', { code: 'INVALID_INPUT' })
  const validDate = (value: string): boolean => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
    if (!parts) return false
    const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts
    const y = Number(year),
      m = Number(month),
      d = Number(day)
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
    const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31
    return (
      m >= 1 &&
      m <= 12 &&
      d >= 1 &&
      d <= days &&
      Number(hour) <= 23 &&
      Number(minute) <= 59 &&
      Number(second) <= 59 &&
      Number(offsetHour || 0) <= 14 &&
      Number(offsetMinute || 0) <= 59 &&
      (Number(offsetHour) !== 14 || Number(offsetMinute) === 0) &&
      Number.isFinite(Date.parse(value))
    )
  }
  const dates: Record<string, string> = {}
  for (const field of ['publishStartDate', 'publishEndDate']) {
    if (input[field] === undefined) continue
    const value = input[field]
    if (value === null || value === '') dates[field] = ''
    else if (typeof value === 'string' && validDate(value)) dates[field] = new Date(value).toISOString()
    else throw new ApplicationError('Publication dates must be valid ISO timestamps or empty.', { code: 'INVALID_INPUT' })
  }
  if (Object.keys(dates).length === 1) throw new ApplicationError('Supply both publication boundaries when changing the schedule.', { code: 'INVALID_INPUT' })
  if (dates.publishStartDate && dates.publishEndDate && Date.parse(dates.publishEndDate) <= Date.parse(dates.publishStartDate))
    throw new ApplicationError('Publication end must be after its start.', { code: 'INVALID_INPUT' })
  // Delegate authorization, password protection, revision checks, history,
  // rendering, indexing and durable events to the normal editor update path.
  return update({ ...input, input: { id, expectedSourceRevision: expected, isPublished: input.isPublished, ...dates } })
}
const convert = async (input: OperationInput): Promise<unknown> => {
  const payload = mutationPayload(input, ['visibility', 'ownerId', 'isPrivate', 'privateNS'])
  await assertUnlocked(input, positiveInteger(payload.id, 'id'))
  return wiki.models.pages.convertPage(withRequester(payload, input.requester))
}
const move = async (input: OperationInput): Promise<unknown> => {
  const payload = mutationPayload(input, ['visibility', 'ownerId', 'isPrivate', 'privateNS'])
  await assertUnlocked(input, positiveInteger(payload.id, 'id'))
  return wiki.models.pages.movePage(withRequester(payload, input.requester))
}
const authorizeMutation = async (input: OperationInput): Promise<void> => {
  const requester = input.requester
  const kind = stringValue(input.kind, 'kind')
  const operationInput = recordValue(input.input, 'input')
  const authority = await authorityFor(input)
  if (kind === 'create') {
    const path = stringValue(operationInput.path, 'path')
    const locale = stringValue(operationInput.locale, 'locale')
    wiki.models.pages.assertCreateAccess({
      path,
      locale,
      visibility: 'public',
      tags: operationInput.tags,
      user: requester as Express.User,
      authority
    })
    return
  }
  const rawId = kind === 'restore' ? operationInput.pageId : operationInput.id
  const pageId = positiveInteger(rawId, kind === 'restore' ? 'pageId' : 'id')
  const page = await completePageForAuthorization(await wiki.models.pages.query().findById(pageId))
  if (!page) throw new wiki.Error.PageNotFound()
  const canMutate = kind === 'delete' ? canDeletePage(requester, page, authority) : canWritePage(requester, page, authority)
  if (page.visibility === 'private' && !canMutate) throw new wiki.Error.PageNotFound()
  if (!canMutate) {
    if (kind === 'delete') throw new wiki.Error.PageDeleteForbidden()
    if (kind === 'move') throw new wiki.Error.PageMoveForbidden()
    if (kind === 'restore') throw new wiki.Error.PageRestoreForbidden()
    throw new wiki.Error.PageUpdateForbidden()
  }
  await assertUnlocked(input, page.id)
  let proposedTags: unknown = page.tags
  if (kind === 'update' && operationInput.tags !== undefined) proposedTags = tagNames(operationInput.tags).map(tag => ({ tag }))
  if (kind === 'restore') {
    const versionId = positiveInteger(operationInput.versionId, 'versionId')
    const version = await wiki.models.pageHistory.getVersion({ pageId, versionId, requester })
    if (!version) throw new wiki.Error.PageNotFound()
    proposedTags = version.tags
  }
  if (kind === 'move') {
    const destinationPath = stringValue(operationInput.destinationPath, 'destinationPath')
    const destinationLocale = stringValue(operationInput.destinationLocale, 'destinationLocale')
    const proposed = pageAuthorizationContext({
      path: destinationPath,
      localeCode: destinationLocale,
      visibility: page.visibility,
      ownerId: page.ownerId,
      tags: proposedTags
    })
    if (proposed === null) throw new wiki.Error.PageMoveForbidden()
    if (!canWritePage(requester, proposed, authority)) throw new wiki.Error.PageMoveForbidden()
    if (page.visibility === 'public' && !wiki.auth.checkPageAccess(requester, ['write:pages'], proposed, authority))
      throw new wiki.Error.PageMoveForbidden()
  } else if (kind === 'restore' || kind === 'update') {
    const proposed = { ...page, tags: proposedTags }
    if (!canWritePage(requester, proposed, authority)) {
      if (kind === 'restore') throw new wiki.Error.PageRestoreForbidden()
      throw new wiki.Error.PageUpdateForbidden()
    }
  }
}

const changeVisibility = async (input: OperationInput): Promise<unknown> => {
  const id = positiveInteger(input.id, 'id')
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    throw new ApplicationError('visibility must be public or private', { code: 'INVALID_INPUT' })
  }
  if (input.visibility === 'public' && input.confirmPublication !== true) {
    throw new ApplicationError('Publishing a private page requires explicit confirmation', { code: 'CONFIRMATION_REQUIRED' })
  }
  const visibility: PageVisibility = input.visibility
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  const payload = {
    id,
    visibility,
    confirmPublication: input.confirmPublication === true,
    ...(expected === undefined ? {} : { expectedSourceRevision: expected })
  }
  await assertUnlocked(input, id)
  return wiki.models.pages.changeVisibility(input.requester === undefined ? payload : { ...payload, user: input.requester })
}

const transferOwnership = async (input: OperationInput): Promise<unknown> => {
  if (!managesSystem(input.requester)) {
    throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  }
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  const payload = {
    id: positiveInteger(input.id, 'id'),
    ownerId: positiveInteger(input.ownerId, 'ownerId'),
    ...(expected === undefined ? {} : { expectedSourceRevision: expected })
  }
  await assertUnlocked(input, payload.id)
  return wiki.models.pages.transferOwnership(input.requester === undefined ? payload : { ...payload, user: input.requester })
}

const restore = async (input: OperationInput): Promise<void> => {
  const requester = input.requester
  const authority = await authorityFor(input)
  const pageId = positiveInteger(input.pageId, 'pageId')
  const versionId = positiveInteger(input.versionId, 'versionId')
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  if (expected === undefined) throw new ApplicationError('expectedSourceRevision must be a non-empty string', { code: 'INVALID_INPUT' })
  const page = await completePageForAuthorization(
    await wiki.models.pages.query().select('path', 'localeCode', 'sourceRevision', 'updatedAt', 'visibility', 'ownerId').findById(pageId)
  )
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page, authority))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page, authority)) throw new wiki.Error.PageRestoreForbidden()
  if (String(Reflect.get(page, 'sourceRevision')) !== expected) {
    throw new ApplicationError('The page changed after history was opened. Reload history before restoring.', { code: 'PAGE_RESTORE_CONFLICT', status: 409 })
  }
  const version = await wiki.models.pageHistory.getVersion({ pageId, versionId, requester })
  if (!version) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, { ...page, tags: version.tags }, authority)) throw new wiki.Error.PageRestoreForbidden()
  const versionExtra = isRecord(version.extra) ? version.extra : {}
  const restoredBranding = Object.hasOwn(versionExtra, 'branding')
    ? versionExtra.branding === null
      ? null
      : PageBrandingAssignmentSchema.parse(versionExtra.branding)
    : null
  await wiki.models.pages.updatePage(
    withRequester(
      {
        id: pageId,
        content: version.content,
        contentType: version.contentType,
        title: version.title,
        description: version.description,
        editor: version.editor,
        tags: version.tags,
        action: 'restored',
        expectedUpdatedAt: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : page.updatedAt,
        expectedSourceRevision: String(Reflect.get(page, 'sourceRevision')),
        ...(versionExtra.okf === undefined ? {} : { okfMetadata: versionExtra.okf }),
        branding: restoredBranding,
        ...(typeof input[OKF_PRODUCER_CONTEXT] === 'string' ? { okfProducer: input[OKF_PRODUCER_CONTEXT] } : {}),
        okfRestoreRevision: versionId,
        brandingContext: {
          requester,
          sessionId: typeof input.sessionId === 'string' ? input.sessionId : ''
        }
      },
      requester
    )
  )
}

const getPageTags = (value: unknown): RelatedTagQuery => wiki.models.pages.relatedQuery('tags').for(positiveInteger(value, 'pageId'))
export default {
  setPublication,
  preview,
  authorizeMutation,
  changeVisibility,
  checkConflict,
  convert,
  create,
  discover,
  get,
  getByPath,
  getConflictLatest,
  getHistory,
  getPageTags,
  getSource,
  getTree,
  getVersion,
  list,
  listIndex,
  listLinks,
  listRecent,
  listRelated,
  listTags,
  move,
  remove,
  removeTag,
  restore,
  search,
  searchTags,
  transferOwnership,
  update,
  updateTag
}
