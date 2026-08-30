import _ from 'lodash'
import { canReadPage, principalId, type PagePrincipal } from '../helpers/page-access.ts'

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
    auth: { checkAccess(requester: Requester, permissions: string[], context?: Record<string, unknown>): boolean }
    Error: CommentErrors
    logger: { warn(message: string): void }
  }
const COMMENT_CREATE_WINDOW_MILLISECONDS = 15_000
const commentCreateKey = (requester: Requester, ip: string): string => `comment-create:${principalId(requester) ?? 'guest'}:${ip || 'unknown'}`
const commentReadDto = (comment: Comment, includeAuditFields: boolean): Record<string, unknown> => {
  const { email, ip, ...dto } = comment
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
      config: serializeConfig({ config: provider.config as Record<string, unknown>, definition, knownOnly: true })
    }
  })
}

const updateProviders = async (providers: unknown): Promise<void> => {
  const { models } = getWiki()
  validateRows(providers, validProvider, 'Invalid comment providers payload')
  for (const provider of providers.map(provider => ({
    key: provider.key,
    isEnabled: provider.isEnabled,
    config: parseConfig(provider.config, { errorMessage: 'Invalid comment providers payload' })
  }))) {
    await models.commentProviders.query().patch({ isEnabled: provider.isEnabled, config: provider.config }).where('key', provider.key)
  }
  await models.commentProviders.initProvider()
}

const list = async ({ requester, pageId }: { requester: Requester; pageId: number }) => {
  const { models, auth, Error: errors } = getWiki()
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new errors.CommentNotFound()
  const page = await models.pages
    .query()
    .select('pages.id', 'pages.localeCode', 'pages.path', 'pages.visibility', 'pages.ownerId')
    .findById(pageId)
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
  if (!page || (page.visibility === 'private' && !canReadPage(requester, page))) throw new errors.CommentNotFound()
  if (
    !canReadPage(requester, page) ||
    !auth.checkAccess(requester, ['read:comments'], {
      locale: page.localeCode,
      path: page.path,
      tags: page.tags
    })
  ) {
    throw new errors.CommentViewForbidden()
  }
  const includeAuditFields = auth.checkAccess(requester, ['manage:system'])
  return (await models.comments.query().where('pageId', page.id).orderBy('createdAt')).map(comment => commentReadDto(comment, includeAuditFields))
}

const get = async ({ requester, id }: { requester: Requester; id: number }) => {
  const { models, data: definitions, auth, Error: errors, logger } = getWiki()
  const comment = await definitions.commentProvider.getCommentById(id)
  if (!comment || !comment.pageId) throw new errors.CommentNotFound()
  const page = await models.pages
    .query()
    .select('localeCode', 'path', 'visibility', 'ownerId')
    .findById(comment.pageId)
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
  if (!page) {
    logger.warn(`Comment #${comment.id} is linked to a page #${comment.pageId} that doesn't exist! [ERROR]`)
    throw new errors.CommentNotFound()
  }
  if (page.visibility === 'private' && !canReadPage(requester, page)) throw new errors.CommentNotFound()
  if (
    !canReadPage(requester, page) ||
    !auth.checkAccess(requester, ['read:comments'], {
      path: page.path,
      locale: page.localeCode,
      tags: page.tags
    })
  ) {
    throw new errors.CommentViewForbidden()
  }
  return commentReadDto(comment, auth.checkAccess(requester, ['manage:system']))
}

const create = async ({ requester, ip, input }: { requester: Requester; ip: string; input: Record<string, unknown> }): Promise<unknown> => {
  const retryAfterMilliseconds = await consumeCommentCreate(requester, ip)
  if (retryAfterMilliseconds !== null) {
    throw Object.assign(new (getWiki().Error.BruteTooManyAttempts)(), {
      status: 429,
      retryAfterMilliseconds
    })
  }
  return getWiki().models.comments.postNewComment({ ...input, user: requester, ip })
}
const update = ({ requester, ip, input }: { requester: Requester; ip: string; input: Record<string, unknown> }): unknown =>
  getWiki().models.comments.updateComment({ ...input, user: requester, ip })
const remove = ({ requester, ip, id }: { requester: Requester; ip: string; id: number }): unknown =>
  getWiki().models.comments.deleteComment({ id, user: requester, ip })

export default { create, get, list, listProviders, remove, update, updateProviders }
