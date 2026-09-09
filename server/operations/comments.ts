import _ from 'lodash'
import { canReadPage, pageAuthorizationContext, principalId, type PagePrincipal } from '../helpers/page-access.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'

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
    data: { commentProviders: Array<Record<string, unknown> & { key: string }>; commentProvider: { getCommentById(id: number): Promise<Comment | undefined> } }
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
const commentReadDto = (comment: Comment, includeAuditFields: boolean): Record<string, unknown> => {
  const { email, ip, moderationReason: _reason, moderationRevision: _revision, moderatedAt: _at, moderatedBy: _by, ...dto } = comment
  return {
    ...dto,
    authorName: comment.name,
    ...(includeAuditFields ? { authorEmail: email, authorIP: ip } : {})
  }
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
  return (await models.comments.query().where('pageId', page.id).orderBy('createdAt')).filter(comment => !comment.isHidden).map(comment => commentReadDto(comment, includeAuditFields))
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
  return commentReadDto(comment, auth.checkAccess(requester, ['manage:system']))
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

export default { create, get, list, listProviders, remove, update, updateProviders }
