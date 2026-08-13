const graphHelper = require('../../helpers/graph')
const themingOperations = require('../../operations/theming')

module.exports = {
  Query: {
    async theming () { return {} }
  },
  Mutation: {
    async theming () { return {} }
  },
  ThemingQuery: {
    async themes () {
      return [{ key: 'default', title: 'Default', author: 'requarks.io' }]
    },
    config: themingOperations.getConfig
  },
  ThemingMutation: {
    async setConfig (obj, args) {
      try {
        await themingOperations.updateConfig(args)
        return { responseResult: graphHelper.generateSuccess('Theme config updated') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
