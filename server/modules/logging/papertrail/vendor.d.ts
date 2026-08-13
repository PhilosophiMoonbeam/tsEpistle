declare module 'winston-papertrail' {
  import type TransportStream from 'winston-transport'

  interface PapertrailOptions extends TransportStream.TransportStreamOptions {
    host: string
    port: number
    program?: string
  }

  class Papertrail extends TransportStream {
    constructor(options: PapertrailOptions)
  }
}
