import _ from 'lodash'

import errors from './errors.ts'

const { ApplicationError } = errors

interface Locale {
  code: string
  isRTL: boolean
  updatedAt: unknown
  [key: string]: unknown
}

interface LocaleQuery {
  select(...columns: string[]): LocaleQuery & PromiseLike<Locale[]>
  where(column: string, value: unknown): LocaleQuery
  first(): Promise<Locale | undefined>
}

interface LocaleConfigInput {
  locale: string
  autoUpdate: boolean
  namespacing: boolean
  namespaces: string[]
}

const getRuntime = () => {
  const wiki = WIKI
  return {
    cache: wiki.cache as { get(key: string): Promise<Locale[] | undefined>, del(key: string): Promise<unknown> },
    localesModel: (wiki.models as { locales: { query(): LocaleQuery } }).locales,
    config: wiki.config as { lang: LocaleConfigInput & { code: string, rtl: boolean } },
    language: wiki.lang as {
      getByNamespace(locale: string, namespace: string): unknown
      setCurrentLocale(locale: string): Promise<unknown>
      refreshNamespaces(): Promise<unknown>
    },
    configService: wiki.configSvc as { saveToDb(keys: string[]): Promise<unknown> },
    scheduler: wiki.scheduler as { registerJob(options: Record<string, unknown>, code: string): Promise<{ finished: Promise<unknown> }> }
  }
}

const listLocales = async () => {
  const { cache, localesModel } = getRuntime()
  let remoteLocales = await cache.get('locales')
  const localLocales = await localesModel.query().select('code', 'isRTL', 'name', 'nativeName', 'createdAt', 'updatedAt', 'availability')
  remoteLocales = remoteLocales || localLocales
  return remoteLocales.map(locale => {
    const installed = localLocales.find(local => local.code === locale.code)
    return { ...locale, isInstalled: Boolean(installed), installDate: installed ? installed.updatedAt : null }
  })
}

const getConfig = () => {
  const { config } = getRuntime()
  return {
    locale: config.lang.code,
    autoUpdate: config.lang.autoUpdate,
    namespacing: config.lang.namespacing,
    namespaces: config.lang.namespaces
  }
}

const getTranslations = ({ locale, namespace }: { locale: string, namespace: string }): unknown =>
  getRuntime().language.getByNamespace(locale, namespace)

const isLocaleConfig = (input: unknown): input is LocaleConfigInput => Boolean(
  input && _.isPlainObject(input) && _.isString(Reflect.get(input as object, 'locale')) && Reflect.get(input as object, 'locale').length > 0 &&
  _.isBoolean(Reflect.get(input as object, 'autoUpdate')) && _.isBoolean(Reflect.get(input as object, 'namespacing')) &&
  Array.isArray(Reflect.get(input as object, 'namespaces')) &&
  Reflect.get(input as object, 'namespaces').every((namespace: unknown) => _.isString(namespace) && namespace.length > 0)
)

const updateConfig = async (input: unknown): Promise<void> => {
  if (!isLocaleConfig(input)) {
    throw new ApplicationError('Invalid locale config payload', { code: 'INVALID_LOCALE_CONFIGURATION' })
  }
  const { cache, config, configService, language, localesModel } = getRuntime()
  config.lang.code = input.locale
  config.lang.autoUpdate = input.autoUpdate
  config.lang.namespacing = input.namespacing
  config.lang.namespaces = _.union(input.namespaces, [input.locale])
  const locale = await localesModel.query().select('isRTL').where('code', input.locale).first()
  if (!locale) throw new ApplicationError('Locale does not exist', { code: 'LOCALE_NOT_FOUND', status: 404 })
  config.lang.rtl = locale.isRTL
  await configService.saveToDb(['lang'])
  await language.setCurrentLocale(input.locale)
  await language.refreshNamespaces()
  await cache.del('nav:locales')
}

const download = async (code: unknown): Promise<void> => {
  if (!_.isString(code) || code.length < 1) {
    throw new ApplicationError('locale code is required', { code: 'INVALID_LOCALE_CODE' })
  }
  const { scheduler } = getRuntime()
  const job = await scheduler.registerJob({ name: 'fetch-graph-locale', immediate: true }, code)
  await job.finished
}

export default { download, getConfig, getTranslations, listLocales, updateConfig }
