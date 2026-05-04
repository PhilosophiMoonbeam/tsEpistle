/* global WIKI */

module.exports = {
  Query: {
    async navigation () { return {} }
  },
  NavigationQuery: {
    async tree (obj, args, context, info) {
      return WIKI.models.navigation.getTree({ cache: false, locale: 'all', bypassAuth: true })
    },
    config (obj, args, context, info) {
      return WIKI.config.nav
    }
  }
}
