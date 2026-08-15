import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { makeExecutableSchema } from '@graphql-tools/schema'
import type { IResolvers } from '@graphql-tools/utils'
import _ from 'lodash'
import { PubSub } from 'graphql-subscriptions'
import { LEVEL, MESSAGE } from 'triple-beam'
import Transport from 'winston-transport'

import { authDirectiveTransformer } from './directives/auth.ts'
import { createRateLimitDirective } from './directives/rate-limit.ts'

type ResolverMap = IResolvers<unknown, unknown, Record<string, unknown>, unknown>
type LogInfo = Record<PropertyKey, unknown>
type LogCallback = (error: null, success: true) => void
interface GraphEvents extends Record<string, unknown> {
  livetrail: {
    loggingLiveTrail: {
      timestamp: Date
      level: unknown
      output: unknown
    }
  }
}

export interface GraphRuntime extends Record<string, unknown> {
  ROOTPATH: string
  SERVERPATH: string
  config: unknown
  GQLEmitter?: unknown
  logger: {
    add(transport: Transport): void
    info(message: string): void
    warn(message: string, error: unknown): void
  }
}

const isWikiLogger = (value: unknown): value is GraphRuntime['logger'] =>
  typeof value === 'object' && value !== null &&
  typeof Reflect.get(value, 'add') === 'function' &&
  typeof Reflect.get(value, 'info') === 'function' &&
  typeof Reflect.get(value, 'warn') === 'function'

export async function createGraphQLArtifacts (runtime: GraphRuntime) {
  const serverPath = runtime.SERVERPATH
  const logger = runtime.logger
  if (typeof serverPath !== 'string' || !isWikiLogger(logger)) {
    throw new TypeError('GraphQL requires a server path and logger')
  }

  logger.info('Loading GraphQL Schema...')
  const graphEmitter = new PubSub<GraphEvents>()
  runtime.GQLEmitter = graphEmitter

  const { rateLimitDirectiveTypeDefs, rateLimitDirectiveTransformer } = createRateLimitDirective()
  const typeDefs = [rateLimitDirectiveTypeDefs]
  const schemas = fs.readdirSync(path.join(serverPath, 'graph/schemas'))
  schemas.forEach(schemaFile => {
    typeDefs.push(fs.readFileSync(path.join(serverPath, `graph/schemas/${schemaFile}`), 'utf8'))
  })

  const resolvers: ResolverMap = {}
  const resolverDirectory = path.join(serverPath, 'graph/resolvers')
  const resolverFiles = fs.readdirSync(resolverDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
  const resolverModules: unknown[] = await Promise.all(resolverFiles.map(entry => {
    return import(pathToFileURL(path.join(resolverDirectory, entry.name)).href)
  }))
  for (const resolverModule of resolverModules) {
    if (typeof resolverModule !== 'object' || resolverModule === null || !('default' in resolverModule)) {
      throw new TypeError('GraphQL resolver module must have a default export')
    }
    const resolverExport = resolverModule.default
    const resolver = typeof resolverExport === 'function'
      ? await Reflect.apply(resolverExport, undefined, [runtime])
      : resolverExport
    if (typeof resolver !== 'object' || resolver === null) {
      throw new TypeError('GraphQL resolver default export must be an object or resolver factory')
    }
    _.merge(resolvers, resolver)
  }

  let schema = makeExecutableSchema({ typeDefs, resolvers })
  schema = authDirectiveTransformer(schema)
  schema = rateLimitDirectiveTransformer(schema)

  class LiveTrailLogger extends Transport {
    name = 'liveTrailLogger'
    override level = 'debug'

    override log (info: LogInfo, callback: LogCallback = () => {}) {
      void graphEmitter.publish('livetrail', {
        loggingLiveTrail: {
          timestamp: new Date(),
          level: info[LEVEL],
          output: info[MESSAGE]
        }
      })
      callback(null, true)
    }
  }

  logger.add(new LiveTrailLogger({}))
  logger.info('GraphQL Schema: [ OK ]')
  return { graphEmitter, resolvers, schema, typeDefs }
}
