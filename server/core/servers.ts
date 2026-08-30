import fs from 'fs-extra'
import http from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import { parseCookie } from 'cookie'
import type { Express } from 'express'
import { createYoga, maskError, type YogaServerInstance } from 'graphql-yoga'
import { useServer } from 'graphql-ws/use/ws'
import type { Disposable } from 'graphql-ws'
import { WebSocketServer } from 'ws'
import _ from 'lodash'
import { execute as graphqlExecute, subscribe as graphqlSubscribe } from 'graphql'

import { createGraphQLArtifacts, type GraphRuntime } from '../graph/index.ts'
import { isPublicGraphError } from '../helpers/graph.ts'
import letsencrypt from './letsencrypt.ts'

interface ServerConfig {
  auth: { audience: string }
  bindIP: string
  certs: { public: string }
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

interface ServersCore {
  servers: ServerCollection
  connections: Map<string, Socket>
  le: typeof letsencrypt | null
  startHTTP(): Promise<void>
  startHTTPS(): Promise<void>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
      if (wiki.config.ssl.provider === 'letsencrypt') {
        this.le = letsencrypt
        await this.le.init()
      }

      wiki.logger.info(`HTTPS Server on port: [ ${wiki.config.ssl.port} ]`)
      const tlsOptions: https.ServerOptions = {}
      try {
        if (wiki.config.ssl.format === 'pem') {
          tlsOptions.key = wiki.config.ssl.inline ? wiki.config.ssl.key : fs.readFileSync(wiki.config.ssl.key)
          tlsOptions.cert = wiki.config.ssl.inline ? wiki.config.ssl.cert : fs.readFileSync(wiki.config.ssl.cert)
        } else {
          tlsOptions.pfx = wiki.config.ssl.inline ? wiki.config.ssl.pfx : fs.readFileSync(wiki.config.ssl.pfx)
        }
        if (!_.isEmpty(wiki.config.ssl.passphrase)) {
          tlsOptions.passphrase = wiki.config.ssl.passphrase
        }
        if (!_.isEmpty(wiki.config.ssl.dhparam)) {
          tlsOptions.dhparam = wiki.config.ssl.dhparam
        }
      } catch (error: unknown) {
        wiki.logger.error('Failed to setup HTTPS server parameters:')
        wiki.logger.error(errorMessage(error))
        throw error
      }

      const server = https.createServer(tlsOptions, wiki.app)
      this.servers.https = server
      this.installGraphQLSubscriptions(server)
      wiki.collaboration.install(server)
      server.on('connection', connection => {
        const key = `https:${connection.remoteAddress}:${connection.remotePort}`
        this.connections.set(key, connection)
        connection.on('close', () => {
          this.connections.delete(key)
        })
      })

      await listen(server, wiki.config.ssl.port, wiki.config.bindIP, wiki.logger)
      wiki.logger.info('HTTPS Server: [ RUNNING ]')
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
        graphiql: wiki.IS_DEBUG ? { subscriptionsProtocol: 'WS' } : false
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

      const yoga = graph.yoga
      const wsServer = new WebSocketServer({ noServer: true })
      const upgradeListener = (request: http.IncomingMessage, socket: Socket, head: Buffer): void => {
        if (request.url?.split('?', 1)[0] !== '/graphql-subscriptions') return
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
            } = yoga.getEnveloped({
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

    async authenticateGraphQLSubscription(connectionParams: unknown, request: http.IncomingMessage): Promise<SubscriptionAuthentication> {
      let token =
        typeof connectionParams === 'object' && connectionParams !== null && 'token' in connectionParams && typeof connectionParams.token === 'string'
          ? connectionParams.token
          : null
      if (!token) {
        const cookieHeader = request.headers.cookie || ''
        token = cookieHeader ? parseCookie(cookieHeader).jwt || null : null
      }
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
        await teardown(() => closeServer(server))
        this.servers.http = null
      }
      if (this.servers.https) {
        const server = this.servers.https
        await teardown(() => closeServer(server))
        this.servers.https = null
      }
      this.servers.graph = null
      if (firstError) throw firstError
    },

    async restartServer(server = 'https'): Promise<void> {
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
