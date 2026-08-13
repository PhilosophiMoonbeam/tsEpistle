import { asRecord, requestGraph } from './_graph.ts'

interface WikiContext {
  config: { graphEndpoint: string, channel: string }
  version: string
  logger: { info(message: string): void, error(message: string): void }
  system: { updates: unknown }
}
const wiki = WIKI as unknown as WikiContext

export default async function syncGraphUpdates (): Promise<void> {
  wiki.logger.info('Fetching latest updates from Graph endpoint...')
  try {
    const response = asRecord(await requestGraph(wiki.config.graphEndpoint, `query ($channel: ReleaseChannel!, $version: String!) {
      releases {
        checkForUpdates(channel: $channel, version: $version) {
          channel version releaseDate minimumVersionRequired minimumNodeRequired
        }
      }
    }`, {
      channel: wiki.config.channel,
      version: wiki.version
    }))
    const info = asRecord(asRecord(response.data).releases).checkForUpdates
    if (info) wiki.system.updates = info
    wiki.logger.info('Fetching latest updates from Graph endpoint: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Fetching latest updates from Graph endpoint: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.message : String(error))
  }
}
