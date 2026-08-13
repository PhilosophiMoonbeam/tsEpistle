import { rateLimitDirective } from 'graphql-rate-limit-directive'

interface RateLimitContext {
  req?: {
    ip?: string
    socket?: {
      remoteAddress?: string
    }
  }
}

const createRateLimitDirective = () => rateLimitDirective<RateLimitContext>({
  keyGenerator: (_directiveArgs, _source, _args, context, info) => {
    const address = context.req?.ip || context.req?.socket?.remoteAddress || 'unknown'
    return `${address}:${info.parentType}.${info.fieldName}`
  }
})

export { createRateLimitDirective }
