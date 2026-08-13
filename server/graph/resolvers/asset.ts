import graphHelper from '../../helpers/graph.ts'
import assetOperations from '../../operations/assets.ts'

interface Requester extends Express.User {
  id: number
  name: string
  email: string
}
interface ResolverContext { req: { user: Express.User } }
interface ListArgs { folderId: number, kind: string }
interface FolderArgs { parentFolderId: number }
interface CreateFolderArgs { parentFolderId: number, slug: string, name?: string | null }
interface RenameAssetArgs { id: number, filename: string }
interface DeleteAssetArgs { id: number }

const normalizeRequester = (user: Express.User): Requester => {
  if (typeof user.id !== 'number' || typeof user.name !== 'string' || typeof user.email !== 'string') {
    throw new TypeError('Authenticated requester is missing an id, name, or email')
  }
  return {
    ...user,
    id: user.id,
    name: user.name,
    email: user.email
  }
}

export default {
  Query: {
    async assets () { return {} }
  },
  Mutation: {
    async assets () { return {} }
  },
  AssetQuery: {
    list (_obj: unknown, args: ListArgs, context: ResolverContext) {
      return assetOperations.list({
        requester: normalizeRequester(context.req.user),
        folderId: args.folderId,
        kind: args.kind
      })
    },
    folders (_obj: unknown, args: FolderArgs, context: ResolverContext) {
      return assetOperations.listFolders({
        requester: normalizeRequester(context.req.user),
        parentFolderId: args.parentFolderId
      })
    }
  },
  AssetMutation: {
    async createFolder (_obj: unknown, args: CreateFolderArgs) {
      try {
        await assetOperations.createFolder({ slug: args.slug, parentFolderId: args.parentFolderId })
        return { responseResult: graphHelper.generateSuccess('Asset Folder has been created successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async renameAsset (_obj: unknown, args: RenameAssetArgs, context: ResolverContext) {
      try {
        await assetOperations.rename({
          requester: normalizeRequester(context.req.user),
          id: args.id,
          filename: args.filename
        })
        return { responseResult: graphHelper.generateSuccess('Asset has been renamed successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async deleteAsset (_obj: unknown, args: DeleteAssetArgs, context: ResolverContext) {
      try {
        await assetOperations.remove({ requester: normalizeRequester(context.req.user), id: args.id })
        return { responseResult: graphHelper.generateSuccess('Asset has been deleted successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async flushTempUploads () {
      try {
        await assetOperations.flushTemporaryUploads()
        return { responseResult: graphHelper.generateSuccess('Temporary Uploads have been flushed successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
