import express from 'express'
import { type Request, type Response } from './_types.ts'
import pageHelper from '../helpers/page.ts'
import { canReadPage, canWritePage, managesSystem, pageRoute, principalId, type PageVisibility } from '../helpers/page-access.ts'
import _ from 'lodash'
import CleanCSS from 'clean-css'
import moment from 'moment'
import qs from 'node:querystring'

const router = express.Router()


const tmplCreateRegex = /^[0-9]+(,[0-9]+)?$/
interface PageTag {
  tag: string
}

interface ParsedPageArgs {
  locale: string
  path: string
  visibility: PageVisibility
  ownerId: number | null
  explicitLocale: boolean
  tags?: unknown
}

interface PageRecord {
  id: number
  path: string
  locale: string
  localeCode: string
  visibility: PageVisibility
  ownerId: number | null
  title: string
  description: string
  contentType: string
  content: string
  isPublished: boolean
  updatedAt: string | Date
  createdAt: string | Date
  editorKey: string
  editor: string
  tags: PageTag[]
  extra?: { css: string; js: string }
  publishStartDate?: string | Date
  publishEndDate?: string | Date
  toc?: unknown
  $relatedQuery(name: string): Promise<unknown>
}

interface EditorPage {
  id?: number
  path: string
  locale?: string
  localeCode?: string
  title: string | null
  description: string | null
  contentType?: string
  content: string | null
  visibility?: PageVisibility
  ownerId?: number | null
  isPublished?: boolean | number | string
  updatedAt: string | Date
  createdAt?: string | Date
  editorKey: string | null
  editor?: string
  tags?: PageTag[] | string[]
  extra: { css: string; js: string }
  mode?: string
  publishStartDate?: string | Date
  publishEndDate?: string | Date
  toc?: unknown
  $relatedQuery?(name: string): Promise<unknown>
}

interface EffectivePermissions {
  pages: { read: boolean; write: boolean; manage: boolean }
  history: { read: boolean }
  source: { read: boolean }
}

interface NavigationItem {
  kind: unknown
  label: unknown
  icon: unknown
  targetType: unknown
  target: unknown
}

interface CommonWiki {
  auth: {
    checkAccess(user: Express.User | undefined, permissions: readonly string[], context?: unknown): boolean
    getEffectivePermissions(request: Request, context: unknown): EffectivePermissions
  }
  config: {
    seo: { robots: string }
    metrics: { isEnabled: boolean }
    lang: { namespacing: boolean }
    theming: { injectCSS: string; injectHead: string; injectBody: string }
    pageExtensions: string[]
    features: { featurePageComments: boolean }
    host: string
  }
  metrics: { render(response: Response): unknown }
  models: {
    knex: { client: { pool: { numFree(): number; numUsed(): number } } }
    pages: {
      getPageFromDb(input: number | { path: string; locale: string; visibility: PageVisibility; ownerId: number | null }): Promise<PageRecord | null>
      getPage(input: { path: string; locale: string; visibility: PageVisibility; ownerId: number | null }): Promise<PageRecord | null>
      query(): {
        column(columns: string[]): { findById(id: number): Promise<PageRecord | null> }
        findById(id: number): Promise<PageRecord | null>
      }
    }
    pageHistory: { getVersion(input: { pageId: number; versionId: number }): Promise<PageRecord> }
    users: { getUserAvatarData(userId: string): Promise<unknown> }
    navigation: {
      getTree(input: { cache: boolean; locale: string; groups: unknown[] }): Promise<NavigationItem[]>
    }
    assets: { getAsset(path: string, response: Response): Promise<unknown> }
  }
  data: {
    commentProvider: { codeTemplate: string; head: string; body: string; main: string }
  }
}

interface RequestI18n {
  changeLanguage(locale: string): void
  dir(): string
}

const WIKI = globalThis.WIKI as unknown as CommonWiki
const getWikiAuth = () => WIKI.auth

const getRequestI18n = (req: Request): RequestI18n => {
  const i18n: unknown = (req as Request & { i18n?: unknown }).i18n
  if (
    typeof i18n !== 'object' ||
    i18n === null ||
    !('changeLanguage' in i18n) ||
    typeof i18n.changeLanguage !== 'function' ||
    !('dir' in i18n) ||
    typeof i18n.dir !== 'function'
  ) {
    throw new Error('Request internationalization context is unavailable')
  }
  return i18n as RequestI18n
}
const requesterId = (req: Request): number => typeof req.user?.id === 'number' ? req.user.id : 2

const parsePageArgs = (req: Request, stripExt = false): ParsedPageArgs => {
  const parsed = pageHelper.parsePath(req.path, { stripExt })
  const segments = parsed.path.split('/')
  const privateLocale = segments[1]
  if (segments[0] === '_private' && privateLocale && segments.length > 2) {
    return {
      locale: privateLocale,
      path: segments.slice(2).join('/'),
      visibility: 'private',
      ownerId: principalId(req.user),
      explicitLocale: true
    }
  }
  return {
    ...parsed,
    visibility: 'public',
    ownerId: null
  }
}

const applyPrivatePermissions = (
  req: Request,
  page: PageRecord,
  permissions: EffectivePermissions
): boolean => {
  if (page.visibility !== 'private') return true
  if (!canReadPage(req.user, page)) return false
  permissions.pages.read = true
  permissions.pages.write = canWritePage(req.user, page)
  permissions.pages.manage = permissions.pages.write
  permissions.history.read = true
  permissions.source.read = true
  return true
}

const requesterGroups = (req: Request): unknown[] => Array.isArray(req.user?.groups) ? req.user.groups : []

const stringifyQuery = (query: Request['query']): string => {
  const values: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') {
      values[key] = value
    } else if (Array.isArray(value)) {
      values[key] = value.map(item => typeof item === 'string' ? item : '')
    } else {
      values[key] = ''
    }
  }
  return qs.stringify(values)
}

const renderResolvedPage = async (
  req: Request,
  res: Response,
  pageArgs: ParsedPageArgs,
  page: PageRecord,
  effectivePermissions: EffectivePermissions
): Promise<unknown> => {
  const i18n = getRequestI18n(req)
  i18n.changeLanguage(pageArgs.locale)
  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', i18n.dir() === 'rtl')
  _.set(res.locals, 'pageMeta.title', page.title)
  _.set(res.locals, 'pageMeta.description', page.description)

  let pageIsPublished = page.isPublished
  if (pageIsPublished && !_.isEmpty(page.publishStartDate)) {
    pageIsPublished = moment(page.publishStartDate).isSameOrBefore()
  }
  if (pageIsPublished && !_.isEmpty(page.publishEndDate)) {
    pageIsPublished = moment(page.publishEndDate).isSameOrAfter()
  }
  if (!pageIsPublished && !effectivePermissions.pages.write) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  let sidebarIndex = 1
  const sidebar = (await WIKI.models.navigation.getTree({
    cache: true,
    locale: pageArgs.locale,
    groups: requesterGroups(req)
  })).map(item => ({
    i: `sdi-${sidebarIndex++}`,
    k: item.kind,
    l: item.label,
    c: item.icon,
    y: item.targetType,
    t: item.target
  }))

  const injectCode = {
    css: WIKI.config.theming.injectCSS,
    head: WIKI.config.theming.injectHead,
    body: WIKI.config.theming.injectBody
  }
  page.extra = page.extra || { css: '', js: '' }
  if (!_.isEmpty(page.extra.css)) injectCode.css = `${injectCode.css}\n${page.extra.css}`
  if (!_.isEmpty(page.extra.js)) injectCode.body = `${injectCode.body}\n${page.extra.js}`
  if (!_.isString(page.toc)) page.toc = JSON.stringify(page.toc)

  const commentTmpl = {
    codeTemplate: WIKI.data.commentProvider.codeTemplate,
    head: WIKI.data.commentProvider.head,
    body: WIKI.data.commentProvider.body,
    main: WIKI.data.commentProvider.main
  }
  if (WIKI.config.features.featurePageComments && WIKI.data.commentProvider.codeTemplate) {
    for (const cfg of [
      { key: 'pageUrl', value: `${WIKI.config.host}/i/${page.id}` },
      { key: 'pageId', value: page.id }
    ]) {
      commentTmpl.head = _.replace(commentTmpl.head, new RegExp(`{{${cfg.key}}}`, 'g'), String(cfg.value))
      commentTmpl.body = _.replace(commentTmpl.body, new RegExp(`{{${cfg.key}}}`, 'g'), String(cfg.value))
      commentTmpl.main = _.replace(commentTmpl.main, new RegExp(`{{${cfg.key}}}`, 'g'), String(cfg.value))
    }
  }

  let pageFilename = WIKI.config.lang.namespacing ? `${pageArgs.locale}/${page.path}` : page.path
  pageFilename += page.contentType === 'markdown' ? '.md' : '.html'
  return res.render('page', {
    page,
    sidebar,
    injectCode,
    comments: commentTmpl,
    effectivePermissions,
    pageFilename
  })
}



/**
 * Robots.txt
 */
router.get('/robots.txt', (req, res) => {
  res.type('text/plain')
  if (_.includes(WIKI.config.seo.robots, 'noindex')) {
    res.send('User-agent: *\nDisallow: /')
  } else {
    res.status(200).end()
  }
})

/**
 * Health Endpoint
 */
router.get('/healthz', (req, res) => {
  if (WIKI.models.knex.client.pool.numFree() < 1 && WIKI.models.knex.client.pool.numUsed() < 1) {
    res.status(503).json({ ok: false }).end()
  } else {
    res.status(200).json({ ok: true }).end()
  }
})

/**
 * Metrics (Prometheus)
 */
router.get('/metrics', async (req, res, next) => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system'])) {
    return res.sendStatus(403)
  }

  if (WIKI.config.metrics.isEnabled) {
    return WIKI.metrics.render(res)
  }

  return next()
})

/**
 * Administration
 */
router.get(['/a', '/a/*adminPath'], (req, res) => {
  if (!getWikiAuth().checkAccess(req.user, [
    'manage:system',
    'write:users',
    'manage:users',
    'write:groups',
    'manage:groups',
    'manage:navigation',
    'manage:theme',
    'manage:api'
  ])) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  _.set(res.locals, 'pageMeta.title', 'Admin')
  res.render('admin')
})

/**
 * Explicit private-page inspection for system administrators.
 */
router.get('/_admin/private/:id', async (req, res) => {
  if (!managesSystem(req.user)) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }
  const pageId = _.toSafeInteger(req.params.id)
  const page = pageId > 0 ? await WIKI.models.pages.getPageFromDb(pageId) : null
  if (!page || page.visibility !== 'private') {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }
  const pageArgs: ParsedPageArgs = {
    locale: page.localeCode,
    path: page.path,
    visibility: 'private',
    ownerId: page.ownerId,
    explicitLocale: true,
    tags: page.tags
  }
  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)
  if (!applyPrivatePermissions(req, page, effectivePermissions)) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }
  return renderResolvedPage(req, res, pageArgs, page, effectivePermissions)
})

/**
 * Download Page / Version
 */
router.get(['/d', '/d/*downloadPath'], async (req, res) => {
  const pageArgs = parsePageArgs(req, true)
  const versionValue: unknown = req.query.v
  const versionId = typeof versionValue === 'string' ? _.toSafeInteger(versionValue) : 0

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    visibility: pageArgs.visibility,
    ownerId: pageArgs.ownerId
  })

  if (!page || (page.visibility === 'private' && !canReadPage(req.user, page))) {
    return res.status(404).end()
  }

  pageArgs.tags = _.get(page, 'tags', [])

  if (versionId > 0) {
    if (page.visibility === 'public' && !getWikiAuth().checkAccess(req.user, ['read:history'], pageArgs)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'downloadVersion' })
    }
  } else if (page.visibility === 'public' && !getWikiAuth().checkAccess(req.user, ['read:source'], pageArgs)) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.status(403).render('unauthorized', { action: 'download' })
  }

  const fileName = _.last(page.path.split('/')) + '.' + pageHelper.getFileExtension(page.contentType)
  res.attachment(fileName)
  if (versionId > 0) {
    const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: page.id, versionId })
    res.send(pageHelper.injectPageMetadata(pageVersion))
  } else {
    res.send(pageHelper.injectPageMetadata(page))
  }
})

/**
 * Create/Edit document
 */
router.get(['/e', '/e/*editorPath'], async (req, res, next) => {
  const pageArgs = parsePageArgs(req, true)

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/e/${pageArgs.locale}/${pageArgs.path}`)
  }

  const i18n = getRequestI18n(req)
  i18n.changeLanguage(pageArgs.locale)

  // -> Set Editor Lang
  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', i18n.dir() === 'rtl')

  // -> Check for reserved path
  if (pageHelper.isReservedPath(pageArgs.path)) {
    return next(new Error('Cannot create this page because it starts with a system reserved path.'))
  }

  // -> Get page data from DB
  const storedPage = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    visibility: pageArgs.visibility,
    ownerId: pageArgs.ownerId
  })
  let page: EditorPage | null = storedPage == null ? null : storedPage as EditorPage
  if (page) page.extra ??= { css: '', js: '' }

  pageArgs.tags = _.get(page, 'tags', [])

  // -> Effective Permissions
  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)
  if (page && !applyPrivatePermissions(req, page as PageRecord, effectivePermissions)) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'edit' })
  }
  if (!page && pageArgs.visibility === 'private' && pageArgs.ownerId !== null) {
    effectivePermissions.pages.write = true
  }

  const injectCode = {
    css: WIKI.config.theming.injectCSS,
    head: WIKI.config.theming.injectHead,
    body: WIKI.config.theming.injectBody
  }

  if (page) {
    // -> EDIT MODE
    if (!(effectivePermissions.pages.write || effectivePermissions.pages.manage)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'edit' })
    }

    // -> Get page tags
    if (!page.$relatedQuery) throw new Error('Page relation loader is unavailable')
    await page.$relatedQuery('tags')
    page.tags = (page.tags ?? []).map(tag => typeof tag === 'string' ? tag : tag.tag)

    // Handle missing extra field
    page.extra = page.extra || { css: '', js: '' }

    // -> Beautify Script CSS
    if (!_.isEmpty(page.extra.css)) {
      page.extra.css = new CleanCSS({ format: 'beautify' }).minify(page.extra.css).styles
    }

    _.set(res.locals, 'pageMeta.title', `Edit ${page.title}`)
    _.set(res.locals, 'pageMeta.description', page.description)
    page.mode = 'update'
    page.isPublished = (page.isPublished === true || page.isPublished === 1) ? 'true' : 'false'
    if (typeof page.content !== 'string') throw new Error('Page content is invalid')
    page.content = Buffer.from(page.content).toString('base64')
  } else {
    // -> CREATE MODE
    if (!effectivePermissions.pages.write) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'create' })
    }

    _.set(res.locals, 'pageMeta.title', `New Page`)
    page = {
      path: pageArgs.path,
      localeCode: pageArgs.locale,
      visibility: pageArgs.visibility,
      ownerId: pageArgs.ownerId,
      editorKey: null,
      mode: 'create',
      content: null,
      title: null,
      description: null,
      updatedAt: new Date().toISOString(),
      extra: {
        css: '',
        js: ''
      }
    }

    // -> From Template
    const templateValue: unknown = req.query.from
    if (typeof templateValue === 'string' && tmplCreateRegex.test(templateValue)) {
      let tmplPageId: number
      let tmplVersionId = 0
      if (templateValue.includes(',')) {
        const q = templateValue.split(',')
        tmplPageId = _.toSafeInteger(q[0])
        tmplVersionId = _.toSafeInteger(q[1])
      } else {
        tmplPageId = _.toSafeInteger(templateValue)
      }

      if (tmplVersionId > 0) {
        // -> From Page Version
        const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: tmplPageId, versionId: tmplVersionId })
        if (!pageVersion) {
          _.set(res.locals, 'pageMeta.title', 'Page Not Found')
          return res.status(404).render('notfound', { action: 'template' })
        }
        if (!canReadPage(req.user, pageVersion)) {
          _.set(res.locals, 'pageMeta.title', 'Page Not Found')
          return res.status(404).render('notfound', { action: 'template' })
        }
        page.content = Buffer.from(pageVersion.content).toString('base64')
        page.editorKey = pageVersion.editor
        page.title = pageVersion.title
        page.description = pageVersion.description
      } else {
        // -> From Page Live
        const pageOriginal = await WIKI.models.pages.query().findById(tmplPageId)
        if (!pageOriginal) {
          _.set(res.locals, 'pageMeta.title', 'Page Not Found')
          return res.status(404).render('notfound', { action: 'template' })
        }
        if (!canReadPage(req.user, pageOriginal)) {
          _.set(res.locals, 'pageMeta.title', 'Page Not Found')
          return res.status(404).render('notfound', { action: 'template' })
        }
        page.content = Buffer.from(pageOriginal.content).toString('base64')
        page.editorKey = pageOriginal.editorKey
        page.title = pageOriginal.title
        page.description = pageOriginal.description
      }
    }
  }

  res.render('editor', { page, injectCode, effectivePermissions })
})

/**
 * History
 */
router.get(['/h', '/h/*historyPath'], async (req, res) => {
  const pageArgs = parsePageArgs(req, true)

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/h/${pageArgs.locale}/${pageArgs.path}`)
  }

  const i18n = getRequestI18n(req)
  i18n.changeLanguage(pageArgs.locale)

  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', i18n.dir() === 'rtl')

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    visibility: pageArgs.visibility,
    ownerId: pageArgs.ownerId
  })

  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'history' })
  }

  pageArgs.tags = _.get(page, 'tags', [])

  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)
  if (!applyPrivatePermissions(req, page, effectivePermissions)) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'history' })
  }

  if (!effectivePermissions.history.read) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.render('unauthorized', { action: 'history' })
  }

  if (page) {
    _.set(res.locals, 'pageMeta.title', page.title)
    _.set(res.locals, 'pageMeta.description', page.description)

    res.render('history', { page, effectivePermissions })
  } else {
    res.redirect(`/${pageArgs.path}`)
  }
})

/**
 * Page ID redirection
 */
router.get(['/i', '/i/:id'], async (req, res) => {
  const pageId = _.toSafeInteger(req.params.id)
  if (pageId <= 0) {
    return res.redirect('/')
  }

  const page = await WIKI.models.pages.query().column(['id', 'path', 'localeCode', 'visibility', 'ownerId']).findById(pageId)
  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }
  if (page.visibility === 'private') {
    if (principalId(req.user) === page.ownerId) return res.redirect(pageRoute(page))
    if (managesSystem(req.user)) return res.redirect(`/_admin/private/${page.id}`)
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }
  if (!canReadPage(req.user, page)) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }
  if (WIKI.config.lang.namespacing) {
    return res.redirect(`/${page.localeCode}/${page.path}`)
  }
  return res.redirect(`/${page.path}`)
})

/**
 * Profile
 */
router.get(['/p', '/p/*profilePath'], (req, res) => {
  const userId = req.user?.id
  if (typeof userId !== 'number' || userId < 1 || userId === 2) {
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  _.set(res.locals, 'pageMeta.title', 'User Profile')
  res.render('profile')
})

/**
 * Source
 */
router.get(['/s', '/s/*sourcePath'], async (req, res) => {
  const pageArgs = parsePageArgs(req, true)
  const versionValue: unknown = req.query.v
  const versionId = typeof versionValue === 'string' ? _.toSafeInteger(versionValue) : 0

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    visibility: pageArgs.visibility,
    ownerId: pageArgs.ownerId
  })

  pageArgs.tags = _.get(page, 'tags', [])

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/s/${pageArgs.locale}/${pageArgs.path}`)
  }

  // -> Effective Permissions
  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)
  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'source' })
  }
  if (!applyPrivatePermissions(req, page, effectivePermissions)) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'source' })
  }

  const i18n = getRequestI18n(req)
  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', i18n.dir() === 'rtl')

  if (versionId > 0) {
    if (!effectivePermissions.history.read) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'sourceVersion' })
    }
  } else {
    if (!effectivePermissions.source.read) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'source' })
    }
  }

  if (page) {
    if (versionId > 0) {
      const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: page.id, versionId })
      _.set(res.locals, 'pageMeta.title', pageVersion.title)
      _.set(res.locals, 'pageMeta.description', pageVersion.description)
      res.render('source', {
        page: {
          ...page,
          ...pageVersion
        },
        effectivePermissions
      })
    } else {
      _.set(res.locals, 'pageMeta.title', page.title)
      _.set(res.locals, 'pageMeta.description', page.description)

      res.render('source', { page, effectivePermissions })
    }
  } else {
    res.redirect(`/${pageArgs.path}`)
  }
})

/**
 * Tags
 */
router.get(['/t', '/t/*tagPath'], (req, res) => {
  _.set(res.locals, 'pageMeta.title', 'Tags')
  res.render('tags')
})

/**
 * User Avatar
 */
router.get('/_userav/:uid', async (req, res) => {
  if (!getWikiAuth().checkAccess(req.user, ['read:pages'])) {
    return res.sendStatus(403)
  }
  const av = await WIKI.models.users.getUserAvatarData(req.params.uid)
  if (av) {
    res.set('Content-Type', 'image/jpeg')
    res.send(av)
  }

  return res.sendStatus(404)
})

/**
 * View document / asset
 */
router.get('/{*pagePath}', async (req, res, next) => {
  const stripExt = _.some(WIKI.config.pageExtensions, ext => _.endsWith(req.path, `.${ext}`))
  const pageArgs = parsePageArgs(req, stripExt)
  const isPage = (stripExt || pageArgs.path.indexOf('.') === -1)

  if (isPage) {
    if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
      const query = !_.isEmpty(req.query) ? `?${stringifyQuery(req.query)}` : ''
      return res.redirect(`/${pageArgs.locale}/${pageArgs.path}${query}`)
    }

    const i18n = getRequestI18n(req)
    i18n.changeLanguage(pageArgs.locale)

    try {
      // -> Get Page from cache
      const page = await WIKI.models.pages.getPage({
        path: pageArgs.path,
        locale: pageArgs.locale,
        visibility: pageArgs.visibility,
        ownerId: pageArgs.ownerId
      })
      pageArgs.tags = _.get(page, 'tags', [])

      // -> Effective Permissions
      const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)
      if (page && !applyPrivatePermissions(req, page, effectivePermissions)) {
        _.set(res.locals, 'pageMeta.title', 'Page Not Found')
        return res.status(404).render('notfound', { action: 'view' })
      }
      if (!page && pageArgs.visibility === 'private') {
        _.set(res.locals, 'pageMeta.title', 'Page Not Found')
        return res.status(404).render('notfound', { action: 'view' })
      }

      // -> Check User Access
      if (!effectivePermissions.pages.read) {
        if (requesterId(req) === 2) {
          res.cookie('loginRedirect', req.path, {
            maxAge: 15 * 60 * 1000
          })
        }
        if (pageArgs.path === 'home' && requesterId(req) === 2) {
          return res.redirect('/login')
        }
        _.set(res.locals, 'pageMeta.title', 'Unauthorized')
        return res.status(403).render('unauthorized', {
          action: 'view'
        })
      }

      _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
      _.set(res, 'locals.siteConfig.rtl', i18n.dir() === 'rtl')

      if (page) {
        return renderResolvedPage(req, res, pageArgs, page, effectivePermissions)
      } else if (pageArgs.path === 'home') {
        _.set(res.locals, 'pageMeta.title', 'Welcome')
        res.render('welcome', { locale: pageArgs.locale })
      } else {
        _.set(res.locals, 'pageMeta.title', 'Page Not Found')
        if (effectivePermissions.pages.write) {
          res.status(404).render('new', { path: pageArgs.path, locale: pageArgs.locale })
        } else {
          res.status(404).render('notfound', { action: 'view' })
        }
      }
    } catch (err) {
      next(err)
    }
  } else {
    if (!getWikiAuth().checkAccess(req.user, ['read:assets'], pageArgs)) {
      return res.sendStatus(403)
    }

    await WIKI.models.assets.getAsset(pageArgs.path, res)
  }
})

export default router
