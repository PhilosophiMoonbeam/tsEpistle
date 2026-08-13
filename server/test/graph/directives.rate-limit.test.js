import { makeExecutableSchema } from '@graphql-tools/schema'
import { graphql } from 'graphql/index.js'

import { createRateLimitDirective } from '../../graph/directives/rate-limit.ts'

const execute = (schema, ip, source = '{ restricted }') => graphql({
  schema,
  source,
  contextValue: { req: { ip } }
})

describe('graph/directives/rate-limit directive contract', () => {
  let schema
  let resolver

  beforeEach(() => {
    resolver = vi.fn().mockResolvedValue('ok')
    const { rateLimitDirectiveTypeDefs, rateLimitDirectiveTransformer } = createRateLimitDirective()
    schema = rateLimitDirectiveTransformer(makeExecutableSchema({
      typeDefs: `
        ${rateLimitDirectiveTypeDefs}
        type Query {
          restricted: String @rateLimit(limit: 2, duration: 60)
        }
      `,
      resolvers: {
        Query: { restricted: resolver }
      }
    }))
  })

  it('limits repeated field requests by client and schema coordinate', async () => {
    await expect(execute(schema, '192.0.2.1')).resolves.toMatchObject({ data: { restricted: 'ok' } })
    await expect(execute(schema, '192.0.2.1')).resolves.toMatchObject({ data: { restricted: 'ok' } })

    const blocked = await execute(schema, '192.0.2.1')
    expect(blocked.data).toEqual({ restricted: null })
    expect(blocked.errors?.[0].message).toMatch(/^Too many requests, please try again in \d+ seconds\.$/)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('maintains independent limits for different clients', async () => {
    await execute(schema, '192.0.2.10')
    await execute(schema, '192.0.2.10')

    await expect(execute(schema, '192.0.2.11')).resolves.toMatchObject({ data: { restricted: 'ok' } })
  })
})
