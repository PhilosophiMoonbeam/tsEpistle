import _ from 'lodash'
import { canReadPage, pageAuthorizationContext, principalId, type PagePrincipal } from '../helpers/page-access.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import { commentMentionHandles, renderCommentMarkdown } from '../helpers/comment-markdown.ts'

import { assertPageUnlocked } from './page-protection.ts'
import { writeLegacyDiscussionProviders } from './discussion-settings.ts'
import configuration, { validateRows } from './configuration.ts'

const { parseConfig, serializeConfig } = configuration

interface ConfigEntry {
  key: string
  value: string
}
interface RateLimitRow {
  points: number | string
  expire: number | string | null
}
interface Provider extends Record<string, unknown> {
  key: string
  isEnabled: boolean
  config: ConfigEntry[] | Record<string, unknown>
}
interface Query {
  select(...columns: string[]): Query
  findOne(criteria: Record<string, unknown>): Query
  findById(id: number): Query
  withGraphJoined(relation: string): Query
  modifyGraph(relation: string, callback: (builder: { select(column: string): unknown }) => unknown): Promise<Page | undefined>
  where(column: string, value: unknown): { orderBy(column: string): Promise<Comment[]> }
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}
interface Page {
  id: number
  localeCode: string
  path: string
  tags: unknown[]
  visibility: 'public' | 'private'
  ownerId: number | null
}
interface Comment extends Record<string, unknown> {
  id: number
  authorId?: number
  replyTo?: number | null
  isHidden?: boolean
  content?: string
  render?: string
  createdAt?: string
  updatedAt?: string
  pageId?: number
  name?: string
  email?: string
  ip?: string
}
interface CommentModels {
  knex: { raw<T>(query: string, bindings: unknown[]): Promise<T> }
  commentProviders: { getProviders(): Promise<Provider[]>; query(): Query; initProvider(): Promise<unknown> }
  pages: { query(): Query }
  comments: {
    query(): Query
    postNewComment(input: Record<string, unknown>): unknown
    updateComment(input: Record<string, unknown>): unknown
    deleteComment(input: Record<string, unknown>): unknown
  }
}
type Requester = PagePrincipal
type ErrorConstructor = new () => Error
interface CommentErrors {
  BruteTooManyAttempts: ErrorConstructor
  CommentViewForbidden: ErrorConstructor
  CommentNotFound: ErrorConstructor
  CommentGenericError: ErrorConstructor
}

const getWiki = () =>
  WIKI as unknown as {
    models: CommentModels
    data: { commentProviders: Array<Record<string, unknown> & { key: string }>; commentProvider: { key?: string; getCommentById(id: number): Promise<Comment | undefined> } }
    config: { features: { featurePageComments: boolean } }
    auth: {
      checkAccess(requester: Requester, permissions: readonly string[]): boolean
      checkPageAccess(requester: Requester, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
      loadPageRuleAuthority(requester: Requester): Promise<PageRuleAuthority>
    }
    Error: CommentErrors
    logger: { warn(message: string): void }
  }
const COMMENT_CREATE_WINDOW_MILLISECONDS = 15_000
const commentCreateKey = (requester: Requester, ip: string): string => `comment-create:${principalId(requester) ?? 'guest'}:${ip || 'unknown'}`
const commentReadDto = (comment: Comment, includeAuditFields: boolean, authorHandle = ''): Record<string, unknown> => ({
  id: comment.id,
  pageId: comment.pageId,
  content: comment.content,
  render: comment.render,
  authorId: comment.authorId,
  replyTo: Number(comment.replyTo) > 0 ? Number(comment.replyTo) : 0,
  authorName: comment.name,
  authorHandle,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  ...(includeAuditFields ? { authorEmail: comment.email, authorIP: comment.ip } : {})
})
const visibleThread = (comments: Comment[]): Comment[] => {
  const byId = new Map(comments.map(comment => [comment.id, comment]))
  return comments.flatMap(comment => {
    if (comment.isHidden) return []
    let parentId = Number(comment.replyTo) || 0
    if (parentId === 0) return [{ ...comment, replyTo: 0 }]
    const seen = new Set<number>([comment.id])
    while (parentId > 0) {
      if (seen.has(parentId)) return [{ ...comment, replyTo: 0 }]
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent || parent.isHidden) return [{ ...comment, replyTo: 0 }]
      const ancestorId = Number(parent.replyTo) || 0
      if (ancestorId === 0) return [{ ...comment, replyTo: parent.id }]
      parentId = ancestorId
    }
    return [{ ...comment, replyTo: 0 }]
  }).sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) || left.id - right.id)
}
interface MentionRow { id: number; handle: string; name: string }
const resolveMentionHandles = async (models: CommentModels, pageId: number, comments: Comment[]): Promise<Set<string>> => {
  const mentioned = [...new Set(comments.flatMap(comment => commentMentionHandles(String(comment.content ?? ''))))]
  if (mentioned.length === 0) return new Set()
  const placeholders = mentioned.map(() => '?').join(', ')
  const result = await models.knex.raw<{ rows: Array<{ handle: string }> }>(
    `SELECT DISTINCT claims."handle"
       FROM "userHandleClaims" claims
       JOIN "users" u ON u."id" = claims."userId"
       JOIN "comments" participant ON participant."authorId" = u."id" AND participant."pageId" = ? AND participant."isHidden" = false
      WHERE claims."handle" IN (${placeholders})
        AND u."isActive" = true
        AND u."isSystem" = false
        AND u."id" <> 2`,
    [pageId, ...mentioned]
  )
  return new Set(result.rows.map(row => row.handle))
}

const consumeCommentCreate = async (requester: Requester, ip: string): Promise<number | null> => {
  const now = Date.now()
  const expire = now + COMMENT_CREATE_WINDOW_MILLISECONDS
  const result = await getWiki().models.knex.raw<{ rows: RateLimitRow[] }>(
    `
    INSERT INTO "authRateLimitAttempts" ("key", "points", "expire")
    VALUES (?, 1, ?)
    ON CONFLICT ("key") DO UPDATE SET
      "points" = CASE
        WHEN "authRateLimitAttempts"."expire" IS NULL OR "authRateLimitAttempts"."expire" <= ? THEN 1
        ELSE "authRateLimitAttempts"."points" + 1
      END,
      "expire" = CASE
        WHEN "authRateLimitAttempts"."expire" IS NULL OR "authRateLimitAttempts"."expire" <= ? THEN EXCLUDED."expire"
        ELSE "authRateLimitAttempts"."expire"
      END
    RETURNING "points", "expire"
  `,
    [commentCreateKey(requester, ip), expire, now, now]
  )
  const row = result.rows[0]
  if (!row || Number(row.points) <= 1) return null
  return Math.max(Number(row.expire) - now, 1)
}

const validProvider = (provider: unknown): provider is Provider =>
  Boolean(
    provider &&
      typeof provider === 'object' &&
      !Array.isArray(provider) &&
      typeof Reflect.get(provider, 'key') === 'string' &&
      typeof Reflect.get(provider, 'isEnabled') === 'boolean' &&
      Array.isArray(Reflect.get(provider, 'config'))
  )

const listProviders = async () => {
  const { models, data: definitions } = getWiki()
  const providers = await models.commentProviders.getProviders()
  return providers.map(provider => {
    const definition = _.find(definitions.commentProviders, ['key', provider.key]) ?? {}
    return {
      ...definition,
      ...provider,
      isEnabled: Boolean(provider.isEnabled),
      config: serializeConfig({ config: provider.config as Record<string, unknown>, definition, knownOnly: true, maskSensitive: true })
    }
  })
}

const updateProviders = async (providers: unknown): Promise<void> => {
  validateRows(providers, validProvider, 'Invalid comment providers payload')
  await writeLegacyDiscussionProviders(providers.map(provider => ({ key: provider.key, isEnabled: provider.isEnabled, config: parseConfig(provider.config, { errorMessage: 'Invalid comment providers payload' }) })))
}

const availability = async ({ requester, pageId, sessionId = '' }: { requester: Requester; pageId: number; sessionId?: string }) => {
  const { models, auth, Error: errors, data, config } = getWiki()
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  const page = await models.pages.query().select('pages.id', 'pages.localeCode', 'pages.path', 'pages.visibility', 'pages.ownerId').findById(pageId).withGraphJoined('tags').modifyGraph('tags', builder => builder.select('tag'))
  const authority = await auth.loadPageRuleAuthority(requester)
  const context = page ? pageAuthorizationContext(page) : null
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page, authority))) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  if (!canReadPage(requester, page, authority) || context === null || !auth.checkPageAccess(requester, ['read:comments'], context, authority)) throw Object.assign(new errors.CommentViewForbidden(), { status: 403 })
  await assertPageUnlocked({ requester, pageId, sessionId, authority })
  const result = await models.knex.raw<{ rows: Array<{ closed: boolean }> }>('SELECT "closed" FROM "pageDiscussionPolicy" WHERE "pageId" = ?', [pageId])
  const closed = result.rows[0]?.closed === true
  const enabled = config.features.featurePageComments && data.commentProvider.key === 'default'
  const canWrite = auth.checkPageAccess(requester, ['write:comments'], context, authority)
  return { enabled, closed, canPost: enabled && !closed && canWrite }
}

const list = async ({ requester, pageId, sessionId = '' }: { requester: Requester; pageId: number; sessionId?: string }) => {
  const { models, auth, Error: errors } = getWiki()
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  const page = await models.pages
    .query()
    .select('pages.id', 'pages.localeCode', 'pages.path', 'pages.visibility', 'pages.ownerId')
    .findById(pageId)
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
  const authority = await auth.loadPageRuleAuthority(requester)
  const pageContext = page ? pageAuthorizationContext(page) : null
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page, authority))) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  if (
    !canReadPage(requester, page, authority) ||
    pageContext === null ||
    !auth.checkPageAccess(requester, ['read:comments'], pageContext, authority)
  ) {
    throw Object.assign(new errors.CommentViewForbidden(), { status: 403 })
  }
  await assertPageUnlocked({ requester, pageId, sessionId, authority })
  const includeAuditFields = auth.checkAccess(requester, ['manage:system'])
  const comments = visibleThread(await models.comments.query().where('pageId', page.id).orderBy('createdAt'))
  const resolvedMentions = await resolveMentionHandles(models, page.id, comments)
  for (const comment of comments) comment.render = renderCommentMarkdown(String(comment.content ?? ''), resolvedMentions)
  const authorIds = [...new Set(comments.map(comment => Number(comment.authorId)).filter(id => Number.isSafeInteger(id) && id > 2))]
  const handles = new Map<number, string>()
  if (authorIds.length > 0) {
    const placeholders = authorIds.map(() => '?').join(', ')
    const result = await models.knex.raw<{ rows: Array<{ id: number; handle: string }> }>(`SELECT "id", "handle" FROM "users" WHERE "id" IN (${placeholders}) AND "handle" IS NOT NULL AND "isActive" = true AND "isSystem" = false`, authorIds)
    for (const row of result.rows) handles.set(Number(row.id), row.handle)
  }
  return comments.map(comment => commentReadDto(comment, includeAuditFields, handles.get(Number(comment.authorId)) ?? ''))
}

const get = async ({ requester, id, sessionId = '' }: { requester: Requester; id: number; sessionId?: string }) => {
  const { models, auth, Error: errors, logger } = getWiki()
  const comment = await models.comments.query().findById(id) as unknown as Comment | undefined
  if (!comment || !comment.pageId || comment.isHidden) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  const page = await models.pages
    .query()
    .select('localeCode', 'path', 'visibility', 'ownerId')
    .findById(comment.pageId)
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
  if (!page) {
    logger.warn(`Comment #${comment.id} is linked to a page #${comment.pageId} that doesn't exist! [ERROR]`)
    throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  }
  const authority = await auth.loadPageRuleAuthority(requester)
  const pageContext = pageAuthorizationContext(page)
  if (page.visibility === 'private' && !canReadPage(requester, page, authority)) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  if (
    !canReadPage(requester, page, authority) ||
    pageContext === null ||
    !auth.checkPageAccess(requester, ['read:comments'], pageContext, authority)
  ) {
    throw Object.assign(new errors.CommentViewForbidden(), { status: 403 })
  }
  await assertPageUnlocked({ requester, pageId: comment.pageId, sessionId, authority })
  const projected = visibleThread(await models.comments.query().where('pageId', comment.pageId).orderBy('createdAt')).find(item => item.id === comment.id)
  if (!projected) throw Object.assign(new errors.CommentNotFound(), { status: 404 })
  const resolvedMentions = await resolveMentionHandles(models, comment.pageId, [projected])
  projected.render = renderCommentMarkdown(String(projected.content ?? ''), resolvedMentions)
  let authorHandle = ''
  if (Number(projected.authorId) > 2) {
    const result = await models.knex.raw<{ rows: Array<{ handle: string }> }>('SELECT "handle" FROM "users" WHERE "id" = ? AND "handle" IS NOT NULL AND "isActive" = true AND "isSystem" = false', [projected.authorId])
    authorHandle = result.rows[0]?.handle ?? ''
  }
  return commentReadDto(projected, auth.checkAccess(requester, ['manage:system']), authorHandle)
}

const searchMentions = async ({ requester, pageId, query, sessionId = '' }: { requester: Requester; pageId: number; query: unknown; sessionId?: string }): Promise<MentionRow[]> => {
  const requesterId = principalId(requester)
  if (requesterId === null || requesterId === 2) throw Object.assign(new Error('Sign in to search mention handles.'), { status: 401 })
  const { models, auth, Error: errors } = getWiki()
  await list({ requester, pageId, sessionId })
  const page = await models.pages.query().select('pages.id', 'pages.localeCode', 'pages.path', 'pages.visibility', 'pages.ownerId').findById(pageId).withGraphJoined('tags').modifyGraph('tags', builder => builder.select('tag'))
  const authority = await auth.loadPageRuleAuthority(requester)
  const context = page ? pageAuthorizationContext(page) : null
  if (!page || context === null || (!auth.checkPageAccess(requester, ['write:comments'], context, authority) && !auth.checkPageAccess(requester, ['manage:comments'], context, authority))) throw Object.assign(new errors.CommentViewForbidden(), { status: 403 })
  const prefix = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!/^[a-z0-9_-]{2,32}$/.test(prefix)) return []
  const result = await models.knex.raw<{ rows: MentionRow[] }>(
    `SELECT u."id", u."handle", MIN(c."name") AS "name"
       FROM "users" u
       JOIN "comments" c ON c."authorId" = u."id" AND c."pageId" = ? AND c."isHidden" = false
      WHERE u."handle" IS NOT NULL
        AND u."isActive" = true
        AND u."isSystem" = false
        AND u."id" <> 2
        AND u."handle" LIKE ?
      GROUP BY u."id", u."handle"
      ORDER BY u."handle" ASC
      LIMIT 8`,
    [pageId, `${prefix}%`]
  )
  return result.rows.map(row => ({ id: Number(row.id), handle: row.handle, name: row.name }))
}

const create = async ({ requester, ip, input, sessionId = '' }: { requester: Requester; ip: string; input: Record<string, unknown>; sessionId?: string }): Promise<unknown> => {
  const retryAfterMilliseconds = await consumeCommentCreate(requester, ip)
  if (retryAfterMilliseconds !== null) {
    throw Object.assign(new (getWiki().Error.BruteTooManyAttempts)(), {
      status: 429,
      retryAfterMilliseconds
    })
  }
  return getWiki().models.comments.postNewComment({ ...input, user: requester, ip, sessionId })
}
const update = ({ requester, ip, input, sessionId = '' }: { requester: Requester; ip: string; input: Record<string, unknown>; sessionId?: string }): unknown =>
  getWiki().models.comments.updateComment({ ...input, user: requester, ip, sessionId })
const remove = ({ requester, ip, id, sessionId = '' }: { requester: Requester; ip: string; id: number; sessionId?: string }): unknown =>
  getWiki().models.comments.deleteComment({ id, user: requester, ip, sessionId })

export default { availability, create, get, list, listProviders, remove, searchMentions, update, updateProviders }
