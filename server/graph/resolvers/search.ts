import graphHelper from '../../helpers/graph.ts'
import searchOperations from '../../operations/search.ts'

interface SearchEnginesArgs { orderBy?: string | null }
interface UpdateSearchEnginesArgs { engines: unknown }

const optionalString = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

export default {
  Query: { async search () { return {} } },
  Mutation: { async search () { return {} } },
  SearchQuery: {
    async searchEngines (_obj: unknown, args: SearchEnginesArgs) {
      return searchOperations.listEngines(optionalString(args.orderBy))
    }
  },
  SearchMutation: {
    async updateSearchEngines (_obj: unknown, args: UpdateSearchEnginesArgs) {
      try {
        await searchOperations.updateEngines(args.engines)
        return { responseResult: graphHelper.generateSuccess('Search Engines updated successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async rebuildIndex () {
      try {
        await searchOperations.rebuildIndex()
        return { responseResult: graphHelper.generateSuccess('Index rebuilt successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
