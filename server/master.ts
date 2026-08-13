import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express'
import session from 'express-session'
import { ConnectSessionKnexStore } from 'connect-session-knex'
import type { Knex } from 'knex'
import favicon from 'serve-favicon'
import path from 'node:path'
import _ from 'lodash'

import authCore from './core/auth.ts'
import localization from './core/localization.ts'
import mail from './core/mail.ts'
import system from './core/system.ts'
import viteAssets from './helpers/vite-assets.ts'
import securityMiddleware from './middlewares/security.ts'
import seoMiddleware from './middlewares/seo.ts'
import authController from './controllers/auth.ts'
import uploadController from './controllers/upload.ts'
import commonController from './controllers/common.ts'
import sslController from './controllers/ssl.ts'
import apiController from './controllers/api/index.ts'

const { collectEntry } = viteAssets


interface MasterConfig extends Record<string, unknown> {
  auth: Record<string, unknown>
  bodyParserLimit?: string
  company: string
  contentLicense: string
  description: string
  footerOverride: string
  host: string
  lang: { code: string; rtl: boolean }
  logoUrl: string
  port: number | string
  security: { securityTrustProxy: boolean }
  sessionSecret: string
  ssl: { enabled: boolean | number | string }
  title: string
  theming: { darkMode: boolean; theme: string; tocPosition?: string }
}

interface WikiAuth {
  authenticate: RequestHandler
  passport: { initialize(): RequestHandler }
}

interface MasterWiki extends Record<string, unknown> {
  IS_DEBUG: boolean
  ROOTPATH: string
  SERVERPATH: string
  app: Express
  asar: { serve(asset: string, ...args: Parameters<RequestHandler>): void }
  auth: WikiAuth
  config: MasterConfig
  lang: { attachMiddleware(app: Express): void }
  mail: unknown
  models: {
    analytics: { getCode(options: { cache: boolean }): Promise<unknown> }
    knex: Knex
    locales: { getNavLocales(options: { cache: boolean }): Promise<unknown> }
  }
  servers: { startGraphQL(): Promise<void>; startHTTP(): Promise<void>; startHTTPS(): Promise<void> }
  system: unknown
}

interface HttpError extends Error {
  status: number
}

const wiki = WIKI as MasterWiki

export default async function startMaster(): Promise<true> {
  wiki.lang = localization.init()
  wiki.auth = authCore.init()
  wiki.mail = mail.init()
  wiki.system = system.init()

  const app = express()
  wiki.app = app
  app.use(compression())

  app.use(securityMiddleware)
  app.use(cors({ origin: false }))
  app.options('/{*corsPreflightPath}', cors({ origin: false }))
  if (wiki.config.security.securityTrustProxy) {
    app.enable('trust proxy')
  }

  app.use(favicon(path.join(wiki.ROOTPATH, 'assets', 'favicon.ico')))
  app.use('/_assets/svg/twemoji', async (req, res, next) => {
    try {
      wiki.asar.serve('twemoji', req, res, next)
    } catch {
      res.sendStatus(404)
    }
  })
  app.use('/_assets', express.static(path.join(wiki.ROOTPATH, 'assets'), {
    index: false,
    maxAge: '7d'
  }))

  app.use('/', sslController)

  app.use(cookieParser())
  app.use(session({
    secret: wiki.config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new ConnectSessionKnexStore({
      knex: wiki.models.knex
    })
  }))
  app.use(wiki.auth.passport.initialize())
  app.use(wiki.auth.authenticate.bind(wiki.auth))

  await wiki.servers.startGraphQL()
  app.use(express.json({ limit: wiki.config.bodyParserLimit || '1mb' }))
  app.use('/_api', apiController)

  app.use(seoMiddleware)

  app.set('views', path.join(wiki.SERVERPATH, 'views'))
  app.set('view engine', 'pug')
  app.use(express.urlencoded({ extended: false, limit: '1mb' }))

  wiki.lang.attachMiddleware(app)

  app.locals.siteConfig = {}
  app.locals.analyticsCode = {}
  app.locals.basedir = wiki.ROOTPATH
  app.locals.config = wiki.config
  app.locals.pageMeta = {
    title: '',
    description: wiki.config.description,
    image: '',
    url: '/'
  }
  const viteOrigin = process.env.WIKI_VITE_ORIGIN
  app.locals.vite = collectEntry('client/index-app.ts', {
    dev: wiki.IS_DEBUG,
    ...(viteOrigin === undefined ? {} : { origin: viteOrigin })
  })

  app.use(async (_req, res, next) => {
    res.locals.siteConfig = {
      title: wiki.config.title,
      theme: wiki.config.theming.theme,
      darkMode: wiki.config.theming.darkMode,
      tocPosition: wiki.config.theming.tocPosition || 'left',
      lang: wiki.config.lang.code,
      rtl: wiki.config.lang.rtl,
      company: wiki.config.company,
      contentLicense: wiki.config.contentLicense,
      footerOverride: wiki.config.footerOverride,
      logoUrl: wiki.config.logoUrl
    }
    res.locals.langs = await wiki.models.locales.getNavLocales({ cache: true })
    res.locals.analyticsCode = await wiki.models.analytics.getCode({ cache: true })
    next()
  })

  app.use('/', authController)
  app.use('/', uploadController)
  app.use('/', commonController)

  app.use((_req, _res, next) => {
    const error = new Error('Not Found') as HttpError
    error.status = 404
    next(error)
  })

  const handleError: ErrorRequestHandler = (error: HttpError, req, res, _next) => {
    void _next
    if (req.path === '/graphql') {
      res.status(error.status || 500).json({
        data: {},
        errors: [{
          message: error.message,
          path: []
        }]
      })
      return
    }

    res.status(error.status || 500)
    _.set(res.locals, 'pageMeta.title', 'Error')
    res.render('error', {
      message: error.message,
      error: wiki.IS_DEBUG ? error : {}
    })
  }
  app.use(handleError)

  await wiki.servers.startHTTP()
  if (wiki.config.ssl.enabled === true || wiki.config.ssl.enabled === 'true' || wiki.config.ssl.enabled === 1 || wiki.config.ssl.enabled === '1') {
    await wiki.servers.startHTTPS()
  }

  return true
}
