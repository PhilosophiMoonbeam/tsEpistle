import path from 'node:path'
import { randomUUID, generateKeyPairSync, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import type { Socket } from 'node:net'
import compression from 'compression'
import express, { type ErrorRequestHandler } from 'express'
import favicon from 'serve-favicon'
import http from 'node:http'
import fs from 'fs-extra'
import _ from 'lodash'
import pemJwk from 'pem-jwk'
import semver from 'semver'

import viteAssets from './helpers/vite-assets.ts'
import system from './core/system.ts'

import { BUILTIN_CONTENT_EXTENSIONS } from '../shared/content-extensions.ts'
import type { ProductMetadata } from '../shared/product.ts'
import { cloneThemeColors, DEFAULT_THEME_COLORS } from '../shared/theme-colors.ts'
import { DEFAULT_PAGE_GUTTER_STYLE } from '../shared/page-gutters.ts'
const { collectEntry } = viteAssets
const randomBytesAsync = promisify(randomBytes)
const { pem2jwk } = pemJwk

interface SetupConfig extends Record<string, unknown> {
  bindIP: string
  dataPath: string
  db: { type: string }
  port: number
  sessionSecret: string
  setup: boolean
  site: { path: string; title: string }
  telemetry: { isEnabled: boolean }
}

interface MutationQuery extends PromiseLike<unknown> {
  where(column: string, operator: string, value: unknown): MutationQuery
  where(column: string, value: unknown): MutationQuery
  orWhere(column: string, value: unknown): MutationQuery
  del(): Promise<number>
  truncate(): Promise<number>
}

interface ModelQuery<T> extends PromiseLike<T[]> {
  where(column: string, operator: string, value: unknown): ModelQuery<T>
  where(column: string, value: unknown): ModelQuery<T>
  insert(value: Record<string, unknown>): Promise<T>
  patch(value: Record<string, unknown>): MutationQuery
  del(): Promise<number>
  truncate(): Promise<number>
}

interface RelatedUser {
  id: number
  $relatedQuery(relation: string): { relate(id: number): Promise<unknown> }
}

interface GroupRecord {
  id: number
}

interface SetupModels {
  analytics?: unknown
  authentication: { query(): ModelQuery<Record<string, unknown>> }
  editors: { refreshEditorsFromDisk(): Promise<void>; query(): ModelQuery<Record<string, unknown>> }
  groups: { query(): ModelQuery<GroupRecord> }
  knex: {
    (table: string): {
      insert(values: Record<string, unknown>[]): Promise<unknown>
      truncate(): Promise<unknown>
    }
    raw(statement: string): Promise<unknown>
  }
  locales: { query(): ModelQuery<Record<string, unknown>> }
  loggers: { refreshLoggersFromDisk(): Promise<void> }
  navigation: { query(): ModelQuery<Record<string, unknown>> }
  renderers: { refreshRenderersFromDisk(): Promise<void> }
  searchEngines: { refreshSearchEnginesFromDisk(): Promise<void>; query(): ModelQuery<Record<string, unknown>> }
  storage: { refreshTargetsFromDisk(): Promise<void> }
  users: { query(): ModelQuery<RelatedUser> }
}

interface DestroyableServer extends http.Server {
  destroy(callback: () => void): void
}

interface SetupWiki extends Record<string, unknown> {
  IS_DEBUG: boolean
  ROOTPATH: string
  SERVERPATH: string
  config: SetupConfig
  configSvc: { saveToDb(keys: string[], propagate?: boolean): Promise<unknown> }
  data: unknown
  kernel: { bootMaster(): void; initTelemetry(): void }
  logger: { error(value: unknown): void; info(message: string): void }
  product: ProductMetadata
  models: SetupModels
  server: DestroyableServer
  system: unknown
  telemetry: { sendError(error: unknown): void; sendInstanceEvent(event: string): Promise<void> }
}

interface HttpError extends Error {
  status: number
}

const wiki = WIKI as unknown as SetupWiki

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string') throw new Error(`Invalid setup field: ${key}`)
  return value
}

export default function startSetup(): void {
  wiki.config.site = {
    path: '',
    title: wiki.product.name
  }
  wiki.system = system

  const app = express()
  app.use(compression())
  app.use(favicon(path.join(wiki.ROOTPATH, 'assets', 'favicon.ico')))
  app.use('/_assets', express.static(path.join(wiki.ROOTPATH, 'assets')))

  app.set('views', path.join(wiki.SERVERPATH, 'views'))
  app.set('view engine', 'pug')
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  app.locals.config = wiki.config
  app.locals.data = wiki.data
  app.locals._ = _
  app.locals.product = wiki.product
  const viteOrigin = process.env.WIKI_VITE_ORIGIN
  app.locals.vite = collectEntry('client/index-setup.ts', {
    dev: wiki.IS_DEBUG,
    ...(viteOrigin === undefined ? {} : { origin: viteOrigin })
  })

  app.get('/{*setupPath}', (_req, res) => {
    res.render('setup')
  })

  app.post('/finalize', async (req, res) => {
    try {
      const body = bodyRecord(req.body as unknown)
      const siteUrl = requiredString(body, 'siteUrl')
      const adminEmail = requiredString(body, 'adminEmail')
      const adminPassword = requiredString(body, 'adminPassword')

      _.set(wiki.config, 'auth', {
        audience: 'urn:wiki.js',
        tokenExpiration: '30m',
        tokenRenewal: '14d'
      })
      _.set(wiki.config, 'company', '')
      _.set(wiki.config, 'features', {
        featurePageRatings: true,
        featurePageComments: true,
        featurePersonalWikis: true
      })
      _.set(wiki.config, 'graphEndpoint', 'https://graph.requarks.io')
      _.set(wiki.config, 'host', siteUrl)
      _.set(wiki.config, 'lang', { code: 'en', autoUpdate: true, namespacing: false, namespaces: [] })
      _.set(wiki.config, 'logo', { hasLogo: false, logoIsSquare: false })
      _.set(wiki.config, 'mail', {
        senderName: '', senderEmail: '', host: '', port: 465, name: '', secure: true, verifySSL: true,
        user: '', pass: '', useDKIM: false, dkimDomainName: '', dkimKeySelector: '', dkimPrivateKey: ''
      })
      _.set(wiki.config, 'seo', { description: '', robots: ['index', 'follow'], analyticsService: '', analyticsId: '' })
      _.set(wiki.config, 'sessionSecret', (await randomBytesAsync(32)).toString('hex'))
      _.set(wiki.config, 'telemetry', { isEnabled: body.telemetry === true, clientId: randomUUID() })
      _.set(wiki.config, 'theming', {
        theme: 'default',
        darkMode: false,
        colors: cloneThemeColors(DEFAULT_THEME_COLORS),
        iconset: 'mdi',
        tocPosition: 'left',
        gutterStyle: DEFAULT_PAGE_GUTTER_STYLE,
        gutterCustomCss: '',
        injectCSS: '',
        injectHead: '',
        injectBody: ''
      })
      _.set(wiki.config, 'title', wiki.product.name)

      wiki.kernel.initTelemetry()
      const bunVersion = process.versions.bun
      if (!bunVersion || !semver.satisfies(bunVersion, '>=1.3.14 <2')) {
        throw new Error('Bun 1.3.14 or later, but before Bun 2, is required!')
      }

      wiki.logger.info('Creating data directories...')
      await fs.ensureDir(path.resolve(wiki.ROOTPATH, wiki.config.dataPath))
      await fs.emptyDir(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'cache'))
      await fs.ensureDir(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'uploads'))

      wiki.logger.info('Generating certificates...')
      const certs = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: wiki.config.sessionSecret }
      })
      _.set(wiki.config, 'certs', {
        jwk: pem2jwk(certs.publicKey),
        public: certs.publicKey,
        private: certs.privateKey
      })

      wiki.logger.info('Persisting config to DB...')
      await wiki.configSvc.saveToDb([
        'auth', 'certs', 'company', 'features', 'graphEndpoint', 'host', 'lang', 'logo', 'mail', 'seo',
        'sessionSecret', 'telemetry', 'theming', 'uploads', 'title'
      ], false)

      await wiki.models.locales.query().where('code', '!=', 'x').del()
      await wiki.models.navigation.query().truncate()
      await wiki.models.knex.raw('TRUNCATE groups, users CASCADE')
      await wiki.models.knex('contentExtensions').insert(BUILTIN_CONTENT_EXTENSIONS.map(definition => ({
        key: definition.key,
        isEnabled: false,
        version: definition.version,
        updatedAt: new Date(),
        updatedBy: null
      })))

      wiki.logger.info('Installing default locale...')
      const defaultLocaleStrings: unknown = await fs.readJson(path.join(wiki.SERVERPATH, 'locales', 'en.json'))
      await wiki.models.locales.query().insert({
        code: 'en',
        strings: defaultLocaleStrings,
        isRTL: false,
        name: 'English',
        nativeName: 'English'
      })

      wiki.logger.info('Creating default groups...')
      const adminGroup = await wiki.models.groups.query().insert({
        name: 'Administrators', permissions: ['manage:system'], pageRules: [], isSystem: true
      })
      const guestGroup = await wiki.models.groups.query().insert({
        name: 'Guests', permissions: ['read:pages', 'read:assets', 'read:comments'],
        pageRules: [{ id: 'guest', roles: ['read:pages', 'read:assets', 'read:comments'], match: 'START', deny: false, path: '', locales: [] }],
        isSystem: true
      })
      if (adminGroup.id !== 1 || guestGroup.id !== 2) {
        throw new Error('Incorrect groups auto-increment configuration! Should start at 0 and increment by 1. Contact your database administrator.')
      }

      await wiki.models.authentication.query().insert({
        key: 'local', config: {}, selfRegistration: false, isEnabled: true, domainWhitelist: { v: [] },
        autoEnrollGroups: { v: [] }, order: 0, strategyKey: 'local', displayName: 'Local'
      })

      await wiki.models.editors.refreshEditorsFromDisk()
      await wiki.models.editors.query().patch({ isEnabled: true }).where('key', 'markdown')
      await wiki.models.loggers.refreshLoggersFromDisk()
      await wiki.models.renderers.refreshRenderersFromDisk()
      await wiki.models.searchEngines.refreshSearchEnginesFromDisk()
      await wiki.models.searchEngines.query().patch({ isEnabled: true }).where('key', 'db')
      await wiki.models.storage.refreshTargetsFromDisk()

      wiki.logger.info('Creating root administrator...')
      const adminUser = await wiki.models.users.query().insert({
        email: adminEmail.toLowerCase(), provider: 'local', password: adminPassword, name: 'Administrator', locale: 'en',
        defaultEditor: 'markdown', tfaIsActive: false, isActive: true, isVerified: true
      })
      await adminUser.$relatedQuery('groups').relate(adminGroup.id)

      wiki.logger.info('Creating guest account...')
      const guestUser = await wiki.models.users.query().insert({
        provider: 'local', email: 'guest@example.com', name: 'Guest', password: '', locale: 'en', defaultEditor: 'markdown',
        tfaIsActive: false, isSystem: true, isActive: true, isVerified: true
      })
      await guestUser.$relatedQuery('groups').relate(guestGroup.id)
      if (adminUser.id !== 1 || guestUser.id !== 2) {
        throw new Error('Incorrect users auto-increment configuration! Should start at 0 and increment by 1. Contact your database administrator.')
      }

      wiki.logger.info('Creating default site navigation')
      await wiki.models.navigation.query().insert({
        key: 'site',
        config: [{
          locale: 'en',
          items: [{
            id: randomUUID(), icon: 'mdi-home', kind: 'link', label: 'Home', target: '/', targetType: 'home',
            visibilityMode: 'all', visibilityGroups: null
          }]
        }]
      })

      wiki.logger.info('Setup is complete!')
      res.json({ ok: true, redirectPath: '/', redirectPort: wiki.config.port }).end()

      if (wiki.config.telemetry.isEnabled) await wiki.telemetry.sendInstanceEvent('INSTALL')
      wiki.config.setup = false

      wiki.logger.info('Stopping Setup...')
      wiki.server.destroy(() => {
        wiki.logger.info('Setup stopped. Starting tsFranki...')
        _.delay(() => wiki.kernel.bootMaster(), 1000)
      })
    } catch (error: unknown) {
      try {
        await wiki.models.knex('settings').truncate()
      } catch {
        // A failed first-time setup may not have a usable settings table yet.
      }
      wiki.telemetry.sendError(error)
      res.json({ ok: false, error: errorMessage(error) })
    }
  })

  app.use((_req, _res, next) => {
    const error = new Error('Not Found') as HttpError
    error.status = 404
    next(error)
  })

  const handleError: ErrorRequestHandler = (error: HttpError, _req, res, _next) => {
    void _req
    void _next
    res.status(error.status || 500)
    res.send({ message: error.message, error: wiki.IS_DEBUG ? error : {} })
    wiki.logger.error(error.message)
    wiki.telemetry.sendError(error)
  }
  app.use(handleError)

  wiki.logger.info(`Starting HTTP server on port ${wiki.config.port}...`)
  app.set('port', wiki.config.port)
  wiki.logger.info(`HTTP Server on port: [ ${wiki.config.port} ]`)

  const server = http.createServer(app) as DestroyableServer
  wiki.server = server
  server.listen(wiki.config.port, wiki.config.bindIP)

  const openConnections = new Map<string, Socket>()
  server.on('connection', connection => {
    const key = `${connection.remoteAddress}:${connection.remotePort}`
    openConnections.set(key, connection)
    connection.on('close', () => openConnections.delete(key))
  })
  server.destroy = callback => {
    server.close(callback)
    for (const connection of openConnections.values()) connection.destroy()
    openConnections.clear()
  }

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.syscall !== 'listen') throw error
    switch (error.code) {
      case 'EACCES':
        wiki.logger.error(`Listening on port ${wiki.config.port} requires elevated privileges!`)
        process.exit(1)
        return
      case 'EADDRINUSE':
        wiki.logger.error(`Port ${wiki.config.port} is already in use!`)
        process.exit(1)
        return
      default:
        throw error
    }
  })

  server.on('listening', () => {
    wiki.logger.info('HTTP Server: [ RUNNING ]')
    wiki.logger.info('🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻')
    wiki.logger.info('')
    wiki.logger.info(`Browse to http://YOUR-SERVER-IP:${wiki.config.port}/ to complete setup!`)
    wiki.logger.info('')
    wiki.logger.info('🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺')
  })
}
