const graphHelper = require('../../helpers/graph')
const assetOperations = require('../../operations/assets')

module.exports = {
  Query: {
    async assets () { return {} }
  },
  Mutation: {
    async assets () { return {} }
  },
  AssetQuery: {
    list (obj, args, context) {
      return assetOperations.list({ requester: context.req.user, ...args })
    },
    folders (obj, args, context) {
      return assetOperations.listFolders({ requester: context.req.user, ...args })
    }
  },
  AssetMutation: {
    async createFolder (obj, args) {
      try {
        await assetOperations.createFolder(args)
        return { responseResult: graphHelper.generateSuccess('Asset Folder has been created successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async renameAsset (obj, args, context) {
      try {
        await assetOperations.rename({ requester: context.req.user, ...args })
        return { responseResult: graphHelper.generateSuccess('Asset has been renamed successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async deleteAsset (obj, args, context) {
      try {
        await assetOperations.remove({ requester: context.req.user, id: args.id })
        return { responseResult: graphHelper.generateSuccess('Asset has been deleted successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async flushTempUploads () {
      try {
        await assetOperations.flushTemporaryUploads()
        return { responseResult: graphHelper.generateSuccess('Temporary Uploads have been flushed successfully.') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
