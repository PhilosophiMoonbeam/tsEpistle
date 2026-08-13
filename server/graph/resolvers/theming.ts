import graphHelper from '../../helpers/graph.ts'
import themingOperations from '../../operations/theming.ts'

type ResolverArgs = Record<string, unknown>

export default {
  Query: { async theming () { return {} } },
  Mutation: { async theming () { return {} } },
  ThemingQuery: {
    async themes () {
      return [{ key: 'default', title: 'Default', author: 'requarks.io' }]
    },
    config: themingOperations.getConfig
  },
  ThemingMutation: {
    async setConfig (_obj: unknown, args: ResolverArgs) {
      try {
        await themingOperations.updateConfig(args)
        return { responseResult: graphHelper.generateSuccess('Theme config updated') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
