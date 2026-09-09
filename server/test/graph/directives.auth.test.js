import { makeExecutableSchema } from '@graphql-tools/schema'
import { graphql } from 'graphql/index.js'

import { authDirectiveTransformer } from '../../graph/directives/auth.ts'

describe('graph/directives/auth directive contract', () => {
  let schema
  let securedResolver
  let overrideResolver

  beforeEach(() => {
    global.WIKI = {
      auth: {
        checkAccess: vi.fn((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission))),
        checkPageAccess: vi.fn(),
        loadPageRuleAuthority: vi.fn(async requester => ({
          requester,
          permissions: requester?.permissions ?? [],
          groups: [],
          tagAliases: {}
        }))
      }
    }
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

  it('uses one operation-local authority for page resource fields', async () => {
    const page = {
      path: 'guide',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      tags: []
    }
    const resourceSchema = authDirectiveTransformer(makeExecutableSchema({
      typeDefs: `
        directive @auth(requires: [String]) on OBJECT | FIELD_DEFINITION | ARGUMENT_DEFINITION
        type Query { page: Page }
        type Page {
          authorName: String @auth(requires: ["write:pages"])
          creatorName: String @auth(requires: ["write:pages"])
        }
      `,
      resolvers: {
        Query: { page: () => page },
        Page: { authorName: () => 'Author', creatorName: () => 'Creator' }
      }
    }))
    const user = { id: 7, permissions: [] }
    global.WIKI.auth.checkPageAccess.mockReturnValue(true)

    const result = await graphql({
      schema: resourceSchema,
      source: '{ page { authorName creatorName } }',
      contextValue: { req: { user } }
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ page: { authorName: 'Author', creatorName: 'Creator' } })
    expect(global.WIKI.auth.loadPageRuleAuthority).toHaveBeenCalledOnce()
    expect(global.WIKI.auth.checkPageAccess).toHaveBeenCalledTimes(2)
    expect(global.WIKI.auth.checkAccess).not.toHaveBeenCalled()
  })
  it('uses the shared effective-writer decision and fails closed for incomplete page context', async () => {
    const page = {
      path: 'guide',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      tags: undefined
    }
    const pageResolver = vi.fn(() => page)
    const fieldResolver = vi.fn(() => true)
    const resourceSchema = authDirectiveTransformer(makeExecutableSchema({
      typeDefs: `
        directive @auth(requires: [String]) on OBJECT | FIELD_DEFINITION | ARGUMENT_DEFINITION
        type Query { page: Page }
        type Page { isPublished: Boolean! @auth(requires: ["write:pages"]) }
      `,
      resolvers: {
        Query: { page: pageResolver },
        Page: { isPublished: fieldResolver }
      }
    }))

    global.WIKI.auth.checkPageAccess.mockReturnValue(false)
    const denied = await graphql({
      schema: resourceSchema,
      source: '{ page { isPublished } }',
      contextValue: { req: { user: { id: 7, permissions: ['write:pages'] } } }
    })
    expect(denied.data).toEqual({ page: null })
    expect(denied.errors).toHaveLength(1)
    expect(denied.errors[0].message).toBe('Forbidden')
    expect(fieldResolver).not.toHaveBeenCalled()

    page.tags = []
    page.visibility = 'private'
    page.ownerId = 7
    const owner = await graphql({
      schema: resourceSchema,
      source: '{ page { isPublished } }',
      contextValue: { req: { user: { id: 7, permissions: [] } } }
    })
    expect(owner.errors).toBeUndefined()
    expect(owner.data).toEqual({ page: { isPublished: true } })
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
