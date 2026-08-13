const graphHelper = require('../../helpers/graph')
const commentOperations = require('../../operations/comments')

module.exports = {
  Query: {
    async comments () { return {} }
  },
  Mutation: {
    async comments () { return {} }
  },
  CommentQuery: {
    providers: commentOperations.listProviders,
    list (obj, args, context) {
      return commentOperations.list({ requester: context.req.user, ...args })
    },
    single (obj, args, context) {
      return commentOperations.get({ requester: context.req.user, id: args.id })
    }
  },
  CommentMutation: {
    async create (obj, args, context) {
      try {
        const id = await commentOperations.create({ requester: context.req.user, ip: context.req.ip, input: args })
        return { responseResult: graphHelper.generateSuccess('New comment posted successfully'), id }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async update (obj, args, context) {
      try {
        const render = await commentOperations.update({ requester: context.req.user, ip: context.req.ip, input: args })
        return { responseResult: graphHelper.generateSuccess('Comment updated successfully'), render }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async delete (obj, args, context) {
      try {
        await commentOperations.remove({ requester: context.req.user, ip: context.req.ip, id: args.id })
        return { responseResult: graphHelper.generateSuccess('Comment deleted successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async updateProviders (obj, args) {
      try {
        await commentOperations.updateProviders(args.providers)
        return { responseResult: graphHelper.generateSuccess('Comment Providers updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
