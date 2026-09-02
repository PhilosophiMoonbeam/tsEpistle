import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'

const { parseConfig, preserveSensitiveConfig, serializeConfig } = configuration

interface ConfigEntry {
  key: string
  value: string
}
interface DefinitionProperty {
  sensitive?: boolean
  [key: string]: unknown
}

interface LoggerDefinition extends Record<string, unknown> {
  key: string
  props?: Record<string, DefinitionProperty>
}

interface LoggerRow {
  key: string
  isEnabled: boolean
  level: string
  config: ConfigEntry[] | Record<string, unknown>
  [key: string]: unknown
}

interface LoggerQuery {
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}

interface LoggerModel {
  getLoggers(): Promise<LoggerRow[]>
  query(): LoggerQuery
}

const wikiModels = WIKI.models as { loggers: LoggerModel }
const loggerModel = wikiModels.loggers
const MASK_SENTINEL = '********'

const getLoggerDefinitions = (): LoggerDefinition[] => {
  const wikiData = WIKI.data as { loggers: LoggerDefinition[] }
  return wikiData.loggers
}

const normalizeSensitiveMaskSentinels = (config: Record<string, unknown>, definition: LoggerDefinition): void => {
  for (const [key, property] of Object.entries(definition.props ?? {})) {
    const encodedValue = config[key]
    if (property.sensitive && typeof encodedValue === 'string' && _.get(JSON.parse(encodedValue) as unknown, 'v') === MASK_SENTINEL) {
      config[key] = MASK_SENTINEL
    }
  }
}

const validLogger = (logger: unknown): logger is LoggerRow =>
  Boolean(
    logger &&
      typeof logger === 'object' &&
      !Array.isArray(logger) &&
      typeof Reflect.get(logger, 'key') === 'string' &&
      typeof Reflect.get(logger, 'isEnabled') === 'boolean' &&
      typeof Reflect.get(logger, 'level') === 'string' &&
      Array.isArray(Reflect.get(logger, 'config'))
  )

const listLoggers = async (orderBy?: string): Promise<Array<Record<string, unknown>>> => {
  const loggerDefinitions = getLoggerDefinitions()
  const loggers = await loggerModel.getLoggers()
  const result = loggers.map(logger => {
    const definition = _.find(loggerDefinitions, ['key', logger.key]) ?? {}
    return {
      ...definition,
      ...logger,
      isEnabled: Boolean(logger.isEnabled),
      config: serializeConfig({
        config: logger.config as Record<string, unknown>,
        definition,
        maskSensitive: true
      })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateLoggers = async (loggers: unknown): Promise<void> => {
  validateRows(loggers, validLogger, 'Invalid loggers payload')
  const loggerDefinitions = getLoggerDefinitions()
  const previousLoggers = await loggerModel.getLoggers()
  const updates = loggers.map(logger => {
    const definition = _.find(loggerDefinitions, ['key', logger.key]) ?? { key: logger.key }
    const previous = _.find(previousLoggers, ['key', logger.key])
    const current = previous && _.isPlainObject(previous.config) ? (previous.config as Record<string, unknown>) : {}
    const config = parseConfig(logger.config, { errorMessage: 'Invalid loggers payload', unwrap: false })
    normalizeSensitiveMaskSentinels(config, definition)
    return {
      key: logger.key,
      isEnabled: logger.isEnabled,
      level: logger.level,
      config: preserveSensitiveConfig({
        config,
        current,
        definition
      })
    }
  })
  for (const logger of updates) {
    await loggerModel
      .query()
      .patch({
        isEnabled: logger.isEnabled,
        level: logger.level,
        config: logger.config
      })
      .where('key', logger.key)
  }
}

export default { listLoggers, updateLoggers }
