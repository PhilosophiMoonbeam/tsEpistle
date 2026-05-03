const _ = require('lodash')

/* global WIKI */

module.exports = {
  Query: {
    async localization() { return {} }
  },
  LocalizationQuery: {
    async locales(obj, args, context, info) {
      let remoteLocales = await WIKI.cache.get('locales')
      let localLocales = await WIKI.models.locales.query().select('code', 'isRTL', 'name', 'nativeName', 'createdAt', 'updatedAt', 'availability')
      remoteLocales = remoteLocales || localLocales
      return _.map(remoteLocales, rl => {
        let isInstalled = _.some(localLocales, ['code', rl.code])
        return {
          ...rl,
          isInstalled,
          installDate: isInstalled ? _.find(localLocales, ['code', rl.code]).updatedAt : null
        }
      })
    },
    async config(obj, args, context, info) {
      return {
        locale: WIKI.config.lang.code,
        autoUpdate: WIKI.config.lang.autoUpdate,
        namespacing: WIKI.config.lang.namespacing,
        namespaces: WIKI.config.lang.namespaces
      }
    },
    translations (obj, args, context, info) {
      return WIKI.lang.getByNamespace(args.locale, args.namespace)
    }
  }
}
