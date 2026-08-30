import graphHelper from '../../helpers/graph.ts'
import pageOperations from '../../operations/pages.ts'
import systemOperations from '../../operations/system.ts'

type ResolverArgs = Record<string, unknown>
interface ResolverContext {
  req: { user: Express.User; sessionID: string }
}

const operationContext = (context: ResolverContext): { requester: Express.User; sessionId: string } => ({
  requester: context.req.user,
  sessionId: context.req.sessionID
})

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
      return pageOperations.search({ requester: context.req.user, ...args })
    },
    list(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.list({ requester: context.req.user, ...args })
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
      return pageOperations.searchTags({ requester: context.req.user, query: args.query })
    },
    tree(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.getTree({ requester: context.req.user, ...args })
    },
    links(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.listLinks({ requester: context.req.user, locale: args.locale })
    },
    checkConflicts(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.checkConflict({ requester: context.req.user, ...args })
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
        await pageOperations.remove({ ...operationContext(context), id: args.id, expectedSourceRevision: args.expectedSourceRevision })
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
    async flushCache() {
      try {
        await systemOperations.flushPageCache()
        return { responseResult: graphHelper.generateSuccess('Pages Cache has been flushed successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async migrateToLocale(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const count = await systemOperations.migratePagesToLocale({ ...args, requester: context.req.user })
        return { responseResult: graphHelper.generateSuccess('Migrated content to target locale successfully.'), count }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async rebuildTree() {
      try {
        await systemOperations.rebuildPageTree()
        return { responseResult: graphHelper.generateSuccess('Page tree rebuilt successfully.') }
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
    }
  }
}
