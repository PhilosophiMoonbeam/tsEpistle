import { makeExecutableSchema } from '@graphql-tools/schema'
import { graphql, type GraphQLSchema } from 'graphql'

import { createApiPrincipal } from '../../helpers/api-principal.ts'
import { apiKeyMutationTransformer } from '../../graph/api-key-mutations.ts'

describe('GraphQL API-key mutation guard', () => {
  let mutation = vi.fn(() => 'changed')
  let schema: GraphQLSchema
  beforeEach(() => {
    mutation = vi.fn(() => 'changed')
    schema = apiKeyMutationTransformer(
      makeExecutableSchema({
        typeDefs: `
          type Query { value: String! }
          type Mutation { open: String! }
        `,
        resolvers: {
          Query: { value: () => 'readable' },
          Mutation: { open: mutation }
        }
      })
    )
  })

  it('rejects API-key mutations before an unprotected root resolver, including aliases and fragments', async () => {
    const result = await graphql({
      schema,
      source: `
        mutation Change {
          first: open
          ...OpenMutation
        }
        fragment OpenMutation on Mutation { second: open }
      `,
      contextValue: {
        req: {
          user: createApiPrincipal(7, 3, ['manage:system']),
          authContext: { kind: 'apiKey', apiKeyId: 7, groupId: 3, ownershipUserId: null }
        }
      }
    })

    expect(result.data).toBeNull()
    expect(result.errors?.map(error => error.message)).toEqual(['API-key principals cannot perform direct mutations.'])
    expect(mutation).not.toHaveBeenCalled()
  })

  it('keeps GraphQL queries available to API-key principals', async () => {
    const result = await graphql({
      schema,
      source: '{ value }',
      contextValue: { req: { user: createApiPrincipal(7, 3, ['read:pages']), authContext: { kind: 'apiKey', apiKeyId: 7, groupId: 3, ownershipUserId: null } } }
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ value: 'readable' })
  })

  it('allows a human principal through the same mutation root', async () => {
    const result = await graphql({
      schema,
      source: 'mutation { open }',
      contextValue: { req: { user: { id: 42, ownershipUserId: 42 } } }
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ open: 'changed' })
    expect(mutation).toHaveBeenCalledOnce()
  })
})
