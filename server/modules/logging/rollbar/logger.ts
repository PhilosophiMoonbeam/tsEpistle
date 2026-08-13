import { createRequire } from 'node:module'
import type { TransformableInfo } from 'logform'
import type { Logger } from 'winston'
import TransportStream from 'winston-transport'

const require = createRequire(import.meta.url)

interface RollbarClient {
  init(key: string): void
  handleErrorWithPayloadData(error: Error, payload: Record<string, unknown>): void
}

interface RollbarConfig {
  key: string
}

interface RollbarTransportOptions extends TransportStream.TransportStreamOptions {
  key: string
}

const isRollbarClient = (value: unknown): value is RollbarClient => typeof value === 'object' &&
  value !== null &&
  'init' in value &&
  typeof value.init === 'function' &&
  'handleErrorWithPayloadData' in value &&
  typeof value.handleErrorWithPayloadData === 'function'

const loadRollbar = (): RollbarClient => {
  const client: unknown = require('rollbar')
  if (!isRollbarClient(client)) {
    throw new TypeError('The rollbar package does not expose the expected client API')
  }
  return client
}

class RollbarLogger extends TransportStream {
  readonly name = 'rollbarLogger'
  private readonly rollbar: RollbarClient

  constructor (options: RollbarTransportOptions) {
    super(options)
    this.level = options.level || 'warn'
    this.rollbar = loadRollbar()
    this.rollbar.init(options.key)
  }

  override log (info: TransformableInfo, callback: () => void): void {
    const { level, message, ...metadata } = info
    this.rollbar.handleErrorWithPayloadData(
      new Error(typeof message === 'string' ? message : String(message)),
      { ...metadata, level }
    )
    callback()
  }
}

// ------------------------------------
// Rollbar
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<RollbarConfig>): void {
    logger.add(new RollbarLogger({
      level: 'warn',
      key: conf.key
    }))
  }
}

export default plugin
