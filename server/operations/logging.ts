import _ from 'lodash'

import configuration, { validateRows } from './configuration.ts'

const { parseConfig, serializeConfig } = configuration

interface ConfigEntry {
  key: string
  value: string
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

const loggerModel = (WIKI.models as { loggers: LoggerModel }).loggers
const loggerDefinitions = (WIKI.data as { loggers: Array<Record<string, unknown> & { key: string }> }).loggers

const validLogger = (logger: unknown): logger is LoggerRow => Boolean(
  logger &&
  typeof logger === 'object' &&
  !Array.isArray(logger) &&
  typeof Reflect.get(logger, 'key') === 'string' &&
  typeof Reflect.get(logger, 'isEnabled') === 'boolean' &&
  typeof Reflect.get(logger, 'level') === 'string' &&
  Array.isArray(Reflect.get(logger, 'config'))
)

const listLoggers = async (orderBy?: string): Promise<Array<Record<string, unknown>>> => {
  const loggers = await loggerModel.getLoggers()
  const result = loggers.map(logger => {
    const definition = _.find(loggerDefinitions, ['key', logger.key]) ?? {}
    return {
      ...definition,
      ...logger,
      config: serializeConfig({ config: logger.config as Record<string, unknown>, definition })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateLoggers = async (loggers: unknown): Promise<void> => {
  validateRows(loggers, validLogger, 'Invalid loggers payload')
  const updates = loggers.map(logger => ({
    key: logger.key,
    isEnabled: logger.isEnabled,
    level: logger.level,
    config: parseConfig(logger.config, { errorMessage: 'Invalid loggers payload', unwrap: false })
  }))
  for (const logger of updates) {
    await loggerModel.query().patch({
      isEnabled: logger.isEnabled,
      level: logger.level,
      config: logger.config
    }).where('key', logger.key)
  }
}

export default { listLoggers, updateLoggers }
