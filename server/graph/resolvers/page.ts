import type { GraphQLResolveInfo } from 'graphql'
import graphHelper from '../../helpers/graph.ts'
import { canViewRestrictedPageFields } from '../../helpers/page-field-projection.ts'
import { requestPageRuleAuthority } from '../directives/auth.ts'
import pageOperations, { type PageOperationInput } from '../../operations/pages.ts'

type ResolverArgs = Record<string, unknown>
interface ResolverContext {
  req: { user?: Express.User; sessionID?: string }
}

const operationContext = (context: ResolverContext): Pick<PageOperationInput, 'requester' | 'sessionId'> => ({
  ...(context.req.user === undefined ? {} : { requester: context.req.user }),
  ...(context.req.sessionID === undefined ? {} : { sessionId: context.req.sessionID })
})

const canViewPageContacts = async (
  page: unknown,
  context: ResolverContext,
  operation?: GraphQLResolveInfo['operation']
): Promise<boolean> => {
  if (!context.req.user) return false
  const authority = await requestPageRuleAuthority(context, context.req.user, operation)
  return canViewRestrictedPageFields({ requester: context.req.user, page, authority })
}

const pageContact = async (
  page: unknown,
  field: 'authorEmail' | 'creatorEmail',
  context: ResolverContext,
  info?: GraphQLResolveInfo
): Promise<string | null> => {
  if (!(await canViewPageContacts(page, context, info?.operation))) return null
  const value = Reflect.get(page as object, field)
  return typeof value === 'string' ? value : null
}

export default {
  Query: {
    async pages() {
      return {}
    }
  },
  Mutation: {
    async pages() {
      return {}
    }
  },
  PageQuery: {
    history(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.getHistory({ ...operationContext(context), ...args })
    },
    version(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.getVersion({ ...operationContext(context), ...args })
    },
    search(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.search({ ...operationContext(context), ...args })
    },
    list(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.list({ ...operationContext(context), ...args })
    },
    single(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.get({ ...operationContext(context), id: args.id })
    },
    singleByPath(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.getByPath({ ...operationContext(context), ...args })
    },
    tags(_obj: unknown, _args: ResolverArgs, context: ResolverContext) {
      return pageOperations.listTags(context.req.user)
    },
    searchTags(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.searchTags({ ...operationContext(context), query: args.query })
    },
    tree(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.getTree({ ...operationContext(context), ...args })
    },
    links(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.listLinks({ ...operationContext(context), locale: args.locale })
    },
    checkConflicts(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.checkConflict({ ...operationContext(context), ...args })
    },
    conflictLatest(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.getConflictLatest({ ...operationContext(context), id: args.id })
    }
  },
  PageMutation: {
    async create(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const page = await pageOperations.create({ ...operationContext(context), input: args })
        return { responseResult: graphHelper.generateSuccess('Page created successfully.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async update(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const page = await pageOperations.update({ ...operationContext(context), input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been updated.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async convert(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await pageOperations.convert({ ...operationContext(context), input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been converted.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async move(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await pageOperations.move({ ...operationContext(context), input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been moved.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async delete(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await pageOperations.remove({
          ...operationContext(context),
          id: args.id,
          ...(args.expectedSourceRevision === undefined ? {} : { expectedSourceRevision: args.expectedSourceRevision })
        })
        return { responseResult: graphHelper.generateSuccess('Page has been deleted.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async changeVisibility(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const page = await pageOperations.changeVisibility({ ...operationContext(context), ...args })
        return { responseResult: graphHelper.generateSuccess('Page visibility has been updated.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async transferOwnership(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const page = await pageOperations.transferOwnership({ ...operationContext(context), ...args })
        return { responseResult: graphHelper.generateSuccess('Page ownership has been transferred.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async restore(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await pageOperations.restore({ ...operationContext(context), ...args })
        return { responseResult: graphHelper.generateSuccess('Page version restored successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  },
  Page: {
    tags(page: { id: number }) {
      return pageOperations.getPageTags(page.id)
    },
    authorEmail(page: unknown, _args: ResolverArgs, context: ResolverContext, info: GraphQLResolveInfo) {
      return pageContact(page, 'authorEmail', context, info)
    },
    creatorEmail(page: unknown, _args: ResolverArgs, context: ResolverContext, info: GraphQLResolveInfo) {
      return pageContact(page, 'creatorEmail', context, info)
    }
  }
}
