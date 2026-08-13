import { makeExecutableSchema } from '@graphql-tools/schema'
import { graphql } from 'graphql/index.js'

import { authDirectiveTransformer } from '../../graph/directives/auth.ts'

describe('graph/directives/auth directive contract', () => {
  let schema
  let securedResolver
  let overrideResolver

  beforeEach(() => {
    securedResolver = vi.fn().mockResolvedValue('secured-value')
    overrideResolver = vi.fn().mockResolvedValue('override-value')

    const rawSchema = makeExecutableSchema({
      typeDefs: `
        directive @auth(requires: [String]) on OBJECT | FIELD_DEFINITION | ARGUMENT_DEFINITION

        type Query {
          securedField: String @auth(requires: ["manage:system"])
          scopedObject: ScopedObject
        }

        type ScopedObject @auth(requires: ["manage:system"]) {
          message: String @auth(requires: ["read:pages"])
        }
      `,
      resolvers: {
        Query: {
          securedField: securedResolver,
          scopedObject: () => ({})
        },
        ScopedObject: {
          message: overrideResolver
        }
      }
    })
    schema = authDirectiveTransformer(rawSchema)
  })

  it('throws Unauthorized when no authenticated user is present', async () => {
    const result = await graphql({
      schema,
      source: '{ securedField }',
      contextValue: { req: {} }
    })

    expect(result.data).toEqual({ securedField: null })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('Unauthorized')
    expect(securedResolver).not.toHaveBeenCalled()
  })

  it('throws Forbidden when the user lacks the required scope', async () => {
    const result = await graphql({
      schema,
      source: '{ securedField }',
      contextValue: { req: { user: { permissions: ['read:pages'] } } }
    })

    expect(result.data).toEqual({ securedField: null })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('Forbidden')
    expect(securedResolver).not.toHaveBeenCalled()
  })

  it('allows access when the user has any matching required scope', async () => {
    const result = await graphql({
      schema,
      source: '{ securedField }',
      contextValue: { req: { user: { permissions: ['write:pages', 'manage:system'] } } }
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ securedField: 'secured-value' })
    expect(securedResolver).toHaveBeenCalledTimes(1)
  })

  it('prefers field-level scopes over object-level scopes during schema execution', async () => {
    const result = await graphql({
      schema,
      source: '{ scopedObject { message } }',
      contextValue: { req: { user: { permissions: ['read:pages'] } } }
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ scopedObject: { message: 'override-value' } })
    expect(overrideResolver).toHaveBeenCalledTimes(1)
  })
})
