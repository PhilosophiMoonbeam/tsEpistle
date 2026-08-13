import siteOperations from '../../operations/site.ts'

export default {
  Query: {
    async site () { return {} }
  },
  SiteQuery: {
    config: siteOperations.getConfig
  }
}
