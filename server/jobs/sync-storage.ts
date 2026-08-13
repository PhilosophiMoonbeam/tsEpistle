interface StorageTarget { key: string, fn: { sync(): Promise<void> } }
interface StorageQuery extends PromiseLike<unknown> {
  patch(data: Record<string, unknown>): StorageQuery
  where(column: string, value: unknown): StorageQuery
}
interface WikiContext {
  logger: { info(message: string): void, error(message: string): void }
  models: { storage: { targets: StorageTarget[], query(): StorageQuery } }
}
const wiki = WIKI as unknown as WikiContext

export default async function syncStorage (targetKey: string): Promise<void> {
  wiki.logger.info(`Syncing with storage target ${targetKey}...`)
  try {
    const target = wiki.models.storage.targets.find(candidate => candidate.key === targetKey)
    if (!target) throw new Error('Invalid storage target. Unable to perform sync.')
    await target.fn.sync()
    wiki.logger.info(`Syncing with storage target ${targetKey}: [ COMPLETED ]`)
    await wiki.models.storage.query().patch({
      state: { status: 'operational', message: '', lastAttempt: new Date().toISOString() }
    }).where('key', targetKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    wiki.logger.error(`Syncing with storage target ${targetKey}: [ FAILED ]`)
    wiki.logger.error(message)
    await wiki.models.storage.query().patch({
      state: { status: 'error', message, lastAttempt: new Date().toISOString() }
    }).where('key', targetKey)
  }
}
