declare module 'winston-loggly-bulk' {
  import type TransportStream from 'winston-transport'

  interface LogglyOptions extends TransportStream.TransportStreamOptions {
    token: string
    subdomain: string
    tags?: string[]
    json?: boolean
  }

  class Loggly extends TransportStream {
    constructor(options: LogglyOptions)
  }
}
