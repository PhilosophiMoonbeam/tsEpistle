const graphHelper = require('../../helpers/graph')
const userOperations = require('../../operations/users')

module.exports = {
  Query: {
    async users () { return {} }
  },
  Mutation: {
    async users () { return {} }
  },
  UserQuery: {
    list (obj, args) { return userOperations.list(args) },
    search (obj, args) { return userOperations.search(args.query) },
    single (obj, args) { return userOperations.get(args.id) },
    profile (obj, args, context) { return userOperations.getProfile(context.req.user) },
    lastLogins: userOperations.lastLogins
  },
  UserMutation: {
    async create (obj, args, context) {
      try {
        await userOperations.create({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('User created successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async delete (obj, args) {
      try {
        await userOperations.remove({ id: args.id, replaceId: args.replaceId })
        return { responseResult: graphHelper.generateSuccess('User deleted successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async update (obj, args, context) {
      try {
        await userOperations.update({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('User updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async verify (obj, args) {
      try {
        await userOperations.verify(args.id)
        return { responseResult: graphHelper.generateSuccess('User verified successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async activate (obj, args) {
      try {
        await userOperations.setActive({ id: args.id, isActive: true })
        return { responseResult: graphHelper.generateSuccess('User activated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async deactivate (obj, args) {
      try {
        await userOperations.setActive({ id: args.id, isActive: false })
        return { responseResult: graphHelper.generateSuccess('User deactivated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async enableTFA (obj, args) {
      try {
        await userOperations.setTfa({ id: args.id, enabled: true })
        return { responseResult: graphHelper.generateSuccess('User 2FA enabled successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async disableTFA (obj, args) {
      try {
        await userOperations.setTfa({ id: args.id, enabled: false })
        return { responseResult: graphHelper.generateSuccess('User 2FA disabled successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    resetPassword () { return false },
    async updateProfile (obj, args, context) {
      try {
        const jwt = await userOperations.updateProfile({ requester: context.req.user, input: args })
        return { responseResult: graphHelper.generateSuccess('User profile updated successfully'), jwt }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async changePassword (obj, args, context) {
      try {
        const jwt = await userOperations.changePassword({ requester: context.req.user, current: args.current, newPassword: args.new })
        return { responseResult: graphHelper.generateSuccess('Password changed successfully'), jwt }
      } catch (err) {
        return graphHelper.generateError(err)
      }
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
