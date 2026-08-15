import _ from 'lodash'
import { canReadPage, canWritePage, managesSystem, principalId, scopePageQuery, type PageVisibility } from '../helpers/page-access.ts'

import errors from './errors.ts'

const { ApplicationError } = errors

interface TagRecord extends Record<string, unknown> { id: number, tag: string }
interface PageRecord extends Record<string, unknown> {
  id: number
  path: string
  locale?: string
  localeCode: string
  title: string
  updatedAt: Date
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
  andWhereNotNull(column: string): QueryBuilder
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
interface KnexFirstQuery extends PromiseLike<PageTreeRecord | undefined> {
  where(criteria: Record<string, unknown>): KnexFirstQuery
}
interface KnexQuery extends PromiseLike<Array<PageTreeRecord & LinkRow>> {
  column(...columns: unknown[]): KnexQuery
  first(...columns: string[]): KnexFirstQuery
  leftJoin(table: string, left: string, right: string): KnexQuery
  fullOuterJoin(table: string, left: string, right: string): KnexQuery
  where(criteria: Record<string, unknown> | ((builder: QueryBuilder) => void)): KnexQuery
  unionAll(query: KnexQuery): KnexQuery
  orderBy(columns: unknown): KnexQuery
}
interface SearchResult extends Record<string, unknown> { path: string, locale: string, tags?: unknown }
interface SearchResponse extends Record<string, unknown> { results: SearchResult[], suggestions?: unknown[] }
interface WikiPageOperations {
  Error: {
    PageNotFound: new () => Error
    PageHistoryForbidden: new () => Error
    PageViewForbidden: new () => Error
    PageUpdateForbidden: new () => Error
    PageRestoreForbidden: new () => Error
  }
  auth: { checkAccess(user: Express.User | undefined, permissions: readonly string[], context: Record<string, unknown>): boolean }
  config: { db: { type: string }, lang: { code: string } }
  data: { searchEngine?: { query(query: string, options: Record<string, unknown>): Promise<SearchResponse> } }
  models: {
    knex(table: string): KnexQuery
    pages: {
      query(): PageQuery
      relatedQuery(relation: 'tags'): RelatedTagQuery
      getPageFromDb(input: number | { path: string, locale: string, visibility: PageVisibility, ownerId: number | null }): Promise<PageRecord | undefined>
      deletePage(input: { id: number, user?: Express.User }): unknown
      createPage(input: Record<string, unknown> & { user?: Express.User }): unknown
      updatePage(input: Record<string, unknown> & { user?: Express.User }): unknown
      convertPage(input: Record<string, unknown> & { user?: Express.User }): unknown
      movePage(input: Record<string, unknown> & { user?: Express.User }): unknown
      changeVisibility(input: { id: number, visibility: PageVisibility, confirmPublication?: boolean, user?: Express.User }): unknown
      transferOwnership(input: { id: number, ownerId: number, user?: Express.User }): unknown
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
    .flatMap(page => page.tags).map(tag => tag.tag)).slice(0, 5)
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
  let rows
  const columns = [{ id: 'pages.id' }, { path: 'pages.path' }, 'title', { link: 'pageLinks.path' }, { locale: 'pageLinks.localeCode' }]
  if (['mysql', 'mariadb', 'sqlite'].includes(wiki.config.db.type)) {
    rows = await wiki.models.knex('pages')
      .column(...columns)
      .leftJoin('pageLinks', 'pages.id', 'pageLinks.pageId')
      .where({ 'pages.localeCode': locale, 'pages.visibility': 'public' })
      .unionAll(
        wiki.models.knex('pageLinks')
          .column(...columns)
          .leftJoin('pages', 'pageLinks.pageId', 'pages.id')
          .where({ 'pages.localeCode': locale, 'pages.visibility': 'public' })
      )
  } else {
    rows = await wiki.models.knex('pages')
      .column(...columns)
      .fullOuterJoin('pageLinks', 'pages.id', 'pageLinks.pageId')
      .where({ 'pages.localeCode': locale, 'pages.visibility': 'public' })
  }

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

const remove = (input: OperationInput): unknown => {
  const id = positiveInteger(input.id, 'id')
  return input.requester === undefined
    ? wiki.models.pages.deletePage({ id })
    : wiki.models.pages.deletePage({ id, user: input.requester })
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

const search = async (input: OperationInput) => {
  const requester = input.requester
  const query = stringValue(input.query, 'query')
  const args = _.omit(input, ['requester', 'query'])
  const ownerId = principalId(requester)
  const privatePages = ownerId === null
    ? []
    : await wiki.models.pages.query()
      .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'description', 'visibility', 'ownerId'])
      .modify(builder => {
        builder.where({ visibility: 'private', ownerId })
        builder.andWhere(match => {
          const operator = wiki.config.db.type === 'postgres' ? 'ILIKE' : 'LIKE'
          const value = `%${query}%`
          match.where('title', operator, value).orWhere('description', operator, value).orWhere('content', operator, value)
        })
      })
      .limit(50)
  const publicResponse = wiki.data.searchEngine
    ? await wiki.data.searchEngine.query(query, { query, ...args })
    : { results: [], suggestions: [], totalHits: 0 }
  const protectedPageIds = new Set(
    (await wiki.models.knex('pageAccessPasswords'))
      .map(row => Reflect.get(row, 'pageId'))
      .filter((id): id is number => typeof id === 'number')
  )
  const publicIdentities = new Set<string>()
  if (publicResponse.results.length > 0) {
    const livePublicPages = await wiki.models.pages.query()
      .select('id', 'localeCode', 'path', 'title', 'description')
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
      const metadataMatches = `${page.title} ${String(page.description ?? '')}`.toLocaleLowerCase().includes(normalizedQuery)
      if (!protectedPageIds.has(page.id) || metadataMatches) publicIdentities.add(`${page.localeCode}\u0000${page.path}`)
    }
  }
  const publicResults = publicResponse.results.filter(result => (
    publicIdentities.has(`${result.locale}\u0000${result.path}`) &&
    wiki.auth.checkAccess(requester, ['read:pages'], {
      path: result.path,
      locale: result.locale,
      tags: result.tags
    })
  )).map(result => ({ ...result, visibility: 'public' as const }))
  return {
    ...publicResponse,
    suggestions: publicResults.length === publicResponse.results.length ? publicResponse.suggestions : [],
    results: [...privatePages, ...publicResults],
    totalHits: privatePages.length + publicResults.length
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
    else if (mode === 'PAGES') builder.andWhereNotNull('pageId')
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

const changeVisibility = (input: OperationInput): unknown => {
  const id = positiveInteger(input.id, 'id')
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    throw new ApplicationError('visibility must be public or private', { code: 'INVALID_INPUT' })
  }
  if (input.visibility === 'public' && input.confirmPublication !== true) {
    throw new ApplicationError('Publishing a private page requires explicit confirmation', { code: 'CONFIRMATION_REQUIRED' })
  }
  const visibility: PageVisibility = input.visibility
  const payload = {
    id,
    visibility,
    confirmPublication: input.confirmPublication === true
  }
  return wiki.models.pages.changeVisibility(
    input.requester === undefined ? payload : { ...payload, user: input.requester }
  )
}

const transferOwnership = (input: OperationInput): unknown => {
  if (!managesSystem(input.requester)) {
    throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  }
  const payload = {
    id: positiveInteger(input.id, 'id'),
    ownerId: positiveInteger(input.ownerId, 'ownerId')
  }
  return wiki.models.pages.transferOwnership(
    input.requester === undefined ? payload : { ...payload, user: input.requester }
  )
}

const restore = async (input: OperationInput): Promise<void> => {
  const requester = input.requester
  const pageId = positiveInteger(input.pageId, 'pageId')
  const versionId = positiveInteger(input.versionId, 'versionId')
  const expectedUpdatedAt = stringValue(input.expectedUpdatedAt, 'expectedUpdatedAt')
  const expectedTimestamp = Date.parse(expectedUpdatedAt)
  if (Number.isNaN(expectedTimestamp)) throw new ApplicationError('expectedUpdatedAt must be a valid date', { code: 'INVALID_INPUT' })
  const page = await wiki.models.pages.query().select('path', 'localeCode', 'updatedAt', 'visibility', 'ownerId').findById(pageId)
  if (!page || (page.visibility === 'private' && !canWritePage(requester, page))) throw new wiki.Error.PageNotFound()
  if (!canWritePage(requester, page)) throw new wiki.Error.PageRestoreForbidden()
  if (new Date(page.updatedAt).valueOf() !== expectedTimestamp) {
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
    expectedUpdatedAt: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : page.updatedAt
  }, requester))
}

const getPageTags = (value: unknown): RelatedTagQuery => wiki.models.pages.relatedQuery('tags').for(positiveInteger(value, 'pageId'))
export default {
  changeVisibility, checkConflict, convert, create, get, getByPath, getConflictLatest, getHistory, getPageTags, getTree, getVersion,
  list, listLinks, listRecent, listTags, move, remove, removeTag, restore, search, searchTags, transferOwnership, update, updateTag
}
