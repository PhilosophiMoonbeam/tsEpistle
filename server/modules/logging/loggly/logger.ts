import winston, { type Logger } from 'winston'
import TransportStream from 'winston-transport'
import 'winston-loggly-bulk'

interface LogglyConfig {
  token: string
  subdomain: string
}

interface LogglyTransportOptions {
  token: string
  subdomain: string
  tags: string[]
  level: string
  json: boolean
}

const createLogglyTransport = (options: LogglyTransportOptions): TransportStream => {
  const Transport: unknown = Reflect.get(winston.transports, 'Loggly')
  if (typeof Transport !== 'function') {
    throw new TypeError('winston-loggly-bulk did not register its Loggly transport')
  }
  const transport: unknown = Reflect.construct(Transport, [options])
  if (!(transport instanceof TransportStream)) {
    throw new TypeError('winston-loggly-bulk registered an invalid Loggly transport')
  }
  return transport
}

// ------------------------------------
// Loggly
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<LogglyConfig>): void {
    logger.add(createLogglyTransport({
      token: conf.token,
      subdomain: conf.subdomain,
      tags: ['wiki-js'],
      level: 'warn',
      json: true
    }))
  }
}

export default plugin
