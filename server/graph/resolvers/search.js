const graphHelper = require('../../helpers/graph')
const searchOperations = require('../../operations/search')

module.exports = {
  Query: {
    async search () { return {} }
  },
  Mutation: {
    async search () { return {} }
  },
  SearchQuery: {
    async searchEngines (obj, args) {
      return searchOperations.listEngines(args.orderBy)
    }
  },
  SearchMutation: {
    async updateSearchEngines (obj, args) {
      try {
        await searchOperations.updateEngines(args.engines)
        return { responseResult: graphHelper.generateSuccess('Search Engines updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async rebuildIndex () {
      try {
        await searchOperations.rebuildIndex()
        return { responseResult: graphHelper.generateSuccess('Index rebuilt successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
