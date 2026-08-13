const graphHelper = require('../../helpers/graph')
const loggingOperations = require('../../operations/logging')

/* global WIKI */

module.exports = {
  Query: {
    async logging () { return {} }
  },
  Mutation: {
    async logging () { return {} }
  },
  Subscription: {
    loggingLiveTrail: {
      subscribe: () => WIKI.GQLEmitter.asyncIterator('livetrail')
    }
  },
  LoggingQuery: {
    async loggers (obj, args) {
      return loggingOperations.listLoggers(args.orderBy)
    }
  },
  LoggingMutation: {
    async updateLoggers (obj, args) {
      try {
        await loggingOperations.updateLoggers(args.loggers)
        return { responseResult: graphHelper.generateSuccess('Loggers updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
