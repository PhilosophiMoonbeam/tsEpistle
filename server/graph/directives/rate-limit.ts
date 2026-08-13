import { getDirective, MapperKind, mapSchema } from '@graphql-tools/utils'
import {
  defaultFieldResolver,
  GraphQLError,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
  type GraphQLSchema
} from 'graphql'
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

interface RateLimitContext {
  req?: {
    ip?: string
    socket?: {
      remoteAddress?: string
    }
  }
}

interface RateLimitDirectiveArgs {
  limit: number
  duration: number
}

interface RateLimitedField {
  resolve?: GraphQLFieldResolver<unknown, RateLimitContext>
}

const directiveName = 'rateLimit'

const rateLimitDirectiveTypeDefs = `"""
Controls the rate of traffic.
"""
directive @${directiveName}(
  """
  Number of occurrences allowed over duration.
  """
  limit: Int! = 60

  """
  Number of seconds before limit is reset.
  """
  duration: Int! = 60
) on OBJECT | FIELD_DEFINITION`

const requestKey = (context: RateLimitContext, info: GraphQLResolveInfo): string => {
  const address = context.req?.ip || context.req?.socket?.remoteAddress || 'unknown'
  return `${address}:${info.parentType}.${info.fieldName}`
}

const createRateLimitDirective = () => {
  const limiters = new Map<string, RateLimiterMemory>()

  const limiterFor = ({ limit, duration }: RateLimitDirectiveArgs): RateLimiterMemory => {
    const key = `${limit}/${duration}`
    let limiter = limiters.get(key)
    if (!limiter) {
      limiter = new RateLimiterMemory({
        keyPrefix: directiveName,
        points: limit,
        duration
      })
      limiters.set(key, limiter)
    }
    return limiter
  }

  const wrapField = (directive: RateLimitDirectiveArgs, field: RateLimitedField): void => {
    const resolve = field.resolve ?? defaultFieldResolver
    const limiter = limiterFor(directive)
    field.resolve = async (source, args, context, info) => {
      try {
        await limiter.consume(requestKey(context, info))
      } catch (error) {
        if (error instanceof Error) throw error
        const response = error as RateLimiterRes
        throw new GraphQLError(`Too many requests, please try again in ${Math.ceil(response.msBeforeNext / 1000)} seconds.`)
      }
      return resolve(source, args, context, info)
    }
  }

  return {
    rateLimitDirectiveTypeDefs,
    rateLimitDirectiveTransformer: (schema: GraphQLSchema): GraphQLSchema => mapSchema(schema, {
      [MapperKind.OBJECT_TYPE]: type => {
        const directive = getDirective(schema, type, directiveName)?.[0] as RateLimitDirectiveArgs | undefined
        if (directive) {
          for (const field of Object.values(type.getFields())) {
            if (!getDirective(schema, field, directiveName)) {
              wrapField(directive, field)
            }
          }
        }
        return type
      },
      [MapperKind.OBJECT_FIELD]: field => {
        const directive = getDirective(schema, field, directiveName)?.[0] as RateLimitDirectiveArgs | undefined
        if (directive) wrapField(directive, field)
        return field
      }
    })
  }
}

export { createRateLimitDirective }
