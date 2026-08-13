const graphHelper = require('../../helpers/graph')
const analyticsOperations = require('../../operations/analytics')

module.exports = {
  Query: {
    async analytics () { return {} }
  },
  Mutation: {
    async analytics () { return {} }
  },
  AnalyticsQuery: {
    async providers (obj, args) {
      return analyticsOperations.listProviders(args.isEnabled)
    }
  },
  AnalyticsMutation: {
    async updateProviders (obj, args) {
      try {
        await analyticsOperations.updateProviders(args.providers)
        return { responseResult: graphHelper.generateSuccess('Providers updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
