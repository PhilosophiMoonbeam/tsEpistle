const _ = require('lodash')
const { ApplicationError } = require('./errors')

/* global WIKI */

const list = async ({ requester, ...args }) => {
  let pages = await WIKI.models.pages.query().column([
    'pages.id',
    'path',
    { locale: 'localeCode' },
    'title',
    'description',
    'isPublished',
    'isPrivate',
    'privateNS',
    'contentType',
    'createdAt',
    'updatedAt'
  ])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
    .modify(queryBuilder => {
      if (args.limit) queryBuilder.limit(args.limit)
      if (args.locale) queryBuilder.where('localeCode', args.locale)
      if (args.creatorId && args.authorId && args.creatorId > 0 && args.authorId > 0) {
        queryBuilder.where(function () {
          this.where('creatorId', args.creatorId).orWhere('authorId', args.authorId)
        })
      } else {
        if (args.creatorId && args.creatorId > 0) queryBuilder.where('creatorId', args.creatorId)
        if (args.authorId && args.authorId > 0) queryBuilder.where('authorId', args.authorId)
      }
      if (args.tags && args.tags.length > 0) {
        queryBuilder.whereIn('tags.tag', args.tags.map(tag => _.trim(tag).toLowerCase()))
      }
      const orderDirection = args.orderByDirection === 'DESC' ? 'desc' : 'asc'
      const orderColumns = { CREATED: 'createdAt', PATH: 'path', TITLE: 'title', UPDATED: 'updatedAt' }
      queryBuilder.orderBy(orderColumns[args.orderBy] || 'pages.id', orderDirection)
    })

  pages = pages.filter(page => WIKI.auth.checkAccess(requester, ['read:pages'], {
    path: page.path,
    locale: page.locale
  })).map(page => ({ ...page, tags: _.map(page.tags, 'tag') }))

  if (args.tags && args.tags.length > 0) {
    pages = pages.filter(page => _.every(args.tags, tag => _.includes(page.tags, tag)))
  }
  return pages
}

const listTags = async requester => {
  const pages = await WIKI.models.pages.query()
    .column(['path', { locale: 'localeCode' }])
    .withGraphJoined('tags')
  const tags = pages.filter(page => WIKI.auth.checkAccess(requester, ['read:pages'], {
    path: page.path,
    locale: page.locale
  })).flatMap(page => page.tags)
  return _.orderBy(_.uniqBy(tags, 'id'), ['tag'], ['asc'])
}

const listRecent = async requester => {
  const pages = await WIKI.models.pages.query()
    .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt'])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
    .orderBy('updatedAt', 'desc')
    .limit(10)
  return pages.filter(page => WIKI.auth.checkAccess(requester, ['read:pages'], {
    path: page.path,
    locale: page.locale,
    tags: page.tags
  })).map(page => _.pick(page, ['id', 'locale', 'path', 'title', 'updatedAt']))
}

const searchTags = async ({ requester, query }) => {
  const normalizedQuery = _.trim(query)
  const pages = await WIKI.models.pages.query()
    .column(['path', { locale: 'localeCode' }])
    .withGraphJoined('tags')
    .modifyGraph('tags', builder => builder.select('tag'))
    .modify(queryBuilder => {
      queryBuilder.andWhere(builder => {
        if (WIKI.config.db.type === 'postgres') builder.where('tags.tag', 'ILIKE', `%${normalizedQuery}%`)
        else builder.where('tags.tag', 'LIKE', `%${normalizedQuery}%`)
      })
    })
  return _.uniq(pages.filter(page => WIKI.auth.checkAccess(requester, ['read:pages'], {
    path: page.path,
    locale: page.locale
  })).flatMap(page => page.tags).map(tag => tag.tag)).slice(0, 5)
}

const get = async ({ requester, id }) => {
  const page = await WIKI.models.pages.getPageFromDb(id)
  if (!page) throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  if (!WIKI.auth.checkAccess(requester, ['manage:pages', 'delete:pages'], {
    path: page.path,
    locale: page.localeCode
  })) {
    throw new ApplicationError('You are not authorized to view this page.', { code: 'PAGE_VIEW_FORBIDDEN', status: 403 })
  }
  return {
    ...page,
    locale: page.localeCode,
    editor: page.editorKey,
    scriptJs: _.get(page, 'extra.js'),
    scriptCss: _.get(page, 'extra.css')
  }
}

const listLinks = async ({ requester, locale }) => {
  let rows
  const columns = [{ id: 'pages.id' }, { path: 'pages.path' }, 'title', { link: 'pageLinks.path' }, { locale: 'pageLinks.localeCode' }]
  if (['mysql', 'mariadb', 'sqlite'].includes(WIKI.config.db.type)) {
    rows = await WIKI.models.knex('pages')
      .column(...columns)
      .leftJoin('pageLinks', 'pages.id', 'pageLinks.pageId')
      .where({ 'pages.localeCode': locale })
      .unionAll(
        WIKI.models.knex('pageLinks')
          .column(...columns)
          .leftJoin('pages', 'pageLinks.pageId', 'pages.id')
          .where({ 'pages.localeCode': locale })
      )
  } else {
    rows = await WIKI.models.knex('pages')
      .column(...columns)
      .fullOuterJoin('pageLinks', 'pages.id', 'pageLinks.pageId')
      .where({ 'pages.localeCode': locale })
  }

  return _.reduce(rows, (result, value) => {
    if (
      !WIKI.auth.checkAccess(requester, ['read:pages'], { path: value.path, locale }) ||
      !WIKI.auth.checkAccess(requester, ['read:pages'], { path: value.link, locale: value.locale })
    ) return result

    const existingIndex = _.findIndex(result, ['id', value.id])
    if (existingIndex >= 0) {
      if (value.link) result[existingIndex].links.push(`${value.locale}/${value.link}`)
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

const remove = ({ requester, id }) => WIKI.models.pages.deletePage({ id, user: requester })

const updateTag = async ({ id, tag, title }) => {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_TAG_ID' })
  if (!_.isString(tag)) throw new ApplicationError('tag must be a string', { code: 'INVALID_TAG' })
  if (!_.isString(title)) throw new ApplicationError('title must be a string', { code: 'INVALID_TAG_TITLE' })
  const affectedRows = await WIKI.models.tags.query().findById(id).patch({
    tag: _.trim(tag).toLowerCase(),
    title: _.trim(title)
  })
  if (affectedRows < 1) throw new ApplicationError('This tag does not exist.', { code: 'TAG_NOT_FOUND', status: 404 })
}

const removeTag = async id => {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_TAG_ID' })
  const tag = await WIKI.models.tags.query().findById(id)
  if (!tag) throw new ApplicationError('This tag does not exist.', { code: 'TAG_NOT_FOUND', status: 404 })
  await tag.$relatedQuery('pages').unrelate()
  await WIKI.models.tags.query().deleteById(id)
}

const getHistory = async ({ requester, id, offsetPage = 0, offsetSize = 100 }) => {
  const page = await WIKI.models.pages.query().select('path', 'localeCode').findById(id)
  if (!page) throw new WIKI.Error.PageNotFound()
  if (!WIKI.auth.checkAccess(requester, ['read:history'], { path: page.path, locale: page.localeCode })) {
    throw new WIKI.Error.PageHistoryForbidden()
  }
  return WIKI.models.pageHistory.getHistory({ pageId: id, offsetPage, offsetSize })
}

const getVersion = async ({ requester, pageId, versionId }) => {
  const page = await WIKI.models.pages.query().select('path', 'localeCode').findById(pageId)
  if (!page) throw new WIKI.Error.PageNotFound()
  if (!WIKI.auth.checkAccess(requester, ['read:history'], { path: page.path, locale: page.localeCode })) {
    throw new WIKI.Error.PageHistoryForbidden()
  }
  return WIKI.models.pageHistory.getVersion({ pageId, versionId })
}

const search = async ({ requester, query, ...args }) => {
  if (!WIKI.data.searchEngine) return { results: [], suggestions: [], totalHits: 0 }
  const response = await WIKI.data.searchEngine.query(query, { query, ...args })
  return {
    ...response,
    results: response.results.filter(result => WIKI.auth.checkAccess(requester, ['read:pages'], {
      path: result.path,
      locale: result.locale,
      tags: result.tags
    }))
  }
}

const getByPath = async ({ requester, path, locale }) => {
  const page = await WIKI.models.pages.getPageFromDb({ path, locale })
  if (!page) throw new WIKI.Error.PageNotFound()
  if (!WIKI.auth.checkAccess(requester, ['manage:pages', 'delete:pages'], { path: page.path, locale: page.localeCode })) {
    throw new WIKI.Error.PageViewForbidden()
  }
  return {
    ...page,
    locale: page.localeCode,
    editor: page.editorKey,
    scriptJs: page.extra.js,
    scriptCss: page.extra.css
  }
}

const getTree = async ({ requester, locale = WIKI.config.lang.code, path, parent, mode, includeAncestors }) => {
  let currentPage = null
  let parentId = parent
  if (path && !parentId) {
    currentPage = await WIKI.models.knex('pageTree').first('parent', 'ancestors').where({ path, localeCode: locale })
    if (!currentPage) return []
    parentId = currentPage.parent || 0
  }
  const results = await WIKI.models.knex('pageTree').where(builder => {
    builder.where('localeCode', locale)
    if (mode === 'FOLDERS') builder.andWhere('isFolder', true)
    else if (mode === 'PAGES') builder.andWhereNotNull('pageId')
    if (!parentId || parentId < 1) {
      builder.whereNull('parent')
    } else {
      builder.where('parent', parentId)
      if (includeAncestors && currentPage && currentPage.ancestors.length > 0) {
        builder.orWhereIn('id', _.isString(currentPage.ancestors) ? JSON.parse(currentPage.ancestors) : currentPage.ancestors)
      }
    }
  }).orderBy([{ column: 'isFolder', order: 'desc' }, 'title'])
  return results.filter(result => WIKI.auth.checkAccess(requester, ['read:pages'], {
    path: result.path,
    locale: result.localeCode
  })).map(result => ({ ...result, parent: result.parent || 0, locale: result.localeCode }))
}

const checkConflict = async ({ requester, id, checkoutDate }) => {
  const page = await WIKI.models.pages.query().select('path', 'localeCode', 'updatedAt').findById(id)
  if (!page) throw new WIKI.Error.PageNotFound()
  if (!WIKI.auth.checkAccess(requester, ['write:pages', 'manage:pages'], { path: page.path, locale: page.localeCode })) {
    throw new WIKI.Error.PageUpdateForbidden()
  }
  return page.updatedAt > checkoutDate
}

const getConflictLatest = async ({ requester, id }) => {
  const page = await WIKI.models.pages.getPageFromDb(id)
  if (!page) throw new WIKI.Error.PageNotFound()
  if (!WIKI.auth.checkAccess(requester, ['write:pages', 'manage:pages'], { path: page.path, locale: page.localeCode })) {
    throw new WIKI.Error.PageViewForbidden()
  }
  return { ...page, tags: page.tags.map(tag => tag.tag), locale: page.localeCode }
}

const create = ({ requester, input }) => WIKI.models.pages.createPage({ ...input, user: requester })
const update = ({ requester, input }) => WIKI.models.pages.updatePage({ ...input, user: requester })
const convert = ({ requester, input }) => WIKI.models.pages.convertPage({ ...input, user: requester })
const move = ({ requester, input }) => WIKI.models.pages.movePage({ ...input, user: requester })

const restore = async ({ requester, pageId, versionId }) => {
  const page = await WIKI.models.pages.query().select('path', 'localeCode').findById(pageId)
  if (!page) throw new WIKI.Error.PageNotFound()
  if (!WIKI.auth.checkAccess(requester, ['write:pages'], { path: page.path, locale: page.localeCode })) {
    throw new WIKI.Error.PageRestoreForbidden()
  }
  const version = await WIKI.models.pageHistory.getVersion({ pageId, versionId })
  if (!version) throw new WIKI.Error.PageNotFound()
  await WIKI.models.pages.updatePage({ ...version, id: version.pageId, user: requester, action: 'restored' })
}

const getPageTags = pageId => WIKI.models.pages.relatedQuery('tags').for(pageId)
module.exports = {
  checkConflict,
  convert,
  create,
  get,
  getByPath,
  getConflictLatest,
  getHistory,
  getPageTags,
  getTree,
  getVersion,
  list,
  listLinks,
  listRecent,
  listTags,
  move,
  remove,
  removeTag,
  restore,
  search,
  searchTags,
  update,
  updateTag
}
