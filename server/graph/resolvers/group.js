const graphHelper = require('../../helpers/graph')
const groupOperations = require('../../operations/groups')

module.exports = {
  Query: {
    async groups () { return {} }
  },
  Mutation: {
    async groups () { return {} }
  },
  GroupQuery: {
    list: groupOperations.list,
    async single (obj, args) {
      return groupOperations.get(args.id)
    }
  },
  GroupMutation: {
    async assignUser (obj, args, { req }) {
      await groupOperations.assignUser({
        requester: req.user,
        groupId: args.groupId,
        userId: args.userId
      })
      return {
        responseResult: graphHelper.generateSuccess('User has been assigned to group.')
      }
    },
    async create (obj, args) {
      const group = await groupOperations.create(args.name)
      return {
        responseResult: graphHelper.generateSuccess('Group created successfully.'),
        group
      }
    },
    async delete (obj, args) {
      await groupOperations.remove(args.id)
      return {
        responseResult: graphHelper.generateSuccess('Group has been deleted.')
      }
    },
    async unassignUser (obj, args) {
      await groupOperations.unassignUser({
        groupId: args.groupId,
        userId: args.userId
      })
      return {
        responseResult: graphHelper.generateSuccess('User has been unassigned from group.')
      }
    },
    async update (obj, args, { req }) {
      await groupOperations.update({
        requester: req.user,
        ...args
      })
      return {
        responseResult: graphHelper.generateSuccess('Group has been updated.')
      }
    }
  },
  Group: {
    users: groupOperations.listUsers
  }
}
