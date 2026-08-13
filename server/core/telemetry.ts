import _ from 'lodash'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import fs from 'fs-extra'

interface Logger {
  info(message: string): void
  warn(message: unknown): void
}

interface WikiContext {
  config: {
    db: { type: string }
    graphEndpoint: string
    offline?: boolean
    telemetry: { clientId: string; isEnabled?: boolean }
  }
  devMode: boolean
  logger: Logger
  models: {
    knex: {
      client: { driver?: { VERSION?: string }; version?: string }
      raw(query: string): Promise<unknown>
    }
  }
  telemetry: TelemetryService
  version: string
}

interface TelemetryResult {
  succeeded: boolean
  message: string
}
const getTelemetryResult = (response: unknown): TelemetryResult => {
  if (typeof response !== 'object' || response === null || !('data' in response)) {
    return { succeeded: false, message: 'Unexpected Error' }
  }
  const data = response.data
  if (typeof data !== 'object' || data === null || !('telemetry' in data)) {
    return { succeeded: false, message: 'Unexpected Error' }
  }
  const telemetryData = data.telemetry
  if (typeof telemetryData !== 'object' || telemetryData === null || !('instance' in telemetryData)) {
    return { succeeded: false, message: 'Unexpected Error' }
  }
  const instance = telemetryData.instance
  if (typeof instance !== 'object' || instance === null || !('responseResult' in instance)) {
    return { succeeded: false, message: 'Unexpected Error' }
  }
  const result = instance.responseResult
  if (typeof result !== 'object' || result === null) {
    return { succeeded: false, message: 'Unexpected Error' }
  }
  return {
    succeeded: 'succeeded' in result && result.succeeded === true,
    message: 'message' in result && typeof result.message === 'string' ? result.message : 'Unexpected Error'
  }
}


interface TelemetryService {
  enabled: boolean
  init(): void
  sendError(error: unknown): void
  sendEvent(eventCategory: unknown, eventAction: unknown, eventLabel: unknown): void
  sendInstanceEvent(eventType: string): Promise<void>
  generateClientId(): string
}

const wiki = WIKI as unknown as WikiContext

const telemetry: TelemetryService = {
  enabled: false,
  init() {
    wiki.telemetry = this

    if (_.get(wiki.config, 'telemetry.isEnabled', false) === true && wiki.config.offline !== true) {
      this.enabled = true
      void this.sendInstanceEvent('STARTUP')
    }
  },
  sendError(error: unknown) {
    // Reserved for a future telemetry error event.
    void error
  },
  sendEvent(eventCategory: unknown, eventAction: unknown, eventLabel: unknown) {
    // Reserved for future telemetry events.
    void eventCategory
    void eventAction
    void eventLabel
  },
  async sendInstanceEvent(eventType: string) {
    if (wiki.devMode || !this.enabled) return

    try {
      const endpoint = wiki.config.graphEndpoint

      let platform = 'LINUX'
      let osname = `${os.type()} ${os.release()}`
      switch (os.platform()) {
        case 'win32':
          platform = 'WINDOWS'
          break
        case 'darwin':
          platform = 'MACOS'
          break
        default:
          platform = 'LINUX'
          if (await fs.pathExists('/.dockerenv')) osname = 'Docker'
          break
      }

      let dbVersion = 'Unknown'
      switch (wiki.config.db.type) {
        case 'mariadb':
        case 'mysql': {
          const result = await wiki.models.knex.raw('SELECT VERSION() as version;')
          dbVersion = _.get(result, '[0][0].version', 'Unknown') as string
          break
        }
        case 'mssql': {
          const result = await wiki.models.knex.raw('SELECT @@VERSION as version;')
          dbVersion = _.get(result, '[0].version', 'Unknown') as string
          break
        }
        case 'postgres':
          dbVersion = wiki.models.knex.client.version ?? 'Unknown'
          break
        case 'sqlite':
          dbVersion = wiki.models.knex.client.driver?.VERSION ?? 'Unknown'
          break
      }

      let arch = os.arch().toUpperCase()
      if (!['ARM', 'ARM64', 'X32', 'X64'].includes(arch)) arch = 'OTHER'

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          query: `mutation (
          $version: String!
          $platform: TelemetryPlatform!
          $os: String!
          $architecture: TelemetryArchitecture!
          $dbType: TelemetryDBType!
          $dbVersion: String!
          $nodeVersion: String!
          $cpuCores: Int!
          $ramMBytes: Int!,
          $clientId: String!,
          $event: TelemetryInstanceEvent!
          ) {
          telemetry {
            instance(
              version: $version
              platform: $platform
              os: $os
              architecture: $architecture
              dbType: $dbType
              dbVersion: $dbVersion
              nodeVersion: $nodeVersion
              cpuCores: $cpuCores
              ramMBytes: $ramMBytes
              clientId: $clientId
              event: $event
            ) {
              responseResult {
                succeeded
                errorCode
                slug
                message
              }
            }
          }
        }`,
          variables: {
            version: wiki.version,
            platform,
            os: osname,
            architecture: arch,
            dbType: wiki.config.db.type.toUpperCase(),
            dbVersion,
            nodeVersion: process.version.substring(1),
            cpuCores: os.cpus().length,
            ramMBytes: Math.round(os.totalmem() / 1024 / 1024),
            clientId: wiki.config.telemetry.clientId,
            event: eventType
          }
        })
      })
      if (!response.ok) {
        throw new Error(`Telemetry request failed with HTTP ${response.status}`)
      }
      const responseBody: unknown = await response.json()
      const result = getTelemetryResult(responseBody)
      if (!result.succeeded) {
        wiki.logger.warn('Failed to send instance telemetry: ' + result.message)
      } else {
        wiki.logger.info('Telemetry is active: [ OK ]')
      }
    } catch (error: unknown) {
      wiki.logger.warn(error instanceof Error ? error.message : String(error))
    }
  },
  generateClientId() {
    _.set(wiki.config, 'telemetry.clientId', randomUUID())
    return wiki.config.telemetry.clientId
  }
}

export default telemetry
