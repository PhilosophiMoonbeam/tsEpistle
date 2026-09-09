import { defaultFieldResolver, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql'
import { getDirective, MapperKind, mapSchema } from '@graphql-tools/utils'
import { pageAuthorizationContext, type PageAuthorizationContext, type PageVisibilityRecord } from '../../helpers/page-access.ts'
import { canViewRestrictedPageFields, isRestrictedPageField } from '../../helpers/page-field-projection.ts'
import type { AccessPage, PageRuleAuthority } from '../../helpers/group-access.ts'

type ResolverArgs = Record<string, unknown>
type Requester = Express.User | undefined

interface GraphAuth {
  checkAccess(user: Requester, permissions: readonly string[]): boolean
  checkPageAccess(user: Requester, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
  loadPageRuleAuthority(requester: Requester): Promise<PageRuleAuthority>
}

interface AuthorityEntry {
  requester: Requester
  promise: Promise<PageRuleAuthority>
}

const authoritiesByContext = new WeakMap<object, WeakMap<object, AuthorityEntry>>()

const wikiAuth = (): GraphAuth => WIKI.auth as GraphAuth

const requestUser = (context: unknown): Requester => {
  if (typeof context !== 'object' || context === null || !('req' in context)) return undefined
  const request = context.req
  return typeof request === 'object' && request !== null && 'user' in request ? request.user as Requester : undefined
}

const pageResource = (source: unknown): PageAuthorizationContext | null => {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return null
  return pageAuthorizationContext(source as PageVisibilityRecord)
}
export const requestPageRuleAuthority = (
  context: unknown,
  requester: Requester,
  operation?: GraphQLResolveInfo['operation']
): Promise<PageRuleAuthority> => {
  if (operation?.operation === 'subscription' || typeof context !== 'object' || context === null || !operation) {
    return wikiAuth().loadPageRuleAuthority(requester)
  }
  let authoritiesByOperation = authoritiesByContext.get(context)
  if (!authoritiesByOperation) {
    authoritiesByOperation = new WeakMap<object, AuthorityEntry>()
    authoritiesByContext.set(context, authoritiesByOperation)
  }
  const cached = authoritiesByOperation.get(operation)
  if (cached && cached.requester === requester) return cached.promise
  const promise = wikiAuth().loadPageRuleAuthority(requester)
  authoritiesByOperation.set(operation, { requester, promise })
  return promise
}

export const hasRequiredPermission = (user: unknown, requiredScopes: readonly unknown[]): boolean => {
  if (typeof user !== 'object' || user === null || !('permissions' in user) || !Array.isArray(user.permissions)) {
    return false
  }
  const permissions = user.permissions.filter((permission): permission is string => typeof permission === 'string')
  return requiredScopes.some(scope => typeof scope === 'string' && permissions.includes(scope))
}

const authDirectiveTransformer = (schema: GraphQLSchema, directiveName = 'auth'): GraphQLSchema => {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName) => {
      const parentType = schema.getType(typeName)
      const directive = getDirective(schema, fieldConfig, directiveName)?.[0] ||
        (parentType ? getDirective(schema, parentType, directiveName)?.[0] : undefined)
      const requiredScopes = directive?.requires
      const restrictedPageField =
        (typeName === 'Page' || typeName === 'PageListItem') && isRestrictedPageField(fieldName)
      if ((!Array.isArray(requiredScopes) || requiredScopes.length === 0) && !restrictedPageField) {
        return fieldConfig
      }

      const resolve = fieldConfig.resolve || defaultFieldResolver
      fieldConfig.resolve = async function (
        this: unknown,
        source: unknown,
        args: ResolverArgs,
        context: unknown,
        info: GraphQLResolveInfo
      ) {
        const user = requestUser(context)
        if (!user) {
          throw new Error('Unauthorized')
        }
        if (restrictedPageField) {
          const authority = await requestPageRuleAuthority(context, user, info.operation)
          if (!canViewRestrictedPageFields({ requester: user, page: source, authority })) {
            throw new Error('Forbidden')
          }
          return resolve.call(this, source, args, context, info)
        }
        const resource = pageResource(source)
        const allowed = resource
          ? wikiAuth().checkPageAccess(user, requiredScopes, resource, await requestPageRuleAuthority(context, user, info.operation))
          : wikiAuth().checkAccess(user, requiredScopes)
        if (!allowed) {
          throw new Error('Forbidden')
        }
        return resolve.call(this, source, args, context, info)
      }
      return fieldConfig
    }
  })
}

export { authDirectiveTransformer }
