const graphHelper = require('../../helpers/graph')
const renderingOperations = require('../../operations/rendering')

module.exports = {
  Query: {
    async rendering () { return {} }
  },
  Mutation: {
    async rendering () { return {} }
  },
  RenderingQuery: {
    async renderers (obj, args) {
      return renderingOperations.listRenderers(args.orderBy)
    }
  },
  RenderingMutation: {
    async updateRenderers (obj, args) {
      try {
        await renderingOperations.updateRenderers(args.renderers)
        return { responseResult: graphHelper.generateSuccess('Renderers updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
