import { defaultFieldResolver, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql'
import { getDirective, MapperKind, mapSchema } from '@graphql-tools/utils'

type ResolverArgs = Record<string, unknown>

const hasRequiredPermission = (user: unknown, requiredScopes: readonly unknown[]): boolean => {
  if (typeof user !== 'object' || user === null || !('permissions' in user) || !Array.isArray(user.permissions)) {
    return false
  }
  const permissions = user.permissions.filter((permission): permission is string => typeof permission === 'string')
  return requiredScopes.some(scope => typeof scope === 'string' && permissions.includes(scope))
}

const requestUser = (context: unknown): unknown => {
  if (typeof context !== 'object' || context === null || !('req' in context)) {
    return undefined
  }
  const request = context.req
  return typeof request === 'object' && request !== null && 'user' in request ? request.user : undefined
}

const authDirectiveTransformer = (schema: GraphQLSchema, directiveName = 'auth'): GraphQLSchema => {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig, _fieldName, typeName) => {
      const parentType = schema.getType(typeName)
      const directive = getDirective(schema, fieldConfig, directiveName)?.[0] ||
        (parentType ? getDirective(schema, parentType, directiveName)?.[0] : undefined)
      const requiredScopes = directive?.requires
      if (!Array.isArray(requiredScopes) || requiredScopes.length === 0) {
        return fieldConfig
      }

      const resolve = fieldConfig.resolve || defaultFieldResolver
      fieldConfig.resolve = function (this: unknown, source: unknown, args: ResolverArgs, context: unknown, info: GraphQLResolveInfo) {
        const user = requestUser(context)
        if (!user) {
          throw new Error('Unauthorized')
        }
        if (!hasRequiredPermission(user, requiredScopes)) {
          throw new Error('Forbidden')
        }
        return resolve.call(this, source, args, context, info)
      }
      return fieldConfig
    }
  })
}

export { authDirectiveTransformer, hasRequiredPermission }
