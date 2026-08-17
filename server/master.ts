import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import session from 'express-session'
import { ConnectSessionKnexStore } from 'connect-session-knex'
import type { Knex } from 'knex'
import favicon from 'serve-favicon'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import _ from 'lodash'

import authCore from './core/auth.ts'
import localization from './core/localization.ts'
import mail from './core/mail.ts'
import system from './core/system.ts'
import viteAssets from './helpers/vite-assets.ts'
import securityMiddleware from './middlewares/security.ts'
import seoMiddleware from './middlewares/seo.ts'
import createAuthController, { type AuthWiki } from './controllers/auth.ts'
import createAgentsHostController from './controllers/agents-host.ts'
import createUploadController, { type UploadWiki } from './controllers/upload.ts'
import createCommonController, { type CommonWiki } from './controllers/common.ts'
import createSslController, { type SslWiki } from './controllers/ssl.ts'
import apiController, { type ApiRuntime } from './controllers/api/index.ts'
import { configureTransportRuntime } from './controllers/_types.ts'
import apiV1Controller from './controllers/api-v1/index.ts'
import type { ProductMetadata } from '../shared/product.ts'
import { isExternalRestPath, isInternalRestPath } from '../shared/api-access.ts'

import { normalizeAgentOrigins, requestMatchesOriginHost } from './agents/origins.ts'
import { AgentProviderRegistry, EnvironmentAgentSecretRegistry, type AgentProfileTokenKeys } from './agents/providers/registry.ts'
import { AgentProviderFactory } from './agents/providers/factory.ts'
import { AxAgentEngine } from './agents/providers/engine.ts'
import { AgentProductRuntime } from './agents/runtime.ts'
import { createWikiActionSessionProvider } from './agents/providers/wiki-actions.ts'
import { AgentProviderConformanceRunner } from './agents/providers/conformance.ts'
import { agentLaunchCsrfToken } from './agents/launch-csrf.ts'
import { BrowserWorkerClient } from './agents/browser/client.ts'
import { createWikiMcpController } from './agents/mcp.ts'
import { loadWikiAgentUser } from './agents/providers/wiki-actions.ts'
import pageOperations from './operations/pages.ts'
const { collectEntry } = viteAssets
const LEGACY_DEFAULT_LOGO_URL = 'https://static.requarks.io/logo/wikijs-butterfly.svg'
const BUNDLED_DEFAULT_LOGO_URL = '/_assets/svg/logo-wikijs.svg'


interface MasterConfig extends Record<string, unknown> {
  auth: Record<string, unknown>
  agents: {
    cookieAudience: string
    enabled: boolean
    publicOrigin: string
    launchTokenTtlSeconds: number
    mcp: { enabled: boolean; publicOrigin: string; resourceUrl: string }
    provider: { enabled: boolean; globalConcurrency?: number; perUserConcurrency?: number; pollingMilliseconds?: number }
    retention: { temporarySessionHours: number; mcpContentDays: number; auditDays: number; maintenanceBatchSize: number }
    skills: { enabled: boolean; namespace: string }
    browser: { enabled: boolean }
    proposals: { enabled: boolean }
    writes: { enabled: boolean; create: { enabled: boolean }; patch: { enabled: boolean }; move: { enabled: boolean }; restore: { enabled: boolean }; delete: { enabled: boolean } }
  }
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

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required when the agent browser is enabled`)
  return value
}

const browserWorkerClientFromEnvironment = (): BrowserWorkerClient => {
  const url = requiredEnvironment('AGENT_BROWSER_WORKER_URL')
  if (new URL(url).protocol !== 'https:') throw new Error('AGENT_BROWSER_WORKER_URL must use HTTPS')
  const signingSecret = Buffer.from(requiredEnvironment('AGENT_BROWSER_WORKER_SIGNING_SECRET'), 'base64')
  if (signingSecret.byteLength < 32) throw new Error('AGENT_BROWSER_WORKER_SIGNING_SECRET must be at least 32 base64-encoded bytes')
  return new BrowserWorkerClient({
    url,
    keyId: requiredEnvironment('AGENT_BROWSER_WORKER_SIGNING_KEY_ID'),
    signingSecret,
    ca: readFileSync(requiredEnvironment('AGENT_BROWSER_WORKER_CA_PATH')),
    cert: readFileSync(requiredEnvironment('AGENT_BROWSER_WORKER_CERT_PATH')),
    key: readFileSync(requiredEnvironment('AGENT_BROWSER_WORKER_KEY_PATH'))
  })
}

interface WikiAuth {
  agentStrategies: Record<string, { key: string }>
  authenticate: RequestHandler
  authenticateAgent: RequestHandler
  passport: {
    authenticate(
      strategy: string,
      options: Record<string, unknown>,
      callback?: (error: unknown, user: Express.User | false | null | undefined) => void
    ): (req: Request, res: Response, next: NextFunction) => void
    initialize(): RequestHandler
  }
  groups: Record<string, { permissions?: string[] }>
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
    users: {
      refreshToken(user: number | Express.User, options: { audience: string }): Promise<{ token: string; user: Express.User }>
    }
  }
  product: ProductMetadata
  servers: { startGraphQL(): Promise<void>; startHTTP(): Promise<void>; startHTTPS(): Promise<void> }
  system: unknown
}
export type HttpTransportRuntime = MasterWiki & AuthWiki & UploadWiki & CommonWiki & SslWiki & ApiRuntime


interface HttpError extends Error {
  code?: string
  status: number
}

const decodeMcpRequestStateKeys = (encoded: string | undefined): readonly Uint8Array[] => {
  if (!encoded) throw new Error('AGENT_MCP_REQUEST_STATE_KEYS is required when MCP is enabled')
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error('AGENT_MCP_REQUEST_STATE_KEYS must be a JSON array of base64 keys')
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(key => typeof key === 'string')) {
    throw new Error('AGENT_MCP_REQUEST_STATE_KEYS must be a non-empty JSON array of base64 keys')
  }
  const keys = value.map(key => Buffer.from(key, 'base64'))
  if (keys.some(key => key.byteLength < 32)) throw new Error('Every AGENT_MCP_REQUEST_STATE_KEYS entry must contain at least 32 bytes')
  return keys
}

const snapshotSigningSecret = (required: boolean): Uint8Array => {
  const encoded = process.env.AGENT_SNAPSHOT_SIGNING_SECRET
  const secret = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
  if (required && secret.byteLength < 32) throw new Error('AGENT_SNAPSHOT_SIGNING_SECRET must be at least 32 base64-encoded bytes when agents or MCP actions are enabled')
  return secret
}

export default async function startMaster(wiki: HttpTransportRuntime): Promise<true> {
  configureTransportRuntime(wiki)
  wiki.lang = localization.init()
  wiki.auth = authCore.init()
  wiki.mail = mail.init()
  wiki.system = system.init()

  const app = express()
  wiki.app = app
  const origins = normalizeAgentOrigins({
    wikiPublicOrigin: wiki.config.host,
    agentsPublicOrigin: wiki.config.agents.publicOrigin,
    mcpPublicOrigin: wiki.config.agents.mcp.publicOrigin
  })
  app.set('views', path.join(wiki.SERVERPATH, 'views'))
  app.set('view engine', 'pug')
  const viteOrigin = process.env.WIKI_VITE_ORIGIN
  app.locals.agentVite = collectEntry('client/index-agents.ts', {
    dev: wiki.IS_DEBUG,
    ...(viteOrigin === undefined ? {} : { origin: viteOrigin })
  })
  app.use(compression())

  app.use(securityMiddleware)
  app.use(cors({ origin: false }))
  app.options('/{*corsPreflightPath}', cors({ origin: false }))
  app.use((req, res, next) => {
    const host = req.get('host')
    if (origins.agentsPublicOrigin && requestMatchesOriginHost(host, origins.agentsPublicOrigin) && !wiki.config.agents.enabled) {
      return res.sendStatus(404)
    }
    if (origins.mcpPublicOrigin && requestMatchesOriginHost(host, origins.mcpPublicOrigin) && !wiki.config.agents.mcp.enabled) {
      return res.sendStatus(404)
    }
    return next()
  })
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
  app.use('/', createSslController(wiki))

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
  const actionSnapshotSigningSecret = snapshotSigningSecret(wiki.config.agents.provider.enabled || wiki.config.agents.mcp.enabled)
  const mcpController = wiki.config.agents.mcp.enabled
    ? createWikiMcpController({
        knex: wiki.models.knex,
        operations: pageOperations,
        authenticate: wiki.auth.authenticate.bind(wiki.auth),
        resolvePrincipal: async (_apiKeyId, groupId) => {
          const permissions = wiki.auth.groups[String(groupId)]?.permissions ?? []
          const groups = [groupId]
          return {
            id: 1,
            email: 'api@localhost',
            name: 'API',
            permissions,
            groups,
            ownershipUserId: null,
            getGlobalPermissions: () => permissions,
            getGroups: () => groups
          }
        },
        resolveUser: loadWikiAgentUser,
        config: {
          enabled: true,
          publicOrigin: wiki.config.agents.mcp.publicOrigin,
          resourceUrl: wiki.config.agents.mcp.resourceUrl,
          agentsPublicOrigin: wiki.config.agents.publicOrigin,
          agentsEnabled: wiki.config.agents.enabled,
          skillsEnabled: wiki.config.agents.skills.enabled,
          proposalsEnabled: wiki.config.agents.proposals.enabled,
          writesEnabled: wiki.config.agents.writes.enabled,
          writeCreateEnabled: wiki.config.agents.writes.create.enabled,
          writePatchEnabled: wiki.config.agents.writes.patch.enabled,
          writeMoveEnabled: wiki.config.agents.writes.move.enabled,
          writeRestoreEnabled: wiki.config.agents.writes.restore.enabled,
          writeDeleteEnabled: wiki.config.agents.writes.delete.enabled,
          requestStateKeys: decodeMcpRequestStateKeys(process.env.AGENT_MCP_REQUEST_STATE_KEYS),
          snapshotSigningSecret: actionSnapshotSigningSecret
        },
        logger: wiki.logger
      })
    : undefined
  let providerRegistry: AgentProviderRegistry | undefined
  let agentRuntime: AgentProductRuntime | undefined
  let providerConformance: AgentProviderConformanceRunner | undefined
  if (wiki.config.agents.provider.enabled) {
    const encodedKeys = process.env.AGENT_PROFILE_RESOLUTION_KEYS
    if (!encodedKeys) throw new Error('AGENT_PROFILE_RESOLUTION_KEYS is required when agent providers are enabled')
    let keys: AgentProfileTokenKeys
    try {
      keys = JSON.parse(encodedKeys) as AgentProfileTokenKeys
    } catch {
      throw new Error('AGENT_PROFILE_RESOLUTION_KEYS must be valid JSON')
    }
    const snapshotSigningSecret = actionSnapshotSigningSecret
    const secrets = new EnvironmentAgentSecretRegistry()
    providerRegistry = new AgentProviderRegistry(wiki.models.knex, secrets, keys)
    const actionSessions = createWikiActionSessionProvider(wiki.models.knex, {
      enabled: wiki.config.agents.enabled,
      providerEnabled: wiki.config.agents.provider.enabled,
      skillsEnabled: wiki.config.agents.skills.enabled,
      browserEnabled: wiki.config.agents.browser.enabled,
      proposalsEnabled: wiki.config.agents.proposals.enabled,
      writesEnabled: wiki.config.agents.writes.enabled,
      writeCreateEnabled: wiki.config.agents.writes.create.enabled,
      writePatchEnabled: wiki.config.agents.writes.patch.enabled,
      writeMoveEnabled: wiki.config.agents.writes.move.enabled,
      writeRestoreEnabled: wiki.config.agents.writes.restore.enabled,
      writeDeleteEnabled: wiki.config.agents.writes.delete.enabled,
      snapshotSigningSecret
    }, wiki.config.agents.browser.enabled ? browserWorkerClientFromEnvironment() : undefined)
    const providerFactory = new AgentProviderFactory(wiki.models.knex, secrets)
    providerConformance = new AgentProviderConformanceRunner(wiki.models.knex, providerFactory, providerRegistry)
    agentRuntime = new AgentProductRuntime(wiki.models.knex, providerRegistry, new AxAgentEngine(providerFactory, actionSessions), {
      workerId: `http-${process.pid}`,
      globalConcurrency: wiki.config.agents.provider.globalConcurrency ?? 4,
      perUserConcurrency: wiki.config.agents.provider.perUserConcurrency ?? 1
    })
    wiki.agentRuntime = agentRuntime
    let workerActive = false
    const tick = (): void => {
      if (workerActive) return
      workerActive = true
      void agentRuntime!.runOnce().catch(() => undefined).finally(() => { workerActive = false })
    }
    tick()
    setInterval(tick, wiki.config.agents.provider.pollingMilliseconds ?? 1_000).unref()
  }
  const agentsHostController = createAgentsHostController({
    ...wiki,
    ...(providerRegistry === undefined ? {} : { providerRegistry }),
    ...(agentRuntime === undefined ? {} : { agentRuntime }),
    ...(providerConformance === undefined ? {} : { providerConformance })
  })
  app.use((req, res, next) => {
    const host = req.get('host')
    if (origins.agentsPublicOrigin && requestMatchesOriginHost(host, origins.agentsPublicOrigin)) {
      res.locals.agentVite = app.locals.agentVite
      return agentsHostController(req, res, next)
    }
    if (origins.mcpPublicOrigin && requestMatchesOriginHost(host, origins.mcpPublicOrigin)) {
      return mcpController ? mcpController(req, res, next) : res.sendStatus(404)
    }
    return next()
  })
  app.use(wiki.auth.authenticate.bind(wiki.auth))

  await wiki.servers.startGraphQL()
  const jsonBodyParser = express.json({ limit: wiki.config.bodyParserLimit ?? '5mb' })
  app.use('/_api', jsonBodyParser, apiController)
  app.use('/api/v1', jsonBodyParser, apiV1Controller)

  app.use(seoMiddleware)


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
      logoUrl: wiki.config.logoUrl === LEGACY_DEFAULT_LOGO_URL ? BUNDLED_DEFAULT_LOGO_URL : wiki.config.logoUrl,
      product: wiki.product,
      agentsEnabled: wiki.config.agents.enabled,
      agentLaunchCsrfToken: wiki.config.agents.enabled ? agentLaunchCsrfToken(_req) : ''
    }
    res.locals.langs = await wiki.models.locales.getNavLocales({ cache: true })
    res.locals.analyticsCode = await wiki.models.analytics.getCode({ cache: true })
    next()
  })
  app.use('/', createAuthController(wiki))
  app.use('/', createUploadController(wiki))
  app.use('/', createCommonController(wiki))

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

    if (isInternalRestPath(req.path) || isExternalRestPath(req.path)) {
      res.status(error.status || 500).json({
        code: error.code || (isInternalRestPath(req.path) ? 'INTERNAL_REST_ERROR' : 'REST_API_ERROR'),
        error: error.message
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
