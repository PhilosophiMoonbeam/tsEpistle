import graphHelper from '../../helpers/graph.ts'
import pageOperations from '../../operations/pages.ts'
import systemOperations from '../../operations/system.ts'
import { assertPageUnlocked } from '../../operations/page-protection.ts'

type ResolverArgs = Record<string, unknown>
interface ResolverContext {
  req: { user: Express.User; sessionID: string }
}

const requireUnlocked = (context: ResolverContext, pageId: unknown): Promise<void> => {
  if (typeof pageId !== 'number' || !Number.isSafeInteger(pageId) || pageId < 1) throw new TypeError('pageId must be a positive integer')
  return assertPageUnlocked({ requester: context.req.user, pageId, sessionId: context.req.sessionID })
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
    async history(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await requireUnlocked(context, args.id)
      return pageOperations.getHistory({ requester: context.req.user, ...args })
    },
    async version(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await requireUnlocked(context, args.pageId)
      return pageOperations.getVersion({ requester: context.req.user, ...args })
    },
    search(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.search({ requester: context.req.user, ...args })
    },
    list(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      return pageOperations.list({ requester: context.req.user, ...args })
    },
    async single(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await requireUnlocked(context, args.id)
      return pageOperations.get({ requester: context.req.user, id: args.id })
    },
    async singleByPath(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      const page = await pageOperations.getByPath({ requester: context.req.user, ...args })
      await requireUnlocked(context, Reflect.get(page, 'id'))
      return page
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
    async conflictLatest(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await requireUnlocked(context, args.id)
      return pageOperations.getConflictLatest({ requester: context.req.user, id: args.id })
    }
  },
  PageMutation: {
    async create(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const page = await pageOperations.create({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page created successfully.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async update(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await requireUnlocked(context, args.id)
        const page = await pageOperations.update({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been updated.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async convert(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await requireUnlocked(context, args.id)
        await pageOperations.convert({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been converted.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async move(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await requireUnlocked(context, args.id)
        await pageOperations.move({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been moved.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async delete(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await requireUnlocked(context, args.id)
        await pageOperations.remove({ requester: context.req.user, id: args.id, expectedSourceRevision: args.expectedSourceRevision })
        return { responseResult: graphHelper.generateSuccess('Page has been deleted.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async changeVisibility(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await requireUnlocked(context, args.id)
        const page = await pageOperations.changeVisibility({ requester: context.req.user, ...args })
        return { responseResult: graphHelper.generateSuccess('Page visibility has been updated.'), page }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async transferOwnership(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await requireUnlocked(context, args.id)
        const page = await pageOperations.transferOwnership({ requester: context.req.user, ...args })
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
    async migrateToLocale(_obj: unknown, args: ResolverArgs) {
      try {
        const count = await systemOperations.migratePagesToLocale(args)
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
        await requireUnlocked(context, args.pageId)
        await pageOperations.restore({ requester: context.req.user, ...args })
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
