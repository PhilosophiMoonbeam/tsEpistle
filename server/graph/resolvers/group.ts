import graphHelper from '../../helpers/graph.ts'
import groupOperations from '../../operations/groups.ts'

type ResolverArgs = Record<string, unknown>
interface ResolverContext {
  req: { user: Express.User }
}

export default {
  Query: {
    async groups() {
      return {}
    }
  },
  Mutation: {
    async groups() {
      return {}
    }
  },
  GroupQuery: {
    list: groupOperations.list,
    async single(_obj: unknown, args: ResolverArgs) {
      return groupOperations.get(args.id)
    }
  },
  GroupMutation: {
    async assignUser(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await groupOperations.assignUser({ requester: context.req.user, groupId: args.groupId, userId: args.userId })
      return { responseResult: graphHelper.generateSuccess('User has been assigned to group.') }
    },
    async create(_obj: unknown, args: ResolverArgs) {
      const group = await groupOperations.create(args.name)
      return { responseResult: graphHelper.generateSuccess('Group created successfully.'), group }
    },
    async delete(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await groupOperations.remove({ requester: context.req.user, id: args.id })
      return { responseResult: graphHelper.generateSuccess('Group has been deleted.') }
    },
    async unassignUser(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await groupOperations.unassignUser({ requester: context.req.user, groupId: args.groupId, userId: args.userId })
      return { responseResult: graphHelper.generateSuccess('User has been unassigned from group.') }
    },
    async update(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      await groupOperations.update({ requester: context.req.user, ...args })
      return { responseResult: graphHelper.generateSuccess('Group has been updated.') }
    }
  },
  Group: {
    users: groupOperations.listUsers
  }
}
