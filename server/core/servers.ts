import fs from 'fs-extra'
import http from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'
import { createRequire } from 'node:module'
import type { Express } from 'express'
import { createYoga, type YogaServerInstance } from 'graphql-yoga'
import { useServer } from 'graphql-ws/use/ws'
import type { Disposable } from 'graphql-ws'
import WebSocket, * as wsModule from 'ws'
import _ from 'lodash'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import { execute as graphqlExecute, subscribe as graphqlSubscribe } from 'graphql'

import { schema } from '../graph/index.ts'
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

interface ServerWiki extends Record<string, unknown> {
  IS_DEBUG: boolean
  app: Express
  config: ServerConfig
  logger: { error(value: unknown): void; info(message: string): void }
}

interface AuthClaims extends JwtPayload {
  permissions: string[]
}

interface SubscriptionExtra extends Record<PropertyKey, unknown> {
  user?: AuthClaims
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
  authenticateGraphQLSubscription(connectionParams: unknown, request: http.IncomingMessage): AuthClaims
  disposeGraphQLSubscriptions(server?: NodeServer | null): Promise<void>
  closeConnections(mode?: 'all' | 'http' | 'https'): void
  stopServers(): Promise<void>
  restartServer(server?: 'http' | 'https'): Promise<void>
}

interface ExecutionRoot {
  execute: typeof graphqlExecute
  subscribe: typeof graphqlSubscribe
}

interface CookieModule {
  parse(input: string): Record<string, string | undefined>
}

interface WsModule {
  WebSocketServer: typeof WebSocket.Server
}

function isCookieModule(value: unknown): value is CookieModule {
  return typeof value === 'object' && value !== null &&
    'parse' in value && typeof value.parse === 'function'
}

function isWsModule(value: unknown): value is WsModule {
  return typeof value === 'object' && value !== null &&
    'WebSocketServer' in value && typeof value.WebSocketServer === 'function'
}

const wiki = WIKI as unknown as ServerWiki
const cookieModule: unknown = createRequire(import.meta.url)('cookie')
if (!isCookieModule(cookieModule)) {
  throw new Error('The cookie module does not export parse')
}
if (!isWsModule(wsModule)) {
  throw new Error('The ws module does not export WebSocketServer')
}
const cookie = cookieModule
const { WebSocketServer } = wsModule

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isListenError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'syscall' in error && 'code' in error
}

function handleListenError(error: unknown, port: number): void {
  if (!isListenError(error) || error.syscall !== 'listen') {
    throw error
  }

  switch (error.code) {
    case 'EACCES':
      wiki.logger.error(`Listening on port ${port} requires elevated privileges!`)
      process.exit(1)
      return
    case 'EADDRINUSE':
      wiki.logger.error(`Port ${port} is already in use!`)
      process.exit(1)
      return
    default:
      throw error
  }
}

function isAuthClaims(value: string | JwtPayload): value is AuthClaims {
  return typeof value !== 'string' && Array.isArray(value.permissions) && value.permissions.every(permission => typeof permission === 'string')
}

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

    server.listen(wiki.config.port, wiki.config.bindIP)
    server.on('error', error => handleListenError(error, wiki.config.port))
    server.on('listening', () => {
      wiki.logger.info('HTTP Server: [ RUNNING ]')
    })
    server.on('connection', connection => {
      const key = `http:${connection.remoteAddress}:${connection.remotePort}`
      this.connections.set(key, connection)
      connection.on('close', () => {
        this.connections.delete(key)
      })
    })
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
      process.exit(1)
    }

    const server = https.createServer(tlsOptions, wiki.app)
    this.servers.https = server
    this.installGraphQLSubscriptions(server)

    server.listen(wiki.config.ssl.port, wiki.config.bindIP)
    server.on('error', error => handleListenError(error, wiki.config.ssl.port))
    server.on('listening', () => {
      wiki.logger.info('HTTPS Server: [ RUNNING ]')
    })
    server.on('connection', connection => {
      const key = `https:${connection.remoteAddress}:${connection.remotePort}`
      this.connections.set(key, connection)
      connection.on('close', () => {
        this.connections.delete(key)
      })
    })
  },

  async startGraphQL(): Promise<void> {
    const yoga = createYoga<YogaServerContext, YogaUserContext>({
      schema,
      graphqlEndpoint: '/graphql',
      context: (initialContext: unknown) => {
        const req = typeof initialContext === 'object' && initialContext !== null && 'req' in initialContext
          ? initialContext.req
          : undefined
        const res = typeof initialContext === 'object' && initialContext !== null && 'res' in initialContext
          ? initialContext.res
          : undefined
        return { req, res }
      },
      maskedErrors: false,
      graphiql: wiki.IS_DEBUG
        ? { subscriptionsProtocol: 'WS' }
        : false
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
    const wsServer = new WebSocketServer({
      server,
      path: '/graphql-subscriptions'
    })
    const cleanup = useServer<Record<string, unknown>, SubscriptionExtra>({
      execute: args => {
        const root = args.rootValue as ExecutionRoot
        return root.execute(args)
      },
      subscribe: args => {
        const root = args.rootValue as ExecutionRoot
        return root.subscribe(args)
      },
      onConnect: context => {
        context.extra.user = this.authenticateGraphQLSubscription(context.connectionParams, context.extra.request)
      },
      onSubscribe: async (context, _id, params) => {
        const request = context.extra.request
        const req = {
          headers: request.headers,
          ip: request.socket?.remoteAddress,
          socket: request.socket,
          user: context.extra.user
        }
        const { schema: envelopedSchema, execute, subscribe, contextFactory, parse, validate } = yoga.getEnveloped({
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
      }
    }, wsServer)

    graph.subscriptions.push({ cleanup, server })
  },

  authenticateGraphQLSubscription(connectionParams: unknown, request: http.IncomingMessage): AuthClaims {
    let token = typeof connectionParams === 'object' && connectionParams !== null &&
      'token' in connectionParams && typeof connectionParams.token === 'string'
      ? connectionParams.token
      : null
    if (!token) {
      const cookieHeader = request.headers.cookie || ''
      token = cookieHeader ? cookie.parse(cookieHeader).jwt || null : null
    }
    if (!token) {
      throw new Error('Unauthorized')
    }

    try {
      const user = jwt.verify(token, wiki.config.certs.public, {
        audience: wiki.config.auth.audience,
        issuer: 'urn:wiki.js',
        algorithms: ['RS256']
      })
      if (!isAuthClaims(user) || !user.permissions.includes('manage:system')) {
        throw new Error('Forbidden')
      }
      return user
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
    await this.disposeGraphQLSubscriptions()
    this.closeConnections()
    if (this.servers.http) {
      await new Promise<void>((resolve, reject) => {
        this.servers.http?.close(error => error ? reject(error) : resolve())
      })
      this.servers.http = null
    }
    if (this.servers.https) {
      await new Promise<void>((resolve, reject) => {
        this.servers.https?.close(error => error ? reject(error) : resolve())
      })
      this.servers.https = null
    }
    this.servers.graph = null
  },

  async restartServer(server = 'https'): Promise<void> {
    this.closeConnections(server)
    switch (server) {
      case 'http':
        if (this.servers.http) {
          await this.disposeGraphQLSubscriptions(this.servers.http)
          await new Promise<void>((resolve, reject) => {
            this.servers.http?.close(error => error ? reject(error) : resolve())
          })
          this.servers.http = null
        }
        await this.startHTTP()
        break
      case 'https':
        if (this.servers.https) {
          await this.disposeGraphQLSubscriptions(this.servers.https)
          await new Promise<void>((resolve, reject) => {
            this.servers.https?.close(error => error ? reject(error) : resolve())
          })
          this.servers.https = null
        }
        await this.startHTTPS()
        break
    }
  }
}

export default serversCore
