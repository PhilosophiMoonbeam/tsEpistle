import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'

const { parseConfig, serializeConfig } = configuration

interface ConfigEntry { key: string, value: string }
interface Provider extends Record<string, unknown> { key: string, isEnabled: boolean, config: ConfigEntry[] | Record<string, unknown> }
interface Query {
  select(...columns: string[]): Query
  findOne(criteria: Record<string, unknown>): Query
  findById(id: number): Query
  withGraphJoined(relation: string): Query
  modifyGraph(relation: string, callback: (builder: { select(column: string): unknown }) => unknown): Promise<Page | undefined>
  where(column: string, value: unknown): { orderBy(column: string): Promise<Comment[]> }
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}
interface Page { id: number, localeCode: string, path: string, tags: unknown[] }
interface Comment extends Record<string, unknown> { id: number, pageId?: number, name?: string, email?: string, ip?: string }
interface CommentModels {
  commentProviders: { getProviders(): Promise<Provider[]>, query(): Query, initProvider(): Promise<unknown> }
  pages: { query(): Query }
  comments: { query(): Query, postNewComment(input: Record<string, unknown>): unknown, updateComment(input: Record<string, unknown>): unknown, deleteComment(input: Record<string, unknown>): unknown }
}
type Requester = Record<string, unknown>
type ErrorConstructor = new () => Error
interface CommentErrors {
  CommentViewForbidden: ErrorConstructor
  CommentNotFound: ErrorConstructor
  CommentGenericError: ErrorConstructor
}

const models = WIKI.models as unknown as CommentModels
const definitions = (WIKI.data as { commentProviders: Array<Record<string, unknown> & { key: string }>, commentProvider: { getCommentById(id: number): Promise<Comment | undefined> } })
const auth = WIKI.auth as { checkAccess(requester: Requester, permissions: string[], context: Record<string, unknown>): boolean }
const errors = WIKI.Error as unknown as CommentErrors
const logger = WIKI.logger as { warn(message: string): void }

const validProvider = (provider: unknown): provider is Provider => Boolean(
  provider && typeof provider === 'object' && !Array.isArray(provider) &&
  typeof Reflect.get(provider, 'key') === 'string' && typeof Reflect.get(provider, 'isEnabled') === 'boolean' &&
  Array.isArray(Reflect.get(provider, 'config'))
)

const listProviders = async () => {
  const providers = await models.commentProviders.getProviders()
  return providers.map(provider => {
    const definition = _.find(definitions.commentProviders, ['key', provider.key]) ?? {}
    return { ...definition, ...provider, config: serializeConfig({ config: provider.config as Record<string, unknown>, definition, knownOnly: true }) }
  })
}

const updateProviders = async (providers: unknown): Promise<void> => {
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

const list = async ({ requester, locale, path }: { requester: Requester, locale: string, path: string }) => {
  const page = await models.pages.query().select('pages.id').findOne({ localeCode: locale, path })
    .withGraphJoined('tags').modifyGraph('tags', builder => builder.select('tag'))
  if (!page) return []
  if (!auth.checkAccess(requester, ['read:comments'], { locale, path, tags: page.tags })) {
    throw new errors.CommentViewForbidden()
  }
  return (await models.comments.query().where('pageId', page.id).orderBy('createdAt')).map(comment => ({
    ...comment, authorName: comment.name, authorEmail: comment.email, authorIP: comment.ip
  }))
}

const get = async ({ requester, id }: { requester: Requester, id: number }) => {
  const comment = await definitions.commentProvider.getCommentById(id)
  if (!comment || !comment.pageId) throw new errors.CommentNotFound()
  const page = await models.pages.query().select('localeCode', 'path').findById(comment.pageId)
    .withGraphJoined('tags').modifyGraph('tags', builder => builder.select('tag'))
  if (!page) {
    logger.warn(`Comment #${comment.id} is linked to a page #${comment.pageId} that doesn't exist! [ERROR]`)
    throw new errors.CommentGenericError()
  }
  if (!auth.checkAccess(requester, ['read:comments'], { path: page.path, locale: page.localeCode, tags: page.tags })) {
    throw new errors.CommentViewForbidden()
  }
  return { ...comment, authorName: comment.name, authorEmail: comment.email, authorIP: comment.ip }
}

const create = ({ requester, ip, input }: { requester: Requester, ip: string, input: Record<string, unknown> }): unknown =>
  models.comments.postNewComment({ ...input, user: requester, ip })
const update = ({ requester, ip, input }: { requester: Requester, ip: string, input: Record<string, unknown> }): unknown =>
  models.comments.updateComment({ ...input, user: requester, ip })
const remove = ({ requester, ip, id }: { requester: Requester, ip: string, id: number }): unknown =>
  models.comments.deleteComment({ id, user: requester, ip })

export default { create, get, list, listProviders, remove, update, updateProviders }
