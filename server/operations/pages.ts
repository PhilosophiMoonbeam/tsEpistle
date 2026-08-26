import _ from 'lodash'
import type { Knex } from 'knex'
import { canDeletePage, canReadPage, canWritePage, managesSystem, pageRoute, principalId, scopePageQuery, type PageVisibility } from '../helpers/page-access.ts'
import { listPageIndexCandidates, PAGE_INDEX_CANDIDATE_LIMIT } from '../repositories/page-index.ts'
import { isPageEditorKey, normalizeAvailableEditors } from '../../shared/page-editors.ts'

import errors from './errors.ts'

const { ApplicationError } = errors
const PRIVATE_SEARCH_WINDOW_LIMIT = 50
const DEFAULT_PUBLIC_SEARCH_WINDOW_LIMIT = 100

interface TagRecord extends Record<string, unknown> { id: number, tag: string, title?: string | null }
interface PageRecord extends Record<string, unknown> {
  id: number
  path: string
  locale?: string
  localeCode: string
  title: string
  description?: string | null
  updatedAt: Date
  isPublished?: boolean
  editorKey: string
  extra: Record<string, unknown>
  visibility: PageVisibility
  ownerId: number | null
  tags: TagRecord[]
}
interface PageTreeRecord extends Record<string, unknown> {
  parent?: number | null
  ancestors?: string | number[]
  path: string
  localeCode: string
  visibility: PageVisibility
  ownerId: number | null
}
interface LinkRow { id: number, title: string, path: string, link?: string, locale?: string }
interface PageGraphEdgeRow { sourceId: number, targetId: number }
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
interface LinkResult { id: number, title: string, path: string, links: string[] }
interface QueryBuilder {
  select(...columns: string[]): QueryBuilder
  where(column: string, operatorOrValue: unknown, value?: unknown): QueryBuilder
  where(callback: (builder: QueryBuilder) => void): QueryBuilder
  where(criteria: Record<string, unknown>): QueryBuilder
  whereNull(column: string): QueryBuilder
  whereIn(column: string, values: readonly unknown[]): QueryBuilder
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
interface RelatedTagQuery extends PromiseLike<TagRecord[]> { for(pageId: number): RelatedTagQuery }
const SEARCH_MATCH_FIELDS = ['title', 'tag', 'path', 'description', 'content', 'graph'] as const
type SearchMatchField = typeof SEARCH_MATCH_FIELDS[number]
interface SearchResult extends Record<string, unknown> {
  path: string
  locale: string
  title?: unknown
  description?: unknown
  tags?: unknown
  score?: unknown
  matchedFields?: unknown
}
interface SearchResponse extends Record<string, unknown> { results: SearchResult[], suggestions?: unknown[], totalHits?: number }
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
  auth: { checkAccess(user: Express.User | undefined, permissions: readonly string[], context: Record<string, unknown>): boolean }
  config: { db: { type: string }, editors?: { available?: unknown }, lang: { code: string }, search?: { maxHits?: number } }
  data: { searchEngine?: { query(query: string, options: Record<string, unknown>): Promise<SearchResponse> } }
  models: {
    knex: Knex
    pages: {
      query(): PageQuery
      relatedQuery(relation: 'tags'): RelatedTagQuery
      getPageFromDb(input: number | { path: string, locale: string, visibility: PageVisibility, ownerId: number | null }): Promise<PageRecord | undefined>
      deletePage(input: { id: number, expectedSourceRevision?: string, user?: Express.User }): unknown
      createPage(input: Record<string, unknown> & { user?: Express.User }): unknown
      updatePage(input: Record<string, unknown> & { user?: Express.User }): unknown
      convertPage(input: Record<string, unknown> & { user?: Express.User }): unknown
      movePage(input: Record<string, unknown> & { user?: Express.User }): unknown
      changeVisibility(input: { id: number, visibility: PageVisibility, confirmPublication?: boolean, expectedSourceRevision?: string, user?: Express.User }): unknown
      transferOwnership(input: { id: number, ownerId: number, expectedSourceRevision?: string, user?: Express.User }): unknown
    }
    tags: {
      query(): {
        findById(id: number): TagPatchQuery & PromiseLike<TagWithRelations | undefined>
        deleteById(id: number): Promise<number>
      }
    }
    pageHistory: {
      getHistory(input: { pageId: number, offsetPage: number, offsetSize: number, requester: Express.User | undefined }): unknown
      getVersion(input: { pageId: number, versionId: number, requester: Express.User | undefined }): Promise<(Record<string, unknown> & { pageId: number }) | undefined>
    }
  }
}
interface OperationInput extends Record<string, unknown> { requester?: Express.User }
const wiki = WIKI as unknown as WikiPageOperations
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
const recordValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApplicationError(`${label} must be an object`, { code: 'INVALID_INPUT' })
  return value as Record<string, unknown>
}
const withRequester = (
  payload: Record<string, unknown>,
  requester: Express.User | undefined
): Record<string, unknown> & { user?: Express.User } =>
  requester === undefined ? payload : { ...payload, user: requester }


const list = async ({ requester, ...rawArgs }: OperationInput) => {
  const args = {
    limit: rawArgs.limit === undefined ? undefined : positiveInteger(rawArgs.limit, 'limit'),
    offset: rawArgs.offset === undefined ? 0 : nonNegativeInteger(rawArgs.offset, 'offset'),
    locale: rawArgs.locale === undefined ? undefined : stringValue(rawArgs.locale, 'locale'),
    creatorId: rawArgs.creatorId === undefined ? undefined : positiveInteger(rawArgs.creatorId, 'creatorId'),
    authorId: rawArgs.authorId === undefined ? undefined : positiveInteger(rawArgs.authorId, 'authorId'),
    tags: rawArgs.tags === undefined ? undefined : Array.isArray(rawArgs.tags) && rawArgs.tags.every(tag => typeof tag === 'string') ? rawArgs.tags as string[] : [],
    orderBy: typeof rawArgs.orderBy === 'string' ? rawArgs.orderBy : '',
    orderByDirection: typeof rawArgs.orderByDirection === 'string' ? rawArgs.orderByDirection : ''
  }
  const pages = await wiki.models.pages.query().column([
    'pages.id',
    'path',
    { locale: 'localeCode' },
    'title',
    'description',
    'isPublished',
    'visibility',
    'ownerId',
    'contentType',
    'createdAt',
    'updatedAt'
  ])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => { builder.select('tag') })
    .modify(queryBuilder => {
      scopePageQuery(queryBuilder, requester, { table: 'pages' })
      if (args.limit) queryBuilder.limit(args.limit)
      if (args.offset > 0) queryBuilder.offset(args.offset)
      if (args.locale) queryBuilder.where('localeCode', args.locale)
      if (args.creatorId && args.authorId && args.creatorId > 0 && args.authorId > 0) {
        queryBuilder.where('creatorId', args.creatorId).orWhere('authorId', args.authorId)
      } else {
        if (args.creatorId && args.creatorId > 0) queryBuilder.where('creatorId', args.creatorId)
        if (args.authorId && args.authorId > 0) queryBuilder.where('authorId', args.authorId)
      }
      if (args.tags && args.tags.length > 0) {
        queryBuilder.whereIn('tags.tag', args.tags.map(tag => _.trim(tag).toLowerCase()))
      }
      const orderDirection = args.orderByDirection === 'DESC' ? 'desc' : 'asc'
      const orderColumns = { CREATED: 'createdAt', PATH: 'path', TITLE: 'title', UPDATED: 'updatedAt' }
      const orderColumn = orderColumns[args.orderBy as keyof typeof orderColumns] ?? 'pages.id'
      queryBuilder.orderBy(orderColumn, orderDirection)
    })

  const accessiblePages = pages.filter(page => canReadPage(requester, page))
    .map(page => ({ ...page, tags: page.tags.map(tag => tag.tag) }))
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

const listIndex = async ({ requester, ...rawArgs }: OperationInput): Promise<PageIndexItem[]> => {
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
    scope: query => { scopePageQuery(query, requester, { table: 'pages' }) }
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
    .filter(page => canReadPage(requester, { ...page, tags: page.tags.map(tag => tag.tag) }))
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

const discover = async ({ requester, ...rawArgs }: OperationInput) => {
  const locale = stringValue(rawArgs.locale, 'locale')
  const path = rawArgs.path === undefined ? '' : stringValue(rawArgs.path, 'path')
  const depth = rawArgs.depth === undefined ? 1 : nonNegativeInteger(rawArgs.depth, 'depth')
  const limit = rawArgs.limit === undefined ? 50 : positiveInteger(rawArgs.limit, 'limit')
  const offset = rawArgs.offset === undefined ? 0 : nonNegativeInteger(rawArgs.offset, 'offset')
  const order = rawArgs.order === undefined ? 'path' : stringValue(rawArgs.order, 'order')
  const tags = rawArgs.tags === undefined
    ? []
    : Array.isArray(rawArgs.tags) && rawArgs.tags.every(tag => typeof tag === 'string')
      ? [...new Set(rawArgs.tags.map(tag => tag.trim().toLocaleLowerCase()).filter(Boolean))]
      : null
  if (depth > 5) throw new ApplicationError('depth must not exceed 5', { code: 'INVALID_INPUT', status: 400 })
  if (limit > 100) throw new ApplicationError('limit must not exceed 100', { code: 'INVALID_INPUT', status: 400 })
  if (offset > PAGE_INDEX_CANDIDATE_LIMIT - 1) throw new ApplicationError(`offset must not exceed ${PAGE_INDEX_CANDIDATE_LIMIT - 1}`, { code: 'INVALID_INPUT', status: 400 })
  if (!['path', 'title', 'updated'].includes(order)) throw new ApplicationError('order must be path, title, or updated', { code: 'INVALID_INPUT', status: 400 })
  if (tags === null || tags.length > 20) throw new ApplicationError('tags must contain at most 20 strings', { code: 'INVALID_INPUT', status: 400 })

  const candidates = await listPageIndexCandidates(wiki.models.knex, {
    locale,
    path,
    limit: PAGE_INDEX_CANDIDATE_LIMIT,
    scope: query => { scopePageQuery(query, requester, { table: 'pages' }) }
  })
  if (candidates.length >= PAGE_INDEX_CANDIDATE_LIMIT) {
    throw new ApplicationError('Page discovery path matches too many pages; choose a narrower path.', { code: 'PAGE_INDEX_TOO_BROAD', status: 422 })
  }
  const prefix = path.length > 0 ? `${path}/` : ''
  const pages = candidates.filter(page => {
    if (!page.path.startsWith(prefix)) return false
    const relativePath = page.path.slice(prefix.length)
    const pageTags = page.tags.map(tag => tag.tag.trim().toLocaleLowerCase())
    return relativePath.length > 0 &&
      relativePath.split('/').length <= depth + 1 &&
      tags.every(tag => pageTags.includes(tag)) &&
      canReadPage(requester, { ...page, tags: pageTags })
  })
  pages.sort((left, right) => {
    if (order === 'title') return left.title.localeCompare(right.title) || left.path.localeCompare(right.path) || left.id - right.id
    if (order === 'updated') return new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf() || left.path.localeCompare(right.path) || left.id - right.id
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

const listTags = async (requester?: Express.User) => {
  const pages = await wiki.models.pages.query()
    .column(['path', { locale: 'localeCode' }, 'visibility', 'ownerId'])
    .modify(queryBuilder => { scopePageQuery(queryBuilder, requester, { table: 'pages' }) })
    .withGraphJoined('tags')
  const tags = pages.filter(page => canReadPage(requester, page)).flatMap(page => page.tags)
  return _.orderBy(_.uniqBy(tags, 'id'), ['tag'], ['asc'])
}

const listRecent = async (requester?: Express.User) => {
  const pages = await wiki.models.pages.query()
    .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt', 'visibility', 'ownerId'])
    .modify(queryBuilder => { scopePageQuery(queryBuilder, requester, { table: 'pages' }) })
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => { builder.select('tag') })
    .orderBy('updatedAt', 'desc')
    .limit(10)
  return pages.filter(page => canReadPage(requester, page))
    .map(page => _.pick(page, ['id', 'locale', 'path', 'title', 'updatedAt', 'visibility']))
}

const searchTags = async (input: OperationInput) => {
  const requester = input.requester
  const normalizedQuery = _.trim(stringValue(input.query, 'query'))
  const limit = input.limit === undefined ? 5 : positiveInteger(input.limit, 'limit')
  if (!normalizedQuery) throw new ApplicationError('query must not be empty', { code: 'INVALID_INPUT', status: 400 })
  if (limit > 20) throw new ApplicationError('limit must not exceed 20', { code: 'INVALID_INPUT', status: 400 })
  const pages = await wiki.models.pages.query()
    .column(['path', { locale: 'localeCode' }, 'visibility', 'ownerId'])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => { builder.select('tag') })
    .modify(queryBuilder => {
      scopePageQuery(queryBuilder, requester, { table: 'pages' })
      queryBuilder.andWhere(builder => {
        if (wiki.config.db.type === 'postgres') builder.where('tags.tag', 'ILIKE', `%${normalizedQuery}%`)
        else builder.where('tags.tag', 'LIKE', `%${normalizedQuery}%`)
      })
    })
  return _.uniq(pages.filter(page => canReadPage(requester, page))
    .flatMap(page => page.tags).map(tag => tag.tag))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit)
}

const get = async (input: OperationInput) => {
  const requester = input.requester
  const page = await wiki.models.pages.getPageFromDb(positiveInteger(input.id, 'id'))
  if (!page || !canReadPage(requester, page)) {
    throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  }
  return {
    ...page,
    locale: page.localeCode,
    editor: page.editorKey,
    scriptJs: _.get(page, 'extra.js'),
    scriptCss: _.get(page, 'extra.css')
  }
}

const listLinks = async (input: OperationInput) => {
  const requester = input.requester
  const locale = stringValue(input.locale, 'locale')
  const columns = [{ id: 'pages.id' }, { path: 'pages.path' }, 'title', { link: 'pageLinks.path' }, { locale: 'pageLinks.localeCode' }]
  const rows = await wiki.models.knex('pages')
    .column(...columns)
    .fullOuterJoin('pageLinks', 'pages.id', 'pageLinks.pageId')
    .where({ 'pages.localeCode': locale, 'pages.visibility': 'public' })

  return _.reduce<LinkRow, LinkResult[]>(rows, (result, value) => {
    if (
      !wiki.auth.checkAccess(requester, ['read:pages'], { path: value.path, locale }) ||
      !wiki.auth.checkAccess(requester, ['read:pages'], { path: value.link, locale: value.locale })
    ) return result

    const existing = _.find(result, ['id', value.id])
    if (existing) {
      if (value.link) existing.links.push(`${value.locale}/${value.link}`)
    } else {
      result.push({
        id: value.id,
        title: value.title,
        path: `${locale}/${value.path}`,
        links: value.link ? [`${value.locale}/${value.link}`] : []
      })
    }
    return result
  }, [])
}
const relatedPageOrder = (left: PageRecord, right: PageRecord): number =>
  left.title.localeCompare(right.title) || left.path.localeCompare(right.path) || left.id - right.id

const listRelated = async (input: OperationInput): Promise<RelatedPagesResult> => {
  const requester = input.requester
  const pageId = positiveInteger(input.pageId, 'pageId')
  const limit = input.limit === undefined ? 20 : positiveInteger(input.limit, 'limit')
  const offset = input.offset === undefined ? 0 : nonNegativeInteger(input.offset, 'offset')
  const maxDepth = input.maxDepth === undefined ? undefined : positiveInteger(input.maxDepth, 'maxDepth')
  if (limit > 100) throw new ApplicationError('limit must not exceed 100', { code: 'INVALID_INPUT', status: 400 })
  if (!Number.isSafeInteger(offset + limit)) throw new ApplicationError('offset and limit exceed the safe traversal range', { code: 'INVALID_INPUT', status: 400 })
  if (maxDepth !== undefined && maxDepth > 32) throw new ApplicationError('maxDepth must not exceed 32', { code: 'INVALID_INPUT', status: 400 })

  const source = await get({ id: pageId, ...(requester === undefined ? {} : { requester }) })
  if (source.visibility !== 'public' || source.isPublished === false) return { pages: [], truncated: false, nextOffset: null }

  const visiblePages = await wiki.models.pages.query()
    .column(['pages.id', 'pages.path', 'pages.localeCode', 'pages.title', 'pages.description', 'pages.visibility', 'pages.ownerId', 'pages.contentType', 'pages.sourceRevision', 'pages.updatedAt'])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => { builder.select('tag') })
    .modify(builder => { builder.where({ 'pages.visibility': 'public', 'pages.isPublished': true }) })
  const pagesById = new Map<number, PageRecord>()
  for (const page of visiblePages) {
    if (canReadPage(requester, page)) pagesById.set(page.id, page)
  }
  if (!pagesById.has(pageId)) return { pages: [], truncated: false, nextOffset: null }

  const rawEdges = await wiki.models.knex('pageLinks as links')
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
    .select({ sourceId: 'source.id', targetId: 'target.id' }) as PageGraphEdgeRow[]

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
    const candidates = new Map<number, { direction: number, viaPageId: number }>()
    for (const from of frontier) {
      for (const [to, direction] of adjacency.get(from) ?? []) {
        if (!seen.has(to) && !candidates.has(to)) candidates.set(to, { direction, viaPageId: from })
      }
    }
    const ordered = [...candidates.entries()]
      .map(([id, connection]) => ({ page: pagesById.get(id), connection }))
      .filter((entry): entry is { page: PageRecord, connection: { direction: number, viaPageId: number } } => entry.page !== undefined)
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

const remove = (input: OperationInput): unknown => {
  const id = positiveInteger(input.id, 'id')
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  const payload = expected === undefined ? { id } : { id, expectedSourceRevision: expected }
  return input.requester === undefined
    ? wiki.models.pages.deletePage(payload)
    : wiki.models.pages.deletePage({ ...payload, user: input.requester })
}

const updateTag = async (input: OperationInput): Promise<void> => {
  const id = positiveInteger(input.id, 'id')
  const tag = stringValue(input.tag, 'tag')
  const title = stringValue(input.title, 'title')
  const affectedRows = await wiki.models.tags.query().findById(id).patch({
    tag: _.trim(tag).toLowerCase(),
    title: _.trim(title)
  })
  if (affectedRows < 1) throw new ApplicationError('This tag does not exist.', { code: 'TAG_NOT_FOUND', status: 404 })
}

const removeTag = async (value: unknown): Promise<void> => {
  const id = positiveInteger(value, 'id')
  const tag = await wiki.models.tags.query().findById(id)
  if (!tag) throw new ApplicationError('This tag does not exist.', { code: 'TAG_NOT_FOUND', status: 404 })
  await tag.$relatedQuery('pages').unrelate()
  await wiki.models.tags.query().deleteById(id)
}

const getHistory = async (input: OperationInput) => {
  const requester = input.requester
  const id = positiveInteger(input.id, 'id')
  const offsetPage = input.offsetPage === undefined ? 0 : nonNegativeInteger(input.offsetPage, 'offsetPage')
  const offsetSize = input.offsetSize === undefined ? 100 : positiveInteger(input.offsetSize, 'offsetSize')
  const page = await wiki.models.pages.query().select('path', 'localeCode', 'visibility', 'ownerId').findById(id)
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page))) throw new wiki.Error.PageNotFound()
  if (page.visibility === 'public' && !wiki.auth.checkAccess(requester, ['read:history'], {
    path: page.path,
    locale: page.localeCode
  })) {
    throw new wiki.Error.PageHistoryForbidden()
  }
  return wiki.models.pageHistory.getHistory({ pageId: id, offsetPage, offsetSize, requester })
}

const getVersion = async (input: OperationInput) => {
  const requester = input.requester
  const pageId = positiveInteger(input.pageId, 'pageId')
  const versionId = positiveInteger(input.versionId, 'versionId')
  const page = await wiki.models.pages.query().select('path', 'localeCode', 'visibility', 'ownerId').findById(pageId)
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page))) throw new wiki.Error.PageNotFound()
  if (page.visibility === 'public' && !wiki.auth.checkAccess(requester, ['read:history'], {
    path: page.path,
    locale: page.localeCode
  })) {
    throw new wiki.Error.PageHistoryForbidden()
  }
  return wiki.models.pageHistory.getVersion({ pageId, versionId, requester })
}

const resultTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const tags = value.flatMap(item => {
    if (typeof item === 'string') return [item]
    if (item && typeof item === 'object' && typeof Reflect.get(item, 'tag') === 'string') return [Reflect.get(item, 'tag') as string]
    return []
  }).map(tag => tag.trim().toLocaleLowerCase()).filter(Boolean)
  return [...new Set(tags)].sort().slice(0, 50)
}

const rankedSearchResult = (result: SearchResult, query: string): SearchResult & {
  tags: string[]
  score: number
  matchedFields: SearchMatchField[]
} => {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const tags = resultTags(result.tags)
  const title = typeof result.title === 'string' ? result.title.toLocaleLowerCase() : ''
  const description = typeof result.description === 'string' ? result.description.toLocaleLowerCase() : ''
  const path = result.path.toLocaleLowerCase()
  const reportedFields = Array.isArray(result.matchedFields)
    ? result.matchedFields.filter((field): field is SearchMatchField => typeof field === 'string' && SEARCH_MATCH_FIELDS.includes(field as SearchMatchField))
    : []
  const derivedFields: SearchMatchField[] = []
  if (title.includes(normalizedQuery)) derivedFields.push('title')
  if (tags.some(tag => tag.includes(normalizedQuery))) derivedFields.push('tag')
  if (path.includes(normalizedQuery)) derivedFields.push('path')
  if (description.includes(normalizedQuery)) derivedFields.push('description')
  if (derivedFields.length === 0) derivedFields.push('content')
  const matchedFields = [...new Set(reportedFields.length > 0 ? reportedFields : derivedFields)]
  const exactTitle = title === normalizedQuery
  const exactTag = tags.includes(normalizedQuery)
  const derivedScore =
    (exactTitle ? 10 : title.includes(normalizedQuery) ? 4 : 0) +
    (exactTag ? 7 : tags.some(tag => tag.includes(normalizedQuery)) ? 2 : 0) +
    (path.includes(normalizedQuery) ? 3 : 0) +
    (description.includes(normalizedQuery) ? 1.5 : 0) +
    (matchedFields.includes('content') ? 1 : 0)
  return {
    ...result,
    tags,
    score: typeof result.score === 'number' && Number.isFinite(result.score) ? Math.max(0, result.score) : derivedScore,
    matchedFields
  }
}

const search = async (input: OperationInput) => {
  const requester = input.requester
  const query = stringValue(input.query, 'query')
  const locale = input.locale === undefined ? undefined : stringValue(input.locale, 'locale')
  const path = input.path === undefined ? undefined : stringValue(input.path, 'path')
  const args = { ..._.omit(input, ['requester', 'query', 'locale', 'path']), ...(locale === undefined ? {} : { locale }), ...(path === undefined ? {} : { path }) }
  const ownerId = principalId(requester)
  const privatePages = ownerId === null
    ? []
    : await wiki.models.pages.query()
      .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'description', 'visibility', 'ownerId'])
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => { builder.select('tag') })
      .modify(builder => {
        const operator = wiki.config.db.type === 'postgres' ? 'ILIKE' : 'LIKE'
        const value = `%${query}%`
        builder.where({ visibility: 'private', ownerId })
        if (locale !== undefined) builder.andWhere('localeCode', locale)
        if (path !== undefined) {
          builder.andWhere(pathScope => {
            pathScope.where('path', path).orWhere('path', 'LIKE', `${path}/%`)
          })
        }
        builder.andWhere(match => {
          match.where('title', operator, value)
            .orWhere('description', operator, value)
            .orWhere('content', operator, value)
            .orWhere('path', operator, value)
            .orWhere('tags.tag', operator, value)
        })
      })
      .limit(PRIVATE_SEARCH_WINDOW_LIMIT)
  const publicResponse = wiki.data.searchEngine
    ? await wiki.data.searchEngine.query(query, { query, ...args })
    : { results: [], suggestions: [], totalHits: 0 }
  const protectedPageIds = new Set(
    (await wiki.models.knex('pageAccessPasswords'))
      .map(row => Reflect.get(row, 'pageId'))
      .filter((id): id is number => typeof id === 'number')
  )
  const publicIdentities = new Set<string>()
  const livePublicPagesByIdentity = new Map<string, PageRecord>()
  if (publicResponse.results.length > 0) {
    const livePublicPages = await wiki.models.pages.query()
      .select('pages.id', 'pages.localeCode', 'pages.path', 'pages.title', 'pages.description')
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => { builder.select('tag') })
      .modify(builder => {
        builder.where({ visibility: 'public' })
        builder.andWhere(matches => {
          for (const result of publicResponse.results) {
            matches.orWhere({ localeCode: result.locale, path: result.path })
          }
        })
      })
    const normalizedQuery = query.toLocaleLowerCase()
    for (const page of livePublicPages) {
      const identity = `${page.localeCode}\u0000${page.path}`
      livePublicPagesByIdentity.set(identity, page)
      const searchableMetadata = [page.title, page.description ?? '', page.path, ...resultTags(page.tags)].join(' ').toLocaleLowerCase()
      if (!protectedPageIds.has(page.id) || searchableMetadata.includes(normalizedQuery)) publicIdentities.add(identity)
    }
  }
  const publicResults = publicResponse.results.filter(result => (
    publicIdentities.has(`${result.locale}\u0000${result.path}`) &&
    wiki.auth.checkAccess(requester, ['read:pages'], {
      path: result.path,
      locale: result.locale,
      tags: result.tags
    })
  )).map(result => {
    const livePage = livePublicPagesByIdentity.get(`${result.locale}\u0000${result.path}`)
    return {
      ...result,
      id: livePage?.id,
      title: livePage?.title,
      description: livePage?.description ?? '',
      visibility: 'public' as const
    }
  })
  const results = [
    ...privatePages.map(page => rankedSearchResult({ ...page, locale: page.locale ?? page.localeCode }, query)),
    ...publicResults.map(result => rankedSearchResult(result, query))
  ].sort((left, right) => right.score - left.score || String(left.title).localeCompare(String(right.title)) || String(left.path).localeCompare(String(right.path)))
  const configuredPublicLimit = wiki.config.search?.maxHits
  const publicWindowLimit = Number.isSafeInteger(configuredPublicLimit) && Number(configuredPublicLimit) > 0
    ? Number(configuredPublicLimit)
    : DEFAULT_PUBLIC_SEARCH_WINDOW_LIMIT
  return {
    ...publicResponse,
    suggestions: publicResults.length === publicResponse.results.length ? publicResponse.suggestions : [],
    results,
    totalHits: results.length,
    windowLimit: publicWindowLimit + (ownerId === null ? 0 : PRIVATE_SEARCH_WINDOW_LIMIT),
    windowTruncated: publicResponse.results.length >= publicWindowLimit || privatePages.length >= PRIVATE_SEARCH_WINDOW_LIMIT
  }
}

const getByPath = async (input: OperationInput) => {
  const requester = input.requester
  const path = stringValue(input.path, 'path')
  const locale = stringValue(input.locale, 'locale')
  const visibility: PageVisibility = input.visibility === 'private' ? 'private' : 'public'
  const ownerId = visibility === 'private' ? principalId(requester) : null
  const page = await wiki.models.pages.getPageFromDb({ path, locale, visibility, ownerId })
  if (!page || !canReadPage(requester, page)) throw new wiki.Error.PageNotFound()
  return { ...page, locale: page.localeCode, editor: page.editorKey, scriptJs: page.extra.js, scriptCss: page.extra.css }
}

const getTree = async (input: OperationInput) => {
  const requester = input.requester
  const locale = input.locale === undefined ? wiki.config.lang.code : stringValue(input.locale, 'locale')
  const path = input.path === undefined ? undefined : stringValue(input.path, 'path')
  let parentId = input.parent === undefined ? undefined : nonNegativeInteger(input.parent, 'parent')
  const mode = typeof input.mode === 'string' ? input.mode : ''
  const includeAncestors = input.includeAncestors === true
  let currentPage: PageTreeRecord | undefined
  if (path && !parentId) {
    currentPage = await wiki.models.knex('pageTree')
      .where(builder => {
        scopePageQuery(builder, requester)
        builder.where({ path, localeCode: locale })
      })
      .first('parent', 'ancestors')
    if (!currentPage) return []
    parentId = currentPage.parent || 0
  }
  const results = await wiki.models.knex('pageTree').where(builder => {
    scopePageQuery(builder, requester)
    builder.where('localeCode', locale)
    if (mode === 'FOLDERS') builder.andWhere('isFolder', true)
    else if (mode === 'PAGES') builder.whereNotNull('pageId')
    if (!parentId || parentId < 1) builder.whereNull('parent')
    else {
      builder.where('parent', parentId)
      if (includeAncestors && currentPage?.ancestors && currentPage.ancestors.length > 0) {
        builder.orWhereIn('id', _.isString(currentPage.ancestors) ? JSON.parse(currentPage.ancestors) as number[] : currentPage.ancestors)
      }
    }
  }).orderBy([{ column: 'isFolder', order: 'desc' }, 'title'])
  return results.map(result => ({
    ...result,
    isFolder: Boolean(result.isFolder),
    parent: result.parent || 0,
    locale: result.localeCode,
    canEdit: typeof result.pageId === 'number' && canWritePage(requester, result)
  }))
}

const checkConflict = async (input: OperationInput) => {
  const requester = input.requester
  const id = positiveInteger(input.id, 'id')
  if (!(input.checkoutDate instanceof Date)) throw new ApplicationError('checkoutDate must be a Date', { code: 'INVALID_INPUT' })
  const page = await wiki.models.pages.query().select('path', 'localeCode', 'updatedAt', 'visibility', 'ownerId').findById(id)
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page)) throw new wiki.Error.PageUpdateForbidden()
  return page.updatedAt > input.checkoutDate
}

const getConflictLatest = async (input: OperationInput) => {
  const requester = input.requester
  const page = await wiki.models.pages.getPageFromDb(positiveInteger(input.id, 'id'))
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page)) throw new wiki.Error.PageViewForbidden()
  return { ...page, tags: page.tags.map(tag => tag.tag), locale: page.localeCode }
}

const create = (input: OperationInput): unknown => {
  const payload = recordValue(input.input, 'input')
  if (isPageEditorKey(payload.editor) && !normalizeAvailableEditors(wiki.config.editors?.available).includes(payload.editor)) {
    throw new ApplicationError('The selected editor is not available for new pages.', { code: 'EDITOR_NOT_AVAILABLE' })
  }
  const visibility = payload.visibility === undefined ? 'public' : payload.visibility
  if (visibility !== 'public' && visibility !== 'private') {
    throw new ApplicationError('visibility must be public or private', { code: 'INVALID_INPUT' })
  }
  return wiki.models.pages.createPage(withRequester({
    ..._.omit(payload, ['ownerId', 'isPrivate', 'privateNS']),
    visibility
  }, input.requester))
}
const update = (input: OperationInput): unknown => wiki.models.pages.updatePage(withRequester(
  _.omit(recordValue(input.input, 'input'), ['visibility', 'ownerId', 'isPrivate', 'privateNS']),
  input.requester
))
const convert = (input: OperationInput): unknown => wiki.models.pages.convertPage(withRequester(
  _.omit(recordValue(input.input, 'input'), ['visibility', 'ownerId', 'isPrivate', 'privateNS']),
  input.requester
))
const move = (input: OperationInput): unknown => wiki.models.pages.movePage(withRequester(
  _.omit(recordValue(input.input, 'input'), ['visibility', 'ownerId', 'isPrivate', 'privateNS']),
  input.requester
))
const authorizeMutation = async (input: OperationInput): Promise<void> => {
  const requester = input.requester
  const kind = stringValue(input.kind, 'kind')
  const operationInput = recordValue(input.input, 'input')
  if (kind === 'create') {
    const path = stringValue(operationInput.path, 'path')
    const locale = stringValue(operationInput.locale, 'locale')
    if (!wiki.auth.checkAccess(requester, ['write:pages', 'manage:pages', 'manage:system'], { path, locale, tags: operationInput.tags })) {
      throw new wiki.Error.PageUpdateForbidden()
    }
    return
  }
  const rawId = kind === 'restore' ? operationInput.pageId : operationInput.id
  const page = await wiki.models.pages.query().findById(positiveInteger(rawId, kind === 'restore' ? 'pageId' : 'id'))
  if (!page) throw new wiki.Error.PageNotFound()
  const canMutate = kind === 'delete' ? canDeletePage(requester, page) : canWritePage(requester, page)
  if (page.visibility === 'private' && !canMutate) throw new wiki.Error.PageNotFound()
  if (!canMutate) {
    if (kind === 'delete') throw new wiki.Error.PageDeleteForbidden()
    if (kind === 'move') throw new wiki.Error.PageMoveForbidden()
    if (kind === 'restore') throw new wiki.Error.PageRestoreForbidden()
    throw new wiki.Error.PageUpdateForbidden()
  }
  if (kind === 'move') {
    const destinationPath = stringValue(operationInput.destinationPath, 'destinationPath')
    const destinationLocale = stringValue(operationInput.destinationLocale, 'destinationLocale')
    if (page.visibility === 'public' && !wiki.auth.checkAccess(requester, ['write:pages', 'manage:pages', 'manage:system'], {
      path: destinationPath,
      locale: destinationLocale,
      tags: page.tags
    })) throw new wiki.Error.PageMoveForbidden()
  }
}

const changeVisibility = (input: OperationInput): unknown => {
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
  return wiki.models.pages.changeVisibility(
    input.requester === undefined ? payload : { ...payload, user: input.requester }
  )
}

const transferOwnership = (input: OperationInput): unknown => {
  if (!managesSystem(input.requester)) {
    throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  }
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  const payload = {
    id: positiveInteger(input.id, 'id'),
    ownerId: positiveInteger(input.ownerId, 'ownerId'),
    ...(expected === undefined ? {} : { expectedSourceRevision: expected })
  }
  return wiki.models.pages.transferOwnership(
    input.requester === undefined ? payload : { ...payload, user: input.requester }
  )
}

const restore = async (input: OperationInput): Promise<void> => {
  const requester = input.requester
  const pageId = positiveInteger(input.pageId, 'pageId')
  const versionId = positiveInteger(input.versionId, 'versionId')
  const expected = expectedSourceRevision(input.expectedSourceRevision)
  if (expected === undefined) throw new ApplicationError('expectedSourceRevision must be a non-empty string', { code: 'INVALID_INPUT' })
  const page = await wiki.models.pages.query().select('path', 'localeCode', 'sourceRevision', 'visibility', 'ownerId').findById(pageId)
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page)) throw new wiki.Error.PageRestoreForbidden()
  if (String(page.sourceRevision) !== expected) {
    throw new ApplicationError('The page changed after history was opened. Reload history before restoring.', { code: 'PAGE_RESTORE_CONFLICT', status: 409 })
  }
  const version = await wiki.models.pageHistory.getVersion({ pageId, versionId, requester })
  if (!version) throw new wiki.Error.PageNotFound()
  await wiki.models.pages.updatePage(withRequester({
    id: pageId,
    content: version.content,
    contentType: version.contentType,
    title: version.title,
    description: version.description,
    editor: version.editor,
    tags: version.tags,
    action: 'restored',
    expectedUpdatedAt: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : page.updatedAt,
    expectedSourceRevision: String(page.sourceRevision)
  }, requester))
}

const getPageTags = (value: unknown): RelatedTagQuery => wiki.models.pages.relatedQuery('tags').for(positiveInteger(value, 'pageId'))
export default {
  authorizeMutation, changeVisibility, checkConflict, convert, create, discover, get, getByPath, getConflictLatest, getHistory, getPageTags, getTree, getVersion,
  list, listIndex, listLinks, listRecent, listRelated, listTags, move, remove, removeTag, restore, search, searchTags, transferOwnership, update, updateTag
}
