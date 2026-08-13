import graphHelper from '../../helpers/graph.ts'
import commentOperations from '../../operations/comments.ts'

type ResolverArgs = Record<string, unknown>
interface CommentListArgs { locale: string, path: string }
interface CommentIdArgs { id: number }
interface ProviderArgs { providers?: unknown }
interface ResolverContext { req: { user: Express.User, ip: string } }

export default {
  Query: {
    async comments () { return {} }
  },
  Mutation: {
    async comments () { return {} }
  },
  CommentQuery: {
    providers: commentOperations.listProviders,
    list (_obj: unknown, args: CommentListArgs, context: ResolverContext) {
      return commentOperations.list({
        requester: context.req.user,
        locale: args.locale,
        path: args.path
      })
    },
    single (_obj: unknown, args: CommentIdArgs, context: ResolverContext) {
      return commentOperations.get({ requester: context.req.user, id: args.id })
    }
  },
  CommentMutation: {
    async create (_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const id = await commentOperations.create({ requester: context.req.user, ip: context.req.ip, input: args })
        return { responseResult: graphHelper.generateSuccess('New comment posted successfully'), id }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async update (_obj: unknown, args: ResolverArgs, context: ResolverContext) {
      try {
        const render = await commentOperations.update({ requester: context.req.user, ip: context.req.ip, input: args })
        return { responseResult: graphHelper.generateSuccess('Comment updated successfully'), render }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async delete (_obj: unknown, args: CommentIdArgs, context: ResolverContext) {
      try {
        await commentOperations.remove({ requester: context.req.user, ip: context.req.ip, id: args.id })
        return { responseResult: graphHelper.generateSuccess('Comment deleted successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async updateProviders (_obj: unknown, args: ProviderArgs) {
      try {
        await commentOperations.updateProviders(args.providers)
        return { responseResult: graphHelper.generateSuccess('Comment Providers updated successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
