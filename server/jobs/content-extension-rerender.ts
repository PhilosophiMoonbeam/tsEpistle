import { BUILTIN_CONTENT_EXTENSIONS, type ContentExtensionKey } from '../../shared/content-extensions.ts'
import { rerenderPagesForContentExtension, type ContentExtensionRerenderContext } from '../content-extensions/rerender.ts'
import type { DurableJobHandler } from '../core/durable-jobs.ts'

const parseContentExtensionKey = (payload: Record<string, unknown>): ContentExtensionKey => {
  const key = payload.key
  if (typeof key !== 'string') throw new TypeError('Content extension rerender job key is invalid')
  const definition = BUILTIN_CONTENT_EXTENSIONS.find(extension => extension.key === key)
  if (!definition) throw new TypeError('Content extension rerender job key is invalid')
  return definition.key
}

export const createContentExtensionRerenderHandler = (
  wiki: ContentExtensionRerenderContext
): DurableJobHandler => async (job, context) => {
  context.signal.throwIfAborted()
  const key = parseContentExtensionKey(job.payload)
  await rerenderPagesForContentExtension(context.knex, wiki, key, context.signal)
  context.signal.throwIfAborted()
}
