import { beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { readFileSync } from 'node:fs'
import { graphql, type GraphQLSchema } from 'graphql/index.js'
import { makeExecutableSchema } from '@graphql-tools/schema'
import errors from '../../helpers/error.ts'

const operations = {
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn()
}
vi.mockModule('../../operations/users.ts', import.meta.url, () => ({ default: operations }))
let resolverMap: Record<string, Record<string, unknown>>
let schema: GraphQLSchema
beforeAll(async () => {
  resolverMap = (await vi.importFresh('../../graph/resolvers/user.ts', import.meta.url)).default
  schema = makeExecutableSchema({
    typeDefs: [
      `
        scalar Date
        directive @auth(requires: [String]) on FIELD_DEFINITION
        type Query { _health: Boolean }
        type Mutation { _health: Boolean }
        type Group { id: Int! }
        type DefaultResponse { responseResult: ResponseStatus }
        type ResponseStatus { succeeded: Boolean!, errorCode: Int!, slug: String!, message: String }
      `,
      readFileSync(new URL('../../graph/schemas/user.graphql', import.meta.url), 'utf8')
    ],
    resolvers: {
      Query: resolverMap.Query,
      Mutation: resolverMap.Mutation,
      UserQuery: { profile: resolverMap.UserQuery.profile },
      UserMutation: {
        updateProfile: resolverMap.UserMutation.updateProfile,
        changePassword: resolverMap.UserMutation.changePassword
      }
    }
  })
})
beforeEach(() => {
  for (const fn of Object.values(operations)) fn.mockReset()
})
describe('GraphQL profile transport results', () => {
  it('returns a GraphQL query error and canonical mutation failure envelopes for an API principal', async () => {
    const apiPrincipal = { id: 1, ownershipUserId: null, permissions: ['manage:system'] }
    const denied = new errors.AuthRequired()
    operations.getProfile.mockRejectedValue(denied)
    operations.updateProfile.mockRejectedValue(denied)
    operations.changePassword.mockRejectedValue(denied)

    const profile = await graphql({
      schema,
      source: '{ users { profile { id } } }',
      contextValue: { req: { user: apiPrincipal }, res: {} }
    })
    expect(profile.data).toEqual({ users: { profile: null } })
    expect(profile.errors?.[0]?.message).toBe('You must be authenticated to access this resource.')

    const mutation = await graphql({
      schema,
      source:
        'mutation { users { updateProfile(name: "API", location: "", jobTitle: "", timezone: "UTC", dateFormat: "", appearance: "light") { responseResult { succeeded errorCode slug message } } } }',
      contextValue: { req: { user: apiPrincipal, get: () => '1' }, res: {} }
    })
    expect(mutation.errors).toBeUndefined()
    expect(mutation.data).toEqual({
      users: {
        updateProfile: {
          responseResult: {
            succeeded: false,
            errorCode: 1019,
            slug: 'AuthRequired',
            message: 'You must be authenticated to access this resource.'
          }
        }
      }
    })

    const password = await graphql({
      schema,
      source: 'mutation { users { changePassword(current: "old", new: "new") { responseResult { succeeded errorCode slug message } } } }',
      contextValue: { req: { user: apiPrincipal, get: () => '1' }, res: {} }
    })
    expect(password.errors).toBeUndefined()
    expect(password.data).toEqual({
      users: {
        changePassword: {
          responseResult: {
            succeeded: false,
            errorCode: 1019,
            slug: 'AuthRequired',
            message: 'You must be authenticated to access this resource.'
          }
        }
      }
    })
  })

  it('returns a canonical success envelope for an ordinary human profile mutation', async () => {
    const humanPrincipal = { id: 7, ownershipUserId: 7, permissions: [] }
    operations.updateProfile.mockResolvedValue(undefined)

    const result = await graphql({
      schema,
      source:
        'mutation { users { updateProfile(name: "Human", location: "", jobTitle: "", pronouns: "they/them", timezone: "UTC", dateFormat: "", appearance: "light") { responseResult { succeeded errorCode slug message } } } }',
      contextValue: { req: { user: humanPrincipal, get: () => '7' }, res: {} }
    })
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({
      users: {
        updateProfile: {
          responseResult: expect.objectContaining({
            succeeded: true,
            errorCode: 0,
            slug: 'ok'
          })
        }
      }
    })
    expect(operations.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: humanPrincipal,
        expectedAccountId: '7',
        input: expect.objectContaining({ pronouns: 'they/them' })
      })
    )
    operations.getProfile.mockResolvedValue({ id: 7, pronouns: 'they/them' })
    const profile = await graphql({
      schema,
      source: '{ users { profile { id pronouns } } }',
      contextValue: { req: { user: humanPrincipal }, res: {} }
    })
    expect(profile.errors).toBeUndefined()
    expect(profile.data).toEqual({ users: { profile: { id: 7, pronouns: 'they/them' } } })
  })
})
