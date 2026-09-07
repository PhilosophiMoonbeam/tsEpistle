import { createHmac } from 'node:crypto'
import sentryLogger from '../modules/logging/sentry/logger.ts'
import winston from 'winston'
import type Transport from 'winston-transport'
import { isValidSentryDsn } from '../../shared/logging-workspace.ts'
export const LOGGING_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'] as const
export const LOGGING_FORMATS = ['default', 'json'] as const
export type LoggingLevel = (typeof LOGGING_LEVELS)[number]
export type LoggingFormat = (typeof LOGGING_FORMATS)[number]

export interface LoggingDestinationRuntimeConfiguration {
  key: string
  isEnabled: boolean
  level: LoggingLevel
  config: Record<string, unknown>
}

export interface LoggingRuntimeConfiguration {
  console: { level: LoggingLevel; format: LoggingFormat }
  destinations: LoggingDestinationRuntimeConfiguration[]
}

export interface LoggingDestinationRuntimeObservation {
  state: 'active' | 'inactive' | 'unavailable' | 'failed'
  message: string | null
}

export interface LoggingRuntimeObservation {
  configurationKey: string | null
  state: 'ready' | 'partially-applied' | 'unapplied'
  observedAt: string | null
  console: { level: LoggingLevel | null; format: LoggingFormat | null }
  destinations: Record<string, LoggingDestinationRuntimeObservation>
  message: string | null
}

export interface ManagedLogger extends winston.Logger {
  reconcile(configuration: LoggingRuntimeConfiguration, configurationKey: string): Promise<LoggingRuntimeObservation>
  reconcileSaved(): Promise<LoggingRuntimeObservation>
  loggingRuntime(): LoggingRuntimeObservation
}

interface LoggerRow {
  key: string
  isEnabled: boolean
  level: string
  config: unknown
}

interface WikiContext {
  config: { logFormat: string; logLevel: string; sessionSecret: string }
  data?: { loggers?: Array<{ key: string }> }
  models?: { loggers: { getLoggers(): Promise<LoggerRow[]> } }
}

const getWiki = (): WikiContext => (globalThis as typeof globalThis & { WIKI: unknown }).WIKI as unknown as WikiContext
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const configuredLevel = (value: unknown): LoggingLevel =>
  typeof value === 'string' && (LOGGING_LEVELS as readonly string[]).includes(value) ? (value as LoggingLevel) : 'warn'
const configuredFormat = (value: unknown): LoggingFormat => (value === 'json' ? 'json' : 'default')
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  )
const unwrapStoredValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    return record(parsed).v ?? value
  } catch {
    return value
  }
}

export const loggingRuntimeKey = (reviewKey: string, configuration: LoggingRuntimeConfiguration): string =>
  createHmac('sha256', reviewKey).update(stable(configuration)).digest('hex')

const loggerFormat = (uid: string, format: LoggingFormat): winston.Logform.Format => {
  const base = [winston.format.label({ label: uid }), winston.format.timestamp()]
  if (format === 'json') return winston.format.combine(...base, winston.format.json())
  return winston.format.combine(
    ...base,
    winston.format.colorize(),
    winston.format.printf(info => `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`)
  )
}

const initialRuntime = (): LoggingRuntimeObservation => ({
  configurationKey: null,
  state: 'unapplied',
  observedAt: null,
  console: { level: null, format: null },
  destinations: {},
  message: 'Saved logging settings have not been reconciled in this process.'
})

const cloneRuntime = (runtime: LoggingRuntimeObservation): LoggingRuntimeObservation => ({
  ...runtime,
  console: { ...runtime.console },
  destinations: Object.fromEntries(Object.entries(runtime.destinations).map(([key, value]) => [key, { ...value }]))
})

const isSentryConfiguration = (
  configuration: LoggingDestinationRuntimeConfiguration
): configuration is LoggingDestinationRuntimeConfiguration & { config: { key: string } } =>
  configuration.key === 'sentry' && typeof configuration.config.key === 'string' && configuration.config.key.trim().length > 0

interface ManagedDestination {
  transport: Transport
  dispose(): Promise<void>
}

const loggerService = {
  loggers: {} as Record<string, unknown>,
  init(uid: string): ManagedLogger {
    const wiki = getWiki()
    const initialConsole = {
      level: configuredLevel(wiki.config.logLevel),
      format: configuredFormat(wiki.config.logFormat)
    }
    const logger = winston.createLogger({
      level: initialConsole.level,
      format: loggerFormat(uid, initialConsole.format)
    }) as ManagedLogger
    const consoleTransport = new winston.transports.Console({ level: initialConsole.level, silent: false })
    logger.add(consoleTransport)

    let runtime = initialRuntime()
    let managedTransports: ManagedDestination[] = []
    let mutation = Promise.resolve<LoggingRuntimeObservation>(runtime)

    const reconcile = async (configuration: LoggingRuntimeConfiguration, configurationKey: string): Promise<LoggingRuntimeObservation> => {
      const retiredTransports = managedTransports
      managedTransports = []
      for (const managed of retiredTransports) logger.remove(managed.transport)
      const releases = await Promise.allSettled(retiredTransports.map(managed => managed.dispose()))
      if (releases.some(result => result.status === 'rejected')) {
        throw new Error('A logging destination could not be shut down cleanly.')
      }
      logger.level = configuration.console.level
      logger.format = loggerFormat(uid, configuration.console.format)
      consoleTransport.level = configuration.console.level

      const destinations: Record<string, LoggingDestinationRuntimeObservation> = {}
      let failed = false
      for (const destination of configuration.destinations) {
        if (!destination.isEnabled) {
          destinations[destination.key] = { state: 'inactive', message: null }
          continue
        }
        if (!isSentryConfiguration(destination)) {
          destinations[destination.key] = {
            state: destination.key === 'sentry' ? 'failed' : 'unavailable',
            message:
              destination.key === 'sentry'
                ? 'A Sentry DSN is required before this destination can be initialized.'
                : 'This release does not include an active transport for this legacy destination.'
          }
          failed = true
          continue
        }
        if (destination.key === 'sentry' && !isValidSentryDsn(destination.config.key)) {
          destinations[destination.key] = {
            state: 'failed',
            message: 'The configured Sentry DSN is invalid.'
          }
          failed = true
          continue
        }

        try {
          const transport = sentryLogger.init(logger, { key: destination.config.key, level: destination.level })
          managedTransports.push({ transport, dispose: () => transport.dispose() })
          destinations[destination.key] = { state: 'active', message: null }
        } catch {
          destinations[destination.key] = {
            state: 'failed',
            message: 'The Sentry destination could not be initialized. Inspect server logs before trying again.'
          }
          failed = true
        }
      }
      runtime = {
        configurationKey: failed ? null : configurationKey,
        state: failed ? 'partially-applied' : 'ready',
        observedAt: new Date().toISOString(),
        console: { ...configuration.console },
        destinations,
        message: failed ? 'One or more saved logging destinations could not be applied in this process.' : null
      }
      return cloneRuntime(runtime)
    }

    logger.reconcile = (configuration, configurationKey) => {
      mutation = mutation.catch(() => initialRuntime()).then(() => reconcile(configuration, configurationKey))
      return mutation
    }
    logger.loggingRuntime = () => cloneRuntime(runtime)
    logger.reconcileSaved = async () => {
      const saved = (await wiki.models?.loggers.getLoggers()) ?? []
      const known = new Set(wiki.data?.loggers?.map(definition => definition.key) ?? [])
      const configured = known.size > 0 ? saved.filter(row => known.has(row.key)) : saved
      const configuration: LoggingRuntimeConfiguration = {
        console: {
          level: configuredLevel(wiki.config.logLevel),
          format: configuredFormat(wiki.config.logFormat)
        },
        destinations: configured.map(row => ({
          key: row.key,
          isEnabled: row.isEnabled === true,
          level: configuredLevel(row.level),
          config: Object.fromEntries(Object.entries(record(row.config)).map(([key, value]) => [key, unwrapStoredValue(value)]))
        }))
      }
      return logger.reconcile(configuration, loggingRuntimeKey(wiki.config.sessionSecret, configuration))
    }
    return logger
  }
}

export default loggerService
