const _ = require('lodash')

const { parseConfig, serializeConfig, validateRows } = require('./configuration')

/* global WIKI */

const validProvider = provider => provider && typeof provider === 'object' && !Array.isArray(provider) && typeof provider.key === 'string' && typeof provider.isEnabled === 'boolean' && Array.isArray(provider.config)

const listProviders = async () => {
  const providers = await WIKI.models.commentProviders.getProviders()
  return providers.map(provider => {
    const definition = _.find(WIKI.data.commentProviders, ['key', provider.key]) || {}
    return {
      ...definition,
      ...provider,
      config: serializeConfig({ config: provider.config, definition, knownOnly: true })
    }
  })
}

const updateProviders = async providers => {
  validateRows(providers, validProvider, 'Invalid comment providers payload')
  const updates = providers.map(provider => ({
    key: provider.key,
    isEnabled: provider.isEnabled,
    config: parseConfig(provider.config, { errorMessage: 'Invalid comment providers payload' })
  }))
  for (const provider of updates) {
    await WIKI.models.commentProviders.query().patch({
      isEnabled: provider.isEnabled,
      config: provider.config
    }).where('key', provider.key)
  }
  await WIKI.models.commentProviders.initProvider()
}

const list = async ({ requester, locale, path }) => {
  const page = await WIKI.models.pages.query().select('pages.id').findOne({ localeCode: locale, path })
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
  if (!page) return []
  if (!WIKI.auth.checkAccess(requester, ['read:comments'], { locale, path, tags: page.tags })) {
    throw new WIKI.Error.CommentViewForbidden()
  }
  return (await WIKI.models.comments.query().where('pageId', page.id).orderBy('createdAt')).map(comment => ({
    ...comment,
    authorName: comment.name,
    authorEmail: comment.email,
    authorIP: comment.ip
  }))
}

const get = async ({ requester, id }) => {
  const comment = await WIKI.data.commentProvider.getCommentById(id)
  if (!comment || !comment.pageId) throw new WIKI.Error.CommentNotFound()
  const page = await WIKI.models.pages.query().select('localeCode', 'path').findById(comment.pageId)
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
  if (!page) {
    WIKI.logger.warn(`Comment #${comment.id} is linked to a page #${comment.pageId} that doesn't exist! [ERROR]`)
    throw new WIKI.Error.CommentGenericError()
  }
  if (!WIKI.auth.checkAccess(requester, ['read:comments'], {
    path: page.path,
    locale: page.localeCode,
    tags: page.tags
  })) throw new WIKI.Error.CommentViewForbidden()
  return {
    ...comment,
    authorName: comment.name,
    authorEmail: comment.email,
    authorIP: comment.ip
  }
}

const create = ({ requester, ip, input }) => WIKI.models.comments.postNewComment({ ...input, user: requester, ip })
const update = ({ requester, ip, input }) => WIKI.models.comments.updateComment({ ...input, user: requester, ip })
const remove = ({ requester, ip, id }) => WIKI.models.comments.deleteComment({ id, user: requester, ip })

module.exports = { create, get, list, listProviders, remove, update, updateProviders }
