import express from 'express'
import { type Request, type Response } from './_types.ts'
import pageHelper from '../helpers/page.ts'
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
  private: boolean
  privateNS: string
  explicitLocale: boolean
  tags?: unknown
}

interface PageRecord {
  id: number
  path: string
  locale: string
  localeCode: string
  isPrivate: boolean
  privateNS: string
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
      getPageFromDb(input: { path: string; locale: string; userId: number; isPrivate: boolean }): Promise<PageRecord | null>
      getPage(input: { path: string; locale: string; userId: number; isPrivate: boolean }): Promise<PageRecord | null>
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
 * Download Page / Version
 */
router.get(['/d', '/d/*downloadPath'], async (req, res) => {
  const pageArgs: ParsedPageArgs = pageHelper.parsePath(req.path, { stripExt: true })
  const versionValue: unknown = req.query.v
  const versionId = typeof versionValue === 'string' ? _.toSafeInteger(versionValue) : 0

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    userId: requesterId(req),
    isPrivate: false
  })

  pageArgs.tags = _.get(page, 'tags', [])

  if (versionId > 0) {
    if (!getWikiAuth().checkAccess(req.user, ['read:history'], pageArgs)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'downloadVersion' })
    }
  } else {
    if (!getWikiAuth().checkAccess(req.user, ['read:source'], pageArgs)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'download' })
    }
  }

  if (page) {
    const fileName = _.last(page.path.split('/')) + '.' + pageHelper.getFileExtension(page.contentType)
    res.attachment(fileName)
    if (versionId > 0) {
      const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: page.id, versionId })
      res.send(pageHelper.injectPageMetadata(pageVersion))
    } else {
      res.send(pageHelper.injectPageMetadata(page))
    }
  } else {
    res.status(404).end()
  }
})

/**
 * Create/Edit document
 */
router.get(['/e', '/e/*editorPath'], async (req, res, next) => {
  const pageArgs: ParsedPageArgs = pageHelper.parsePath(req.path, { stripExt: true })

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
    userId: requesterId(req),
    isPrivate: false
  })
  let page: EditorPage | null = storedPage == null ? null : storedPage as EditorPage
  if (page) page.extra ??= { css: '', js: '' }

  pageArgs.tags = _.get(page, 'tags', [])

  // -> Effective Permissions
  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)

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
        if (!getWikiAuth().checkAccess(req.user, ['read:history'], { path: pageVersion.path, locale: pageVersion.locale })) {
          _.set(res.locals, 'pageMeta.title', 'Unauthorized')
          return res.status(403).render('unauthorized', { action: 'sourceVersion' })
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
        if (!getWikiAuth().checkAccess(req.user, ['read:source'], { path: pageOriginal.path, locale: pageOriginal.locale })) {
          _.set(res.locals, 'pageMeta.title', 'Unauthorized')
          return res.status(403).render('unauthorized', { action: 'source' })
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
  const pageArgs: ParsedPageArgs = pageHelper.parsePath(req.path, { stripExt: true })

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
    userId: requesterId(req),
    isPrivate: false
  })

  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'history' })
  }

  pageArgs.tags = _.get(page, 'tags', [])

  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)

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

  const page = await WIKI.models.pages.query().column(['path', 'localeCode', 'isPrivate', 'privateNS']).findById(pageId)
  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }

  if (!getWikiAuth().checkAccess(req.user, ['read:pages'], {
    locale: page.localeCode,
    path: page.path,
    private: page.isPrivate,
    privateNS: page.privateNS,
    explicitLocale: false,
    tags: page.tags
  })) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  if (WIKI.config.lang.namespacing) {
    return res.redirect(`/${page.localeCode}/${page.path}`)
  } else {
    return res.redirect(`/${page.path}`)
  }
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
  const pageArgs: ParsedPageArgs = pageHelper.parsePath(req.path, { stripExt: true })
  const versionValue: unknown = req.query.v
  const versionId = typeof versionValue === 'string' ? _.toSafeInteger(versionValue) : 0

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    userId: requesterId(req),
    isPrivate: false
  })

  pageArgs.tags = _.get(page, 'tags', [])

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/s/${pageArgs.locale}/${pageArgs.path}`)
  }

  // -> Effective Permissions
  const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)

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
  const pageArgs: ParsedPageArgs = pageHelper.parsePath(req.path, { stripExt })
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
        userId: requesterId(req),
        isPrivate: false
      })
      pageArgs.tags = _.get(page, 'tags', [])

      // -> Effective Permissions
      const effectivePermissions = getWikiAuth().getEffectivePermissions(req, pageArgs)

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
        _.set(res.locals, 'pageMeta.title', page.title)
        _.set(res.locals, 'pageMeta.description', page.description)

        // -> Check Publishing State
        let pageIsPublished = page.isPublished
        if (pageIsPublished && !_.isEmpty(page.publishStartDate)) {
          pageIsPublished = moment(page.publishStartDate).isSameOrBefore()
        }
        if (pageIsPublished && !_.isEmpty(page.publishEndDate)) {
          pageIsPublished = moment(page.publishEndDate).isSameOrAfter()
        }
        if (!pageIsPublished && !effectivePermissions.pages.write) {
          _.set(res.locals, 'pageMeta.title', 'Unauthorized')
          return res.status(403).render('unauthorized', {
            action: 'view'
          })
        }

        // -> Build sidebar navigation
        let sdi = 1
        const sidebar = (await WIKI.models.navigation.getTree({ cache: true, locale: pageArgs.locale, groups: requesterGroups(req) })).map(n => ({
          i: `sdi-${sdi++}`,
          k: n.kind,
          l: n.label,
          c: n.icon,
          y: n.targetType,
          t: n.target
        }))

        // -> Build theme code injection
        const injectCode = {
          css: WIKI.config.theming.injectCSS,
          head: WIKI.config.theming.injectHead,
          body: WIKI.config.theming.injectBody
        }

        // Handle missing extra field
        page.extra = page.extra || { css: '', js: '' }

        if (!_.isEmpty(page.extra.css)) {
          injectCode.css = `${injectCode.css}\n${page.extra.css}`
        }

        if (!_.isEmpty(page.extra.js)) {
          injectCode.body = `${injectCode.body}\n${page.extra.js}`
        }

        const userAgent = req.get('user-agent')
        if (req.query.legacy || userAgent?.includes('Trident')) {
          // -> Convert page TOC
          if (_.isString(page.toc)) {
            page.toc = JSON.parse(page.toc)
          }

          // -> Render legacy view
          res.render('legacy/page', {
            page,
            sidebar,
            injectCode,
            isAuthenticated: requesterId(req) !== 2
          })
        } else {
          // -> Convert page TOC
          if (!_.isString(page.toc)) {
            page.toc = JSON.stringify(page.toc)
          }

          // -> Inject comments variables
          const commentTmpl = {
            codeTemplate: WIKI.data.commentProvider.codeTemplate,
            head: WIKI.data.commentProvider.head,
            body: WIKI.data.commentProvider.body,
            main: WIKI.data.commentProvider.main
          }
          if (WIKI.config.features.featurePageComments && WIKI.data.commentProvider.codeTemplate) {
            [
              { key: 'pageUrl', value: `${WIKI.config.host}/i/${page.id}` },
              { key: 'pageId', value: page.id }
            ].forEach((cfg) => {
              commentTmpl.head = _.replace(commentTmpl.head, new RegExp(`{{${cfg.key}}}`, 'g'), String(cfg.value))
              commentTmpl.body = _.replace(commentTmpl.body, new RegExp(`{{${cfg.key}}}`, 'g'), String(cfg.value))
              commentTmpl.main = _.replace(commentTmpl.main, new RegExp(`{{${cfg.key}}}`, 'g'), String(cfg.value))
            })
          }

          // -> Page Filename (for edit on external repo button)
          let pageFilename = WIKI.config.lang.namespacing ? `${pageArgs.locale}/${page.path}` : page.path
          pageFilename += page.contentType === 'markdown' ? '.md' : '.html'

          // -> Render view
          res.render('page', {
            page,
            sidebar,
            injectCode,
            comments: commentTmpl,
            effectivePermissions,
            pageFilename
          })
        }
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
