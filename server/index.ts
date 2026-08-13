// ===========================================
// Wiki.js
// Licensed under AGPLv3
// ===========================================

import path from 'node:path'
import { nanoid } from 'nanoid'
import { DateTime } from 'luxon'


interface BootstrapKernel {
  init(): void
  shutdown(): void
}

interface BootstrapConfigService {
  init(): void
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
  logger?: unknown
  startedAt: DateTime
}

const wiki: WikiBootstrap = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  IS_MASTER: true,
  ROOTPATH: process.cwd(),
  INSTANCE_ID: nanoid(10),
  SERVERPATH: path.join(process.cwd(), 'server'),
  startedAt: DateTime.utc()
}

globalThis.WIKI = wiki
// Deferred because legacy core modules read the global wiki context during module evaluation.

const [
  { default: wikiErrors },
  { default: configService }
] = await Promise.all([
  import('./helpers/error.ts'),
  import('./core/config.ts')
])

wiki.Error = wikiErrors
wiki.configSvc = configService
configService.init()
// Deferred in dependency order because core modules read configuration and the logger during evaluation.
const { default: logger } = await import('./core/logger.ts')
wiki.logger = logger.init('MASTER')

const { default: kernel } = await import('./core/kernel.ts')
wiki.kernel = kernel
kernel.init()

const shutdown = (): void => {
  kernel.shutdown()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('message', (message: unknown) => {
  if (message === 'shutdown') {
    shutdown()
  }
})
