import graphHelper from '../../helpers/graph.ts'
import analyticsOperations from '../../operations/analytics.ts'

interface ProvidersArgs { isEnabled?: boolean | null }
interface UpdateProvidersArgs { providers: unknown }

const optionalBoolean = (value: boolean | null | undefined): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

export default {
  Query: {
    async analytics () { return {} }
  },
  Mutation: {
    async analytics () { return {} }
  },
  AnalyticsQuery: {
    async providers (_obj: unknown, args: ProvidersArgs) {
      return analyticsOperations.listProviders(optionalBoolean(args.isEnabled))
    }
  },
  AnalyticsMutation: {
    async updateProviders (_obj: unknown, args: UpdateProvidersArgs) {
      try {
        await analyticsOperations.updateProviders(args.providers)
        return { responseResult: graphHelper.generateSuccess('Providers updated successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
