import { GRAPHQL_EXPLORER_OPTIONS, renderWorkspaceGraphiQL } from './graphql-explorer.ts'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import { parseCookie } from 'cookie'
import type { Express } from 'express'
import { createYoga, maskError, type YogaServerInstance } from 'graphql-yoga'
import { useServer } from 'graphql-ws/use/ws'
import type { Disposable } from 'graphql-ws'
import { WebSocketServer } from 'ws'
import { execute as graphqlExecute, subscribe as graphqlSubscribe } from 'graphql'

import { requestOriginMatches } from '../agents/origins.ts'
import { createGraphQLArtifacts, type GraphRuntime } from '../graph/index.ts'
import { isPublicGraphError } from '../helpers/graph.ts'
import letsencrypt from './letsencrypt.ts'
import { tlsCertificateAt, type TlsMaterial, type TlsMaterialConfiguration } from '../repositories/tls-material.ts'
import { prepareTlsMaterial } from '../repositories/tls-preflight.ts'
import type { TlsAppliedMaterial } from '../../shared/tls-workspace.ts'
interface ServerConfig {
  auth: { audience: string }
  bindIP: string
  certs: { public: string }
  host: string
  port: number
  ssl: {
    cert: string
    dhparam?: string
    format: 'pem' | string
    inline: boolean
    key: string
    passphrase?: string
    pfx: string
    port: number
    provider: string
  }
}

export interface ServerWiki extends GraphRuntime {
  IS_DEBUG: boolean
  app: Express
  collaboration: { install(server: NodeServer): void; dispose(server?: NodeServer | null): Promise<void> }
  config: ServerConfig
  auth: SubscriptionAuthService
  logger: GraphRuntime['logger'] & Record<'debug' | 'error' | 'info' | 'warn', (...values: unknown[]) => void>
}

interface SubscriptionPrincipal extends Record<string, unknown> {
  permissions?: string[]
}

interface SubscriptionAuthentication {
  token: string
  user: SubscriptionPrincipal
}

interface SubscriptionAuthService {
  authenticateUserToken(token: string): Promise<SubscriptionPrincipal | null>
  checkAccess(user: SubscriptionPrincipal | undefined, permissions?: string[]): boolean
}

interface SubscriptionExtra extends Record<PropertyKey, unknown> {
  token?: string
  user?: SubscriptionPrincipal
}

type NodeServer = http.Server | https.Server
type YogaServerContext = Record<string, unknown>
interface YogaUserContext extends Record<string, unknown> {
  req: unknown
  res: unknown
}
type YogaServer = YogaServerInstance<YogaServerContext, YogaUserContext>
const GRAPHQL_EXPLORER_PERMISSIONS = ['manage:system', 'manage:api']
const GRAPHIQL_OPTIONS = GRAPHQL_EXPLORER_OPTIONS

type SubscriptionCleanup = Disposable

interface GraphSubscription {
  cleanup: SubscriptionCleanup
  server: NodeServer
  upgradeListener: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void
}

interface GraphServer {
  yoga: YogaServer
  subscriptions: GraphSubscription[]
}

interface ServerCollection {
  graph: GraphServer | null
  http: http.Server | null
  https: https.Server | null
}

export interface PreparedHttpsContext {
  /** Internal identity for matching reviewed material. Never expose through an API. */
  materialKey: string
  certificate: TlsAppliedMaterial['certificate']
  source: TlsAppliedMaterial['source']
  format: TlsAppliedMaterial['format']
  mode: 'context-reload' | 'listener-restart'
  apply(options?: { allowRestart?: boolean }): Promise<TlsAppliedMaterial>
}

interface ServersCore {
  servers: ServerCollection
  connections: Map<string, Socket>
  le: typeof letsencrypt | null
  startHTTP(): Promise<void>
  startHTTPS(): Promise<void>
  launchHTTPS(material: TlsMaterial, port: number, bindIP: string): Promise<https.Server>
  retireHTTPS(server: https.Server): Promise<void>
  inspectHttpsMaterial(): TlsAppliedMaterial | null
  prepareHttpsContext(configuration?: TlsMaterialConfiguration): Promise<PreparedHttpsContext>
  startGraphQL(): Promise<void>
  installGraphQLSubscriptions(server: NodeServer): void
  authenticateGraphQLSubscription(connectionParams: unknown, request: http.IncomingMessage): Promise<SubscriptionAuthentication>
  disposeGraphQLSubscriptions(server?: NodeServer | null): Promise<void>
  closeConnections(mode?: 'all' | 'http' | 'https'): void
  stopServers(): Promise<void>
  restartServer(server?: 'http' | 'https'): Promise<void>
}

interface ExecutionRoot {
  execute: typeof graphqlExecute
  subscribe: typeof graphqlSubscribe
}

function isListenError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'syscall' in error && 'code' in error
}

function logListenError(error: unknown, port: number, logger: ServerWiki['logger']): void {
  if (!isListenError(error) || error.syscall !== 'listen') return
  switch (error.code) {
    case 'EACCES':
      logger.error(`Listening on port ${port} requires elevated privileges!`)
      break
    case 'EADDRINUSE':
      logger.error(`Port ${port} is already in use!`)
      break
  }
}

function listen(server: NodeServer, port: number, bindIP: string, logger: ServerWiki['logger']): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      logListenError(error, port, logger)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, bindIP)
    } catch (error) {
      server.off('error', onError)
      server.off('listening', onListening)
      logListenError(error, port, logger)
      reject(error)
    }
  })
}

async function closeServer(server: NodeServer): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

export default function createServersCore(wiki: ServerWiki): ServersCore {
  const applied = new WeakMap<https.Server, TlsAppliedMaterial>()
  const materials = new WeakMap<https.Server, TlsMaterial>()
  let httpsGeneration = 0
  let replacing = false
  let stopping = false
  let replacementDone: Promise<void> | null = null
  const configurationIdentity = () => JSON.stringify(wiki.config.ssl)
  const copy = (value: TlsAppliedMaterial): TlsAppliedMaterial => ({ ...value, certificate: value.certificate ? tlsCertificateAt(value.certificate) : null })
  const serversCore: ServersCore = {
    servers: {
      graph: null,
      http: null,
      https: null
    },
    connections: new Map<string, Socket>(),
    le: null,

    async startHTTP(): Promise<void> {
      wiki.logger.info(`HTTP Server on port: [ ${wiki.config.port} ]`)
      const server = http.createServer(wiki.app)
      this.servers.http = server
      this.installGraphQLSubscriptions(server)
      wiki.collaboration.install(server)
      server.on('connection', connection => {
        const key = `http:${connection.remoteAddress}:${connection.remotePort}`
        this.connections.set(key, connection)
        connection.on('close', () => {
          this.connections.delete(key)
        })
      })

      await listen(server, wiki.config.port, wiki.config.bindIP, wiki.logger)
      wiki.logger.info('HTTP Server: [ RUNNING ]')
    },

    async startHTTPS(): Promise<void> {
      if (stopping || replacing || this.servers.https?.listening) throw new Error('The HTTPS listener is already running or being replaced.')
      const generation = ++httpsGeneration
      if (wiki.config.ssl.provider === 'letsencrypt') {
        this.le = letsencrypt
        await this.le.init()
      }

      wiki.logger.info(`HTTPS Server on port: [ ${wiki.config.ssl.port} ]`)
      const identity = configurationIdentity()
      const material = await prepareTlsMaterial(wiki.config.ssl)
      if (generation !== httpsGeneration || stopping || replacing || this.servers.https?.listening || identity !== configurationIdentity())
        throw new Error('HTTPS listener or deployment configuration changed during certificate loading.')
      await this.launchHTTPS(material, wiki.config.ssl.port, wiki.config.bindIP)
      wiki.logger.info('HTTPS Server: [ RUNNING ]')
    },

    async launchHTTPS(material, port, bindIP): Promise<https.Server> {
      const server = https.createServer(material.options, wiki.app)
      this.servers.https = server
      try {
        this.installGraphQLSubscriptions(server)
        wiki.collaboration.install(server)
        server.on('connection', connection => {
          const key = `https:${connection.remoteAddress}:${connection.remotePort}`
          this.connections.set(key, connection)
          connection.on('close', () => {
            if (this.connections.get(key) === connection) this.connections.delete(key)
          })
        })
        await listen(server, port, bindIP, wiki.logger)
        materials.set(server, material)
        applied.set(server, {
          revision: randomUUID(),
          appliedAt: new Date().toISOString(),
          certificate: material.certificate,
          source: material.source,
          format: material.format
        })
        return server
      } catch (error) {
        try {
          await this.retireHTTPS(server)
        } catch {
          wiki.logger.error('HTTPS startup cleanup reported a transport failure.')
        }
        throw error
      }
    },

    async retireHTTPS(server): Promise<void> {
      let firstError: unknown
      const attempt = async (action: () => unknown) => {
        try {
          await action()
        } catch (error) {
          firstError ??= error
        }
      }
      await attempt(() => this.disposeGraphQLSubscriptions(server))
      await attempt(() => wiki.collaboration.dispose(server))
      await attempt(() => this.closeConnections('https'))
      await attempt(() => server.closeAllConnections())
      await attempt(() => closeServer(server))
      if (this.servers.https === server && !server.listening) this.servers.https = null
      if (firstError) throw firstError
    },

    inspectHttpsMaterial(): TlsAppliedMaterial | null {
      const server = this.servers.https
      const state = server?.listening ? applied.get(server) : null
      return state ? copy(state) : null
    },

    async prepareHttpsContext(configuration = wiki.config.ssl): Promise<PreparedHttpsContext> {
      const server = this.servers.https
      if (!server?.listening) throw new Error('The application HTTPS listener is not running.')
      const previous = applied.get(server)
      const previousMaterial = materials.get(server)
      const address = server.address()
      if (!address || typeof address === 'string' || !previousMaterial) throw new Error('The HTTPS listener material cannot be recovered for replacement.')
      const mode = typeof server.setSecureContext === 'function' ? 'context-reload' : 'listener-restart'
      const identity = configurationIdentity()
      const material = await prepareTlsMaterial(configuration)
      let consumed = false
      return {
        materialKey: material.key,
        certificate: material.certificate ? structuredClone(material.certificate) : null,
        source: material.source,
        format: material.format,
        mode,
        apply: async (options = {}) => {
          if (consumed) throw new Error('This prepared certificate replacement has already been applied.')
          if (
            stopping ||
            replacing ||
            this.servers.https !== server ||
            !server.listening ||
            applied.get(server) !== previous ||
            identity !== configurationIdentity()
          )
            throw new Error('The HTTPS listener or deployment configuration changed. Review the certificate again.')
          if (
            material.certificate &&
            (new Date(material.certificate.validUntil).getTime() <= Date.now() || new Date(material.certificate.validFrom).getTime() > Date.now())
          )
            throw new Error('The replacement certificate is outside its validity period.')
          if (mode === 'listener-restart' && options.allowRestart !== true)
            throw new Error('This runtime requires an HTTPS listener restart. Review the connection interruption before applying.')
          consumed = true
          replacing = true
          let finishReplacement!: () => void
          replacementDone = new Promise(resolve => {
            finishReplacement = resolve
          })
          try {
            if (mode === 'context-reload') {
              // Runtimes implementing the Node API can preserve established connections.
              server.setSecureContext(material.options)
              materials.set(server, material)
              const next: TlsAppliedMaterial = {
                revision: randomUUID(),
                appliedAt: new Date().toISOString(),
                certificate: material.certificate,
                source: material.source,
                format: material.format
              }
              applied.set(server, next)
              return copy(next)
            }
            // Bun 1.4 does not implement setSecureContext. An explicitly reviewed restart
            // uses already validated material, with the previous material kept for recovery.
            try {
              await this.retireHTTPS(server)
              const next = await this.launchHTTPS(material, address.port, address.address)
              return copy(applied.get(next)!)
            } catch {
              // Ensure partially disposed old transports cannot remain active beside recovery.
              try {
                try {
                  await this.retireHTTPS(server)
                } catch {
                  wiki.logger.error('HTTPS replacement cleanup reported a transport failure.')
                }
                if (server.listening) throw new Error('Previous listener could not stop.')
                await this.launchHTTPS(previousMaterial, address.port, address.address)
              } catch {
                wiki.logger.error('HTTPS certificate replacement and listener recovery failed. Restore the listener from deployment configuration.')
                throw new Error('Certificate replacement failed and the previous HTTPS listener could not be restored. Deployment recovery is required.')
              }
              throw new Error('Certificate replacement failed. The HTTPS listener was restored using its previous material.')
            }
          } finally {
            replacing = false
            replacementDone = null
            finishReplacement()
          }
        }
      }
    },

    async startGraphQL(): Promise<void> {
      const { schema } = await createGraphQLArtifacts(wiki)
      const yoga = createYoga<YogaServerContext, YogaUserContext>({
        schema,
        graphqlEndpoint: '/graphql',
        context: (initialContext: unknown) => {
          const req = typeof initialContext === 'object' && initialContext !== null && 'req' in initialContext ? initialContext.req : undefined
          const res = typeof initialContext === 'object' && initialContext !== null && 'res' in initialContext ? initialContext.res : undefined
          return { req, res }
        },
        logging: wiki.logger,
        maskedErrors: {
          isDev: false,
          maskError: (error, message) => (isPublicGraphError(error) ? error : maskError(error, message))
        },
        renderGraphiQL: renderWorkspaceGraphiQL,
        graphiql: (_request, serverContext) => {
          const req = serverContext?.req as { user?: SubscriptionPrincipal } | undefined
          return wiki.IS_DEBUG || wiki.auth.checkAccess(req?.user, GRAPHQL_EXPLORER_PERMISSIONS) ? GRAPHIQL_OPTIONS : false
        }
      })

      this.servers.graph = {
        yoga,
        subscriptions: []
      }
      wiki.app.use(yoga.graphqlEndpoint, (req, res, next) => {
        void Promise.resolve(yoga(req, res)).catch(next)
      })
    },

    installGraphQLSubscriptions(server: NodeServer): void {
      const graph = this.servers.graph
      if (!graph) {
        throw new Error('GraphQL must be initialized before HTTP servers.')
      }

      const wsServer = new WebSocketServer({ noServer: true })
      const upgradeListener = (request: http.IncomingMessage, socket: Socket, head: Buffer): void => {
        if (request.url?.split('?', 1)[0] !== '/graphql-subscriptions') return
        const origin = request.headers.origin
        if (typeof origin !== 'string' || !requestOriginMatches(origin, wiki.config.host)) {
          socket.destroy()
          return
        }
        wsServer.handleUpgrade(request, socket, head, client => {
          wsServer.emit('connection', client, request)
        })
      }
      server.on('upgrade', upgradeListener)
      const cleanup = useServer<Record<string, unknown>, SubscriptionExtra>(
        {
          execute: args => {
            const root = args.rootValue as ExecutionRoot
            return root.execute(args)
          },
          subscribe: args => {
            const root = args.rootValue as ExecutionRoot
            return root.subscribe(args)
          },
          onConnect: async context => {
            const authentication = await this.authenticateGraphQLSubscription(context.connectionParams, context.extra.request)
            context.extra.token = authentication.token
            context.extra.user = authentication.user
          },
          onSubscribe: async (context, _id, params) => {
            const authentication = await this.authenticateGraphQLSubscription({ token: context.extra.token }, context.extra.request)
            context.extra.user = authentication.user
            const request = context.extra.request
            const req = {
              headers: request.headers,
              ip: request.socket?.remoteAddress,
              socket: request.socket,
              user: authentication.user
            }
            const {
              schema: envelopedSchema,
              execute,
              subscribe,
              contextFactory,
              parse,
              validate
            } = graph.yoga.getEnveloped({
              ...context,
              req,
              params
            })
            const args = {
              schema: envelopedSchema,
              operationName: params.operationName,
              document: parse(params.query),
              variableValues: params.variables,
              contextValue: await contextFactory(),
              rootValue: { execute, subscribe }
            }
            const errors = validate(args.schema, args.document)
            return errors.length > 0 ? errors : args
          },
          onNext: async context => {
            const authentication = await this.authenticateGraphQLSubscription({ token: context.extra.token }, context.extra.request)
            context.extra.user = authentication.user
          }
        },
        wsServer
      )

      graph.subscriptions.push({ cleanup, server, upgradeListener })
    },

    async authenticateGraphQLSubscription(_connectionParams: unknown, request: http.IncomingMessage): Promise<SubscriptionAuthentication> {
      const cookieHeader = request.headers.cookie || ''
      const token = cookieHeader ? parseCookie(cookieHeader).jwt || null : null
      if (!token) throw new Error('Unauthorized')

      try {
        const user = await wiki.auth.authenticateUserToken(token)
        if (!user || !wiki.auth.checkAccess(user, ['manage:system'])) throw new Error('Unauthorized')
        return { token, user }
      } catch {
        throw new Error('Unauthorized')
      }
    },

    async disposeGraphQLSubscriptions(server: NodeServer | null = null): Promise<void> {
      const graph = this.servers.graph
      if (!graph) return

      const remaining: GraphSubscription[] = []
      for (const subscription of graph.subscriptions) {
        if (server && subscription.server !== server) {
          remaining.push(subscription)
          continue
        }
        subscription.server.off('upgrade', subscription.upgradeListener)
        await subscription.cleanup.dispose()
      }
      graph.subscriptions = remaining
    },

    closeConnections(mode = 'all'): void {
      for (const [key, connection] of this.connections) {
        if (mode !== 'all' && !key.startsWith(`${mode}:`)) continue
        connection.destroy()
        this.connections.delete(key)
      }
      if (mode === 'all') this.connections.clear()
    },

    async stopServers(): Promise<void> {
      stopping = true
      httpsGeneration += 1
      await replacementDone
      try {
        let firstError: unknown
        const teardown = async (action: () => Promise<unknown>): Promise<void> => {
          try {
            await action()
          } catch (error) {
            firstError ??= error
            wiki.logger.error(error)
          }
        }

        await teardown(() => this.disposeGraphQLSubscriptions())
        await teardown(() => wiki.collaboration.dispose())
        this.closeConnections()
        if (this.servers.http) {
          const server = this.servers.http
          server.closeAllConnections()
          await teardown(() => closeServer(server))
          this.servers.http = null
        }
        if (this.servers.https) {
          const server = this.servers.https
          server.closeAllConnections()
          await teardown(() => closeServer(server))
          this.servers.https = null
        }
        this.servers.graph = null
        if (firstError) throw firstError
      } finally {
        stopping = false
      }
    },

    async restartServer(server = 'https'): Promise<void> {
      if (stopping || replacing) throw new Error('A server shutdown or certificate replacement is already in progress.')
      this.closeConnections(server)
      switch (server) {
        case 'http':
          if (this.servers.http) {
            await this.disposeGraphQLSubscriptions(this.servers.http)
            await wiki.collaboration.dispose(this.servers.http)
            await closeServer(this.servers.http)
            this.servers.http = null
          }
          await this.startHTTP()
          break
        case 'https':
          if (this.servers.https) {
            await this.disposeGraphQLSubscriptions(this.servers.https)
            await wiki.collaboration.dispose(this.servers.https)
            await closeServer(this.servers.https)
            this.servers.https = null
          }
          await this.startHTTPS()
          break
      }
    }
  }

  return serversCore
}
