import type { DurableJobHandler } from '../core/durable-jobs.ts'
import { getLocaleAdministrationStore, type LocalePackageStore } from '../operations/locale-administration.ts'
import { fetchLocaleCatalog, fetchLocaleStrings } from '../repositories/locale-packages.ts'
interface Dependencies {
  store?(): LocalePackageStore
  fetch?: typeof fetch
}
export const createLocalePackageHandler =
  (dependencies: Dependencies = {}): DurableJobHandler =>
  async (job, { signal }) => {
    if (
      job.version !== 1 ||
      !['install', 'catalog', 'local'].includes(String(job.payload.kind)) ||
      typeof job.payload.eventId !== 'string' ||
      (job.payload.kind === 'local' && typeof job.payload.reviewId !== 'string')
    )
      throw new Error('The language operation payload is invalid.')
    const store = dependencies.store?.() ?? getLocaleAdministrationStore()
    try {
      signal.throwIfAborted()
      const context = await store.jobContext(job)
      if (context.alreadyApplied) return
      if (context.kind === 'local') {
        signal.throwIfAborted()
        await store.publishJob(job, [])
        return
      }
      const catalog = await fetchLocaleCatalog(context.endpoint, signal, dependencies.fetch)
      const code = job.payload.code
      if (job.payload.kind === 'install' && (typeof code !== 'string' || !catalog.some(row => row.code === code)))
        throw new Error('The language is absent from the source catalog.')
      const strings = job.payload.kind === 'install' ? await fetchLocaleStrings(context.endpoint, String(code), signal, dependencies.fetch) : undefined
      signal.throwIfAborted()
      await store.publishJob(job, catalog, strings)
    } catch (error) {
      signal.throwIfAborted()
      // Durable job errors are persisted; never retain remote response bodies or database details.
      const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined
      throw new Error(
        status === 403
          ? 'Administrative authority changed. Start a new language operation after signing in again.'
          : job.payload.kind === 'local'
            ? 'The reviewed language file could not be published. Verify the review, current package and permissions before retrying.'
            : 'Language operation could not complete. Verify the source, current permissions and offline policy, then retry.'
      )
    }
  }
