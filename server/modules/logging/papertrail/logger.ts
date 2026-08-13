import winston, { type Logger } from 'winston'
import TransportStream from 'winston-transport'
import 'winston-papertrail'

interface PapertrailConfig {
  host: string
  port: number
}

interface PapertrailTransportOptions {
  host: string
  port: number
  level: string
  program: string
}

const createPapertrailTransport = (options: PapertrailTransportOptions): TransportStream => {
  const Transport: unknown = Reflect.get(winston.transports, 'Papertrail')
  if (typeof Transport !== 'function') {
    throw new TypeError('winston-papertrail did not register its Papertrail transport')
  }
  const transport: unknown = Reflect.construct(Transport, [options])
  if (!(transport instanceof TransportStream)) {
    throw new TypeError('winston-papertrail registered an invalid Papertrail transport')
  }
  return transport
}

// ------------------------------------
// Papertrail
// ------------------------------------

const plugin = {
  init (logger: Logger, conf: Readonly<PapertrailConfig>): void {
    logger.add(createPapertrailTransport({
      host: conf.host,
      port: conf.port,
      level: 'warn',
      program: 'wiki.js'
    }))
  }
}

export default plugin
