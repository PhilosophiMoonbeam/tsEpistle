// ===========================================
// tsEpistle
// Licensed under AGPLv3
// ===========================================

import path from 'node:path'
import { nanoid } from 'nanoid'
import { DateTime } from 'luxon'

interface BootstrapKernel {
  init(): Promise<void>
  shutdown(): Promise<void>
}

interface BootstrapConfigService {
  init(): void
}

interface BootstrapLogger {
  error(message: unknown): void
}

interface WikiBootstrap extends Record<string, unknown> {
  IS_DEBUG: boolean
  IS_MASTER: boolean
  ROOTPATH: string
  INSTANCE_ID: string
  SERVERPATH: string
  Error?: unknown
  configSvc?: BootstrapConfigService
  kernel?: BootstrapKernel
  logger?: BootstrapLogger
  telemetry?: { sendError(error: unknown): void }
  shutdownSignal: AbortSignal
  startedAt: DateTime
}

async function run(): Promise<void> {
  const configuredInstanceId = process.env.INSTANCE_ID?.trim()
  const shutdownController = new AbortController()

  const wiki: WikiBootstrap = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    IS_MASTER: true,
    ROOTPATH: process.cwd(),
    INSTANCE_ID: configuredInstanceId || nanoid(10),
    SERVERPATH: path.join(process.cwd(), 'server'),
    shutdownSignal: shutdownController.signal,
    startedAt: DateTime.utc()
  }

  globalThis.WIKI = wiki

  let bootstrapPromise: Promise<void>
  let shutdownPromise: Promise<void> | undefined
  let shutdownComplete = false
  let requestedExitCode = 0

  const logError = (error: unknown): void => {
    if (wiki.logger) wiki.logger.error(error)
    else console.error(error)
  }

  const removeLifecycleListeners = (): void => {
    process.off('SIGTERM', handleSignal)
    process.off('SIGINT', handleSignal)
    process.off('message', handleMessage)
    process.off('unhandledRejection', handleFatal)
    process.off('uncaughtException', handleFatal)
  }

  const shutdown = (exitCode = 0): Promise<void> => {
    if (exitCode !== 0) requestedExitCode = exitCode
    if (!shutdownPromise) {
      shutdownController.abort(new DOMException('Shutdown requested', 'AbortError'))
      shutdownPromise = (async () => {
        try {
          await bootstrapPromise.catch(() => undefined)
          if (wiki.kernel) await wiki.kernel.shutdown()
        } catch (error) {
          requestedExitCode = 1
          throw error
        } finally {
          shutdownComplete = true
          removeLifecycleListeners()
          process.exitCode = requestedExitCode
        }
      })()
    } else if (shutdownComplete) {
      process.exitCode = requestedExitCode
    }
    return shutdownPromise
  }

  function handleSignal(): void {
    void shutdown().catch(logError)
  }

  function handleMessage(message: unknown): void {
    if (message === 'shutdown') handleSignal()
  }

  function handleFatal(error: unknown): void {
    logError(error)
    try {
      wiki.telemetry?.sendError(error)
    } catch (telemetryError) {
      logError(telemetryError)
    }
    void shutdown(1).catch(logError)
  }
  process.on('SIGTERM', handleSignal)
  process.on('SIGINT', handleSignal)
  process.on('message', handleMessage)
  process.on('unhandledRejection', handleFatal)
  process.on('uncaughtException', handleFatal)

  bootstrapPromise = (async () => {
    if (configuredInstanceId && configuredInstanceId.length > 128) {
      throw new RangeError('INSTANCE_ID must contain at most 128 characters')
    }

    // Deferred because legacy core modules read the global wiki context during module evaluation.
    const [{ default: wikiErrors }, { default: configService }] = await Promise.all([import('./helpers/error.ts'), import('./core/config.ts')])

    wiki.Error = wikiErrors
    wiki.configSvc = configService
    configService.init()
    // Deferred in dependency order because core modules read configuration and the logger during evaluation.
    const { default: logger } = await import('./core/logger.ts')
    wiki.logger = logger.init('MASTER')

    const { default: kernel } = await import('./core/kernel.ts')
    wiki.kernel = kernel
    await kernel.init()
  })()

  try {
    await bootstrapPromise
  } catch (error) {
    if (!shutdownController.signal.aborted) {
      logError(error)
      try {
        await shutdown(1)
      } catch (shutdownError) {
        logError(shutdownError)
      }
    } else {
      try {
        await shutdown()
      } catch (shutdownError) {
        logError(shutdownError)
      }
    }
  }
}

let startupPromise: Promise<void> | undefined
export function main(): Promise<void> {
  startupPromise ??= run()
  return startupPromise
}

if (import.meta.main) await main()
