const siteOperations = require('../../operations/site')

module.exports = {
  Query: {
    async site () { return {} }
  },
  SiteQuery: {
    config: siteOperations.getConfig
  }
}
