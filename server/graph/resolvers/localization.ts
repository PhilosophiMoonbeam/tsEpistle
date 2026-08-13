import localizationOperations from '../../operations/localization.ts'

interface TranslationArgs { locale: string, namespace: string }

export default {
  Query: {
    async localization () { return {} }
  },
  LocalizationQuery: {
    locales: localizationOperations.listLocales,
    config: localizationOperations.getConfig,
    translations (_obj: unknown, args: TranslationArgs) {
      return localizationOperations.getTranslations({ locale: args.locale, namespace: args.namespace })
    }
  }
}
