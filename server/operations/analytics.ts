import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'

const { parseConfig, serializeConfig } = configuration

interface ConfigEntry {
  key: string
  value: string
}

interface AnalyticsProvider {
  key: string
  isEnabled: boolean
  config: ConfigEntry[] | Record<string, unknown>
  [key: string]: unknown
}

interface AnalyticsQuery {
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}

interface AnalyticsModel {
  getProviders(isEnabled: boolean | undefined): Promise<AnalyticsProvider[]>
  query(): AnalyticsQuery
}

const analyticsModel = (WIKI.models as { analytics: AnalyticsModel }).analytics
const cache = WIKI.cache as { del(key: string): Promise<unknown> }

const validProvider = (provider: unknown): provider is AnalyticsProvider => Boolean(
  provider &&
  typeof provider === 'object' &&
  !Array.isArray(provider) &&
  typeof Reflect.get(provider, 'key') === 'string' &&
  typeof Reflect.get(provider, 'isEnabled') === 'boolean' &&
  Array.isArray(Reflect.get(provider, 'config'))
)

const listProviders = async (isEnabled?: boolean): Promise<Array<Record<string, unknown>>> => {
  const analyticsDefinitions = (WIKI.data as { analytics: Array<Record<string, unknown> & { key: string }> }).analytics
  const providers = await analyticsModel.getProviders(isEnabled)
  return providers.map(provider => {
    const definition = _.find(analyticsDefinitions, ['key', provider.key]) ?? {}
    return {
      ...definition,
      ...provider,
      isEnabled: Boolean(provider.isEnabled),
      config: serializeConfig({ config: provider.config as Record<string, unknown>, definition })
    }
  })
}

const updateProviders = async (providers: unknown): Promise<void> => {
  validateRows(providers, validProvider, 'Invalid analytics providers payload')
  const updates = providers.map(provider => ({
    key: provider.key,
    isEnabled: provider.isEnabled,
    config: parseConfig(provider.config, { errorMessage: 'Invalid analytics providers payload' })
  }))
  for (const provider of updates) {
    await analyticsModel.query().patch({
      isEnabled: provider.isEnabled,
      config: provider.config
    }).where('key', provider.key)
    await cache.del('analytics')
  }
}

export default { listProviders, updateProviders }
