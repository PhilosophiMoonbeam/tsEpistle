import { MapperKind, mapSchema } from '@graphql-tools/utils'
import { defaultFieldResolver, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql'

import {
  ApiPrincipalMutationError,
  isApiPrincipal,
  rejectApiPrincipalMutation
} from '../helpers/api-principal.ts'

const requestForContext = (context: unknown): { user: unknown; apiKeyRequest: boolean } => {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return { user: undefined, apiKeyRequest: false }
  const request = Reflect.get(context, 'req')
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { user: undefined, apiKeyRequest: false }
  const authContext = Reflect.get(request, 'authContext')
  const user = Reflect.get(request, 'user')
  return {
    user,
    apiKeyRequest: (typeof authContext === 'object' && authContext !== null && Reflect.get(authContext, 'kind') === 'apiKey') || isApiPrincipal(user)
  }
}

/**
 * Wrap every field on the GraphQL mutation root. This is deliberately
 * independent of @auth directives so an unprotected namespace, alias,
 * fragment, or selected operation cannot reach a mutation resolver with an
 * API-key principal.
 */
export const apiKeyMutationTransformer = (schema: GraphQLSchema): GraphQLSchema => {
  const mutationTypeName = schema.getMutationType()?.name
  if (!mutationTypeName) return schema

  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig, _fieldName, typeName) => {
      if (typeName !== mutationTypeName) return fieldConfig
      const resolve = fieldConfig.resolve ?? defaultFieldResolver
      fieldConfig.resolve = function (this: unknown, source: unknown, args: Record<string, unknown>, context: unknown, info: GraphQLResolveInfo) {
        const request = requestForContext(context)
        if (request.apiKeyRequest) throw new ApiPrincipalMutationError()
        rejectApiPrincipalMutation(request.user)
        return resolve.call(this, source, args, context, info)
      }
      return fieldConfig
    }
  })
}
