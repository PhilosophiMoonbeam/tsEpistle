const localizationOperations = require('../../operations/localization')

module.exports = {
  Query: {
    async localization () { return {} }
  },
  LocalizationQuery: {
    locales: localizationOperations.listLocales,
    config: localizationOperations.getConfig,
    translations (obj, args) {
      return localizationOperations.getTranslations(args)
    }
  }
}
