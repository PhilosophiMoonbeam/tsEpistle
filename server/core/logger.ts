import winston from 'winston'

interface WikiContext { config: { logFormat: string; logLevel: string } }
const getWiki = (): WikiContext => WIKI as unknown as WikiContext

const loggerService = {
  loggers: {} as Record<string, unknown>,
  init(uid: string): winston.Logger {
    const wiki = getWiki()
    const loggerFormats: winston.Logform.Format[] = [
      winston.format.label({ label: uid }),
      winston.format.timestamp()
    ]
    if (wiki.config.logFormat === 'json') {
      loggerFormats.push(winston.format.json())
    } else {
      loggerFormats.push(winston.format.colorize())
      loggerFormats.push(winston.format.printf(info => `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`))
    }
    const logger = winston.createLogger({
      level: wiki.config.logLevel,
      format: winston.format.combine(...loggerFormats)
    })
    logger.add(new winston.transports.Console({
      level: wiki.config.logLevel,
      silent: false
    }))
    return logger
  }
}

export default loggerService
