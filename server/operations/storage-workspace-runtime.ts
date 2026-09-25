import type { StorageWorkspace } from '../../shared/storage-workspace.ts'
import type { PagePrincipal } from '../helpers/page-access.ts'
import { storageTargetObservation } from '../repositories/storage-observations.ts'
import type { Knex } from 'knex'
import type Storage from '../models/storage.ts'
import { executingStorageOperations } from '../helpers/storage-active-operations.ts'
import { storageRecord, storageModuleDefinition } from '../repositories/storage-configuration.ts'
import { createStorageConfigurationStore } from './storage-configuration.ts'
import { createStorageActionStore } from './storage-actions.ts'
import { storageTargetPausedOffline } from '../helpers/storage-offline-policy.ts'
interface Runtime {
  models: { knex: Knex; storage: typeof Storage }
  config: { sessionSecret: string; offline?: boolean; allowGitSyncWhileOffline?: boolean }
  data: { storage: unknown[] }
}
let database: Knex | undefined, store: ReturnType<typeof createStorageWorkspaceStore> | undefined
export const createStorageWorkspaceStore = (wiki: Runtime) => {
  const configuration = createStorageConfigurationStore({
    db: wiki.models.knex,
    reviewKey: wiki.config.sessionSecret,
    definitions: () => wiki.data.storage.map(storageModuleDefinition),
    offline: () => wiki.config.offline === true
  })
  const actions = createStorageActionStore({
    db: wiki.models.knex,
    configuration,
    runtime: () => wiki.models.storage.runtimeTargets(),
    offline: key => key !== null && storageTargetPausedOffline(wiki.config, key),
    isExecuting: id => executingStorageOperations.has(id)
  })
  return {
    configuration,
    actions,
    runtime: wiki.models.storage,
    async save(requester: PagePrincipal, input: unknown, apply: boolean) {
      return wiki.models.knex.transaction(async tx => {
        const result = await configuration.save(requester, input, tx)
        if (!apply) return { ...result, operation: null }
        const saved = await configuration.reviewState(tx, requester, true)
        const operation = await actions.enqueue(
          requester,
          { targetKey: null, handler: 'activate', fingerprint: saved.fingerprint, reason: storageRecord(input).reason, confirmation: 'APPLY STORAGE SETTINGS' },
          tx
        )
        return { ...result, operation }
      })
    },
    async inspect(requester: PagePrincipal): Promise<StorageWorkspace> {
      const tx = await wiki.models.knex.transaction({ isolationLevel: 'repeatable read', readOnly: true })
      try {
        const saved = await configuration.reviewState(tx, requester),
          operations = await actions.listInTransaction(tx),
          runtime = wiki.models.storage.runtimeTargets()
        const result = {
          ...configuration.presentState(saved),
          gitSyncAllowedWhileOffline: wiki.config.offline === true && wiki.config.allowGitSyncWhileOffline === true,
          operations,
          runtime: saved.rows.map(row =>
            storageTargetObservation(
              row,
              runtime.find(target => target.key === row.key)
            )
          )
        }
        await tx.commit()
        return result
      } catch (error) {
        await tx.rollback()
        throw error
      }
    }
  }
}
export const getStorageWorkspaceStore = () => {
  const wiki = WIKI as unknown as Runtime
  if (!store || database !== wiki.models.knex) {
    database = wiki.models.knex
    store = createStorageWorkspaceStore(wiki)
  }
  return store
}
