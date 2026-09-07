import { Scope, type SeverityLevel } from '@sentry/core'
import { defaultStackParser, makeNodeTransport, NodeClient } from '@sentry/node-core'
import type { TransformableInfo } from 'logform'
import { LEVEL } from 'triple-beam'
import type { Logger } from 'winston'
import TransportStream from 'winston-transport'

interface SentryConfig {
  key: string
  level?: string
}

interface SentryTransportOptions extends TransportStream.TransportStreamOptions {
  key: string
}

const CLOSE_TIMEOUT_MILLISECONDS = 2_000

const severity = (level: unknown): SeverityLevel => {
  switch (level) {
    case 'error':
      return 'error'
    case 'warn':
      return 'warning'
    case 'info':
      return 'info'
    case 'verbose':
      return 'log'
    default:
      return 'debug'
  }
}

export class SentryLogger extends TransportStream {
  readonly #client: NodeClient
  #closing: Promise<void> | null = null

  constructor(options: SentryTransportOptions) {
    super(options)
    this.level = options.level || 'warn'
    this.#client = new NodeClient({
      dsn: options.key,
      integrations: [],
      transport: makeNodeTransport,
      stackParser: defaultStackParser,
      enableLogs: false,
      enableMetrics: false,
      sendClientReports: false
    })
    this.#client.init()
  }

  override log(info: TransformableInfo, callback: () => void): void {
    const message = typeof info.message === 'string' ? info.message : String(info.message)
    const scope = new Scope()
    scope.setExtras(Object.fromEntries(Object.entries(info).filter(([key]) => key !== 'level' && key !== 'message')))
    this.#client.captureMessage(message, severity(info[LEVEL]), undefined, scope)
    setImmediate(() => this.emit('logged', info))
    callback()
  }

  dispose(): Promise<void> {
    if (!this.#closing) {
      this.#closing = Promise.resolve(this.#client.close(CLOSE_TIMEOUT_MILLISECONDS)).then(() => undefined)
    }
    return this.#closing
  }

  override close(): void {
    void this.dispose()
  }
}

const plugin = {
  init(logger: Logger, conf: Readonly<SentryConfig>): SentryLogger {
    const transport = new SentryLogger({
      level: conf.level ?? 'warn',
      key: conf.key
    })
    logger.add(transport)
    return transport
  }
}

export default plugin
