const _ = require('lodash')

const { ApplicationError } = require('./errors')

/* global WIKI */

const listLocales = async () => {
  let remoteLocales = await WIKI.cache.get('locales')
  const localLocales = await WIKI.models.locales.query().select('code', 'isRTL', 'name', 'nativeName', 'createdAt', 'updatedAt', 'availability')
  remoteLocales = remoteLocales || localLocales
  return remoteLocales.map(locale => {
    const installed = localLocales.find(local => local.code === locale.code)
    return {
      ...locale,
      isInstalled: Boolean(installed),
      installDate: installed ? installed.updatedAt : null
    }
  })
}

const getConfig = () => ({
  locale: WIKI.config.lang.code,
  autoUpdate: WIKI.config.lang.autoUpdate,
  namespacing: WIKI.config.lang.namespacing,
  namespaces: WIKI.config.lang.namespaces
})

const getTranslations = ({ locale, namespace }) => WIKI.lang.getByNamespace(locale, namespace)

const updateConfig = async input => {
  if (!input || !_.isPlainObject(input) || !_.isString(input.locale) || input.locale.length < 1 ||
    !_.isBoolean(input.autoUpdate) || !_.isBoolean(input.namespacing) ||
    !Array.isArray(input.namespaces) || input.namespaces.some(namespace => !_.isString(namespace) || namespace.length < 1)) {
    throw new ApplicationError('Invalid locale config payload', { code: 'INVALID_LOCALE_CONFIGURATION' })
  }
  WIKI.config.lang.code = input.locale
  WIKI.config.lang.autoUpdate = input.autoUpdate
  WIKI.config.lang.namespacing = input.namespacing
  WIKI.config.lang.namespaces = _.union(input.namespaces, [input.locale])
  const locale = await WIKI.models.locales.query().select('isRTL').where('code', input.locale).first()
  if (!locale) throw new ApplicationError('Locale does not exist', { code: 'LOCALE_NOT_FOUND', status: 404 })
  WIKI.config.lang.rtl = locale.isRTL
  await WIKI.configSvc.saveToDb(['lang'])
  await WIKI.lang.setCurrentLocale(input.locale)
  await WIKI.lang.refreshNamespaces()
  await WIKI.cache.del('nav:locales')
}

const download = async code => {
  if (!_.isString(code) || code.length < 1) {
    throw new ApplicationError('locale code is required', { code: 'INVALID_LOCALE_CODE' })
  }
  const job = await WIKI.scheduler.registerJob({
    name: 'fetch-graph-locale',
    immediate: true
  }, code)
  await job.finished
}

module.exports = { download, getConfig, getTranslations, listLocales, updateConfig }
