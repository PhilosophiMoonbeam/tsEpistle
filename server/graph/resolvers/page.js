const graphHelper = require('../../helpers/graph')
const pageOperations = require('../../operations/pages')
const systemOperations = require('../../operations/system')

module.exports = {
  Query: {
    async pages () { return {} }
  },
  Mutation: {
    async pages () { return {} }
  },
  PageQuery: {
    history (obj, args, context) {
      return pageOperations.getHistory({ requester: context.req.user, ...args })
    },
    version (obj, args, context) {
      return pageOperations.getVersion({ requester: context.req.user, ...args })
    },
    search (obj, args, context) {
      return pageOperations.search({ requester: context.req.user, ...args })
    },
    list (obj, args, context) {
      return pageOperations.list({ requester: context.req.user, ...args })
    },
    single (obj, args, context) {
      return pageOperations.get({ requester: context.req.user, id: args.id })
    },
    singleByPath (obj, args, context) {
      return pageOperations.getByPath({ requester: context.req.user, ...args })
    },
    tags (obj, args, context) {
      return pageOperations.listTags(context.req.user)
    },
    searchTags (obj, args, context) {
      return pageOperations.searchTags({ requester: context.req.user, query: args.query })
    },
    tree (obj, args, context) {
      return pageOperations.getTree({ requester: context.req.user, ...args })
    },
    links (obj, args, context) {
      return pageOperations.listLinks({ requester: context.req.user, locale: args.locale })
    },
    checkConflicts (obj, args, context) {
      return pageOperations.checkConflict({ requester: context.req.user, ...args })
    },
    conflictLatest (obj, args, context) {
      return pageOperations.getConflictLatest({ requester: context.req.user, id: args.id })
    }
  },
  PageMutation: {
    async create (obj, args, context) {
      try {
        const page = await pageOperations.create({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page created successfully.'), page }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async update (obj, args, context) {
      try {
        const page = await pageOperations.update({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been updated.'), page }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async convert (obj, args, context) {
      try {
        await pageOperations.convert({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been converted.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async move (obj, args, context) {
      try {
        await pageOperations.move({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('Page has been moved.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async delete (obj, args, context) {
      try {
        await pageOperations.remove({ requester: context.req.user, id: args.id })
        return { responseResult: graphHelper.generateSuccess('Page has been deleted.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async flushCache () {
      try {
        await systemOperations.flushPageCache()
        return { responseResult: graphHelper.generateSuccess('Pages Cache has been flushed successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async migrateToLocale (obj, args) {
      try {
        const count = await systemOperations.migratePagesToLocale(args)
        return { responseResult: graphHelper.generateSuccess('Migrated content to target locale successfully.'), count }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async rebuildTree () {
      try {
        await systemOperations.rebuildPageTree()
        return { responseResult: graphHelper.generateSuccess('Page tree rebuilt successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async restore (obj, args, context) {
      try {
        await pageOperations.restore({ requester: context.req.user, ...args })
        return { responseResult: graphHelper.generateSuccess('Page version restored successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  },
  Page: {
    tags (obj) {
      return pageOperations.getPageTags(obj.id)
    }
  }
}
