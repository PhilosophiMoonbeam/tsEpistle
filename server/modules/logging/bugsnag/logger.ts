import { createRequire } from 'node:module'
import type { TransformableInfo } from 'logform'
import type { Logger } from 'winston'
import TransportStream from 'winston-transport'

const require = createRequire(import.meta.url)

interface BugsnagClient {
  register(key: string): void
  notify(error: Error, metadata: Record<string, unknown>): void
}

interface BugsnagConfig {
  key: string
}

interface BugsnagTransportOptions extends TransportStream.TransportStreamOptions {
  key: string
}

const isBugsnagClient = (value: unknown): value is BugsnagClient => typeof value === 'object' &&
  value !== null &&
  'register' in value &&
  typeof value.register === 'function' &&
  'notify' in value &&
  typeof value.notify === 'function'

const loadBugsnag = (): BugsnagClient => {
  const client: unknown = require('bugsnag')
  if (!isBugsnagClient(client)) {
    throw new TypeError('The bugsnag package does not expose the expected client API')
  }
  return client
}

class BugsnagLogger extends TransportStream {
  readonly name = 'bugsnagLogger'
  private readonly bugsnag: BugsnagClient

  constructor (options: BugsnagTransportOptions) {
    super(options)
    this.level = options.level || 'warn'
    this.bugsnag = loadBugsnag()
    this.bugsnag.register(options.key)
  }

  override log (info: TransformableInfo, callback: () => void): void {
    const { level, message, ...metadata } = info
    this.bugsnag.notify(new Error(typeof message === 'string' ? message : String(message)), {
      ...metadata,
      severity: level
    })
    callback()
  }
}

// ------------------------------------
// Bugsnag
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<BugsnagConfig>): void {
    logger.add(new BugsnagLogger({
      level: 'warn',
      key: conf.key
    }))
  }
}

export default plugin
