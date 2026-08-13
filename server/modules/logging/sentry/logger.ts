import { captureMessage, init, type SeverityLevel } from '@sentry/node'
import type { TransformableInfo } from 'logform'
import type { Logger } from 'winston'
import TransportStream from 'winston-transport'

interface SentryConfig {
  key: string
}

interface SentryTransportOptions extends TransportStream.TransportStreamOptions {
  key: string
}

class SentryLogger extends TransportStream {
  constructor (options: SentryTransportOptions) {
    super(options)
    this.level = options.level || 'warn'
    init({ dsn: options.key })
  }

  override log (info: TransformableInfo, callback: () => void): void {
    const { level, message, ...metadata } = info
    captureMessage(
      typeof message === 'string' ? message : String(message),
      {
        level: (level === 'warn' ? 'warning' : level) as SeverityLevel,
        extra: metadata
      }
    )
    setImmediate(() => this.emit('logged', info))
    callback()
  }
}

// ------------------------------------
// Sentry
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<SentryConfig>): void {
    logger.add(new SentryLogger({
      level: 'warn',
      key: conf.key
    }))
  }
}

export default plugin
