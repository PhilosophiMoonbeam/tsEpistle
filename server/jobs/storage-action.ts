import type { DurableJobHandler } from '../core/durable-jobs.ts'
import type { StorageOperationResult } from '../../shared/storage-workspace.ts'
import type { StorageRuntimeTarget } from '../operations/storage-actions.ts'
import { getStorageWorkspaceStore } from '../operations/storage-workspace-runtime.ts'
import { executingStorageOperations } from '../helpers/storage-active-operations.ts'
import { storageOperationResult } from '../repositories/storage-operation-result.ts'
interface Dependencies {
  store?(): ReturnType<typeof getStorageWorkspaceStore>
}
export const createStorageActionHandler =
  (deps: Dependencies = {}): DurableJobHandler =>
  async (job, { signal }) => {
    if (job.type !== 'storage-action' || job.version !== 1 || typeof job.payload.operationId !== 'string') throw new Error('Invalid storage operation payload.')
    const store = deps.store?.() ?? getStorageWorkspaceStore(),
      id = job.payload.operationId
    let context: Awaited<ReturnType<typeof store.actions.begin>> | undefined
    let effectCompleted = false,
      recorded = false
    executingStorageOperations.add(id)
    try {
      signal.throwIfAborted()
      await store.runtime.performAdministrativeOperation(
        async () => {
          signal.throwIfAborted()
          context = await store.actions.begin(job)
          signal.throwIfAborted()
          return context
        },
        async value => {
          effectCompleted = true
          signal.throwIfAborted()
          let result: StorageOperationResult
          if (context!.handler === 'activate' && Array.isArray(value)) {
            const targets = value.map((target: StorageRuntimeTarget) => ({ key: target.key, active: target.active, paused: target.paused })),
              failures = targets.filter(target => !target.active && !target.paused).length
            result = {
              outcome: failures === 0 ? 'succeeded' : failures === targets.length ? 'failed' : 'partial',
              message: failures
                ? 'Some targets could not initialize. Review their configuration before applying again.'
                : targets.some(target => target.paused)
                  ? 'Saved settings applied. Remote targets without an offline exception remain paused.'
                  : 'Saved settings applied. Enabled targets are available.',
              counts: null,
              items: [],
              targets
            }
          } else result = storageOperationResult(context!.handler, value, context!.credentials)
          await store.actions.finish(job, result)
          recorded = true
          if (result.outcome === 'failed') throw new Error('The storage action reported failure.')
        }
      )
    } catch (_error) {
      if (!signal.aborted && !recorded && !effectCompleted) {
        try {
          if (context)
            await store.actions.finish(job, {
              outcome: 'failed',
              message: 'Storage execution could not complete. Review target configuration and application logs before repeating it.',
              counts: null,
              items: [],
              targets: []
            })
          else await store.actions.rejectBeforeStart(job)
        } catch (_recordError) {
          /* A lost lease must leave the operation unresolved; never overwrite a later receipt. */
        }
      }
      // Job failures are persisted. Provider and database details must never enter this receipt.
      throw new Error('Storage operation did not complete. Inspect its operation record before taking further action.')
    } finally {
      executingStorageOperations.delete(id)
    }
  }
