import graphHelper from '../../helpers/graph.ts'
import userOperations from '../../operations/users.ts'

type ResolverArgs = Record<string, unknown>
interface ResolverContext { req: { user: Express.User } }

export default {
  Query: { async users () { return {} } },
  Mutation: { async users () { return {} } },
  UserQuery: {
    list (_obj: unknown, args: ResolverArgs) { return userOperations.list(args) },
    search (_obj: unknown, args: ResolverArgs) { return userOperations.search(args.query) },
    single (_obj: unknown, args: ResolverArgs) { return userOperations.get(args.id) },
    profile (_obj: unknown, _args: ResolverArgs, context: ResolverContext) { return userOperations.getProfile(context.req.user) },
    lastLogins: userOperations.lastLogins
  },
  UserMutation: {
    async create (_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await userOperations.create({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('User created successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async delete (_obj: unknown, args: ResolverArgs) {
      try {
        await userOperations.remove({ id: args.id, replaceId: args.replaceId })
        return { responseResult: graphHelper.generateSuccess('User deleted successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async update (_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        await userOperations.update({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('User updated successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async verify (_obj: unknown, args: ResolverArgs) {
      try {
        await userOperations.verify(args.id)
        return { responseResult: graphHelper.generateSuccess('User verified successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async activate (_obj: unknown, args: ResolverArgs) {
      try {
        await userOperations.setActive({ id: args.id, isActive: true })
        return { responseResult: graphHelper.generateSuccess('User activated successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async deactivate (_obj: unknown, args: ResolverArgs) {
      try {
        await userOperations.setActive({ id: args.id, isActive: false })
        return { responseResult: graphHelper.generateSuccess('User deactivated successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async enableTFA (_obj: unknown, args: ResolverArgs) {
      try {
        await userOperations.setTfa({ id: args.id, enabled: true })
        return { responseResult: graphHelper.generateSuccess('User 2FA enabled successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async disableTFA (_obj: unknown, args: ResolverArgs) {
      try {
        await userOperations.setTfa({ id: args.id, enabled: false })
        return { responseResult: graphHelper.generateSuccess('User 2FA disabled successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    resetPassword () { return false },
    async updateProfile (_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const jwt = await userOperations.updateProfile({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('User profile updated successfully'), jwt }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async changePassword (_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const jwt = await userOperations.changePassword({ requester: context.req.user, current: args.current, newPassword: args.new })
        return { responseResult: graphHelper.generateSuccess('Password changed successfully'), jwt }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    }
  },
  User: {
    groups: userOperations.listUserGroups
  },
  UserProfile: {
    groups: userOperations.listProfileGroups,
    pagesTotal: userOperations.countPages
  }
}
