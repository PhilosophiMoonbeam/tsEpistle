import _ from 'lodash'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { PageProjectionPayloadSchema } from '../core/page-mutation-outbox.ts'
import type { PageRenderPublicationFence } from '../core/page-mutation-outbox.ts'
import { lockSearchIndex, lockSearchPage } from '../helpers/search-contract.ts'
import database from '../core/db.ts'
import { buildTocFromHtml } from './render-page-toc.ts'

interface PageRecord {
  id: number
  sourceRevision: string | number
  render: string
  localeCode: string
  path: string
  visibility: 'public' | 'private'
  ownerId: number | null
  renderedSourceRevision: string | number | null
  content: string
  contentType: string
  [key: string]: unknown
}
interface PipelineCore {
  key: string
  config: unknown
  children: unknown
}
interface Models {
  renderers: { fetchDefinitions(): Promise<void>; getRenderingPipeline(contentType: string): Promise<PipelineCore[]> }
  pages: {
    getPageFromDb(pageId: number): Promise<PageRecord | null>
    savePageToCache(page: PageRecord): Promise<void>
  }
  knex: Knex
}
interface WikiContext {
  models: Models
  configSvc: { loadFromDb(): Promise<void>; applyFlags(): Promise<void> }
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
}
interface Renderer {
  render(this: { config: unknown; children: unknown; page: PageRecord; input: string }): Promise<string> | string
}
const wiki = WIKI as unknown as WikiContext

type RenderPageJobInput = number | string | ({ readonly pageId: number } & PageRenderPublicationFence)
const sourceHash = (source: string): string => createHash('sha256').update(source).digest('hex')

const readPublishablePage = async (
  transaction: Knex.Transaction,
  pageId: number,
  sourceRevision: string,
  sourceSha256: string,
  fence: PageRenderPublicationFence | undefined
): Promise<PageRecord | undefined> => {
  await lockSearchIndex(transaction, false)
  await lockSearchPage(transaction, pageId)
  const current = await transaction<PageRecord>('pages').where({ id: pageId }).forUpdate().first()
  if (!current || String(current.sourceRevision) !== sourceRevision || sourceHash(current.content) !== sourceSha256) {
    return undefined
  }
  if (!fence) return current
  const effect = await transaction<{
    id: string
    pageId: number
    sourceRevision: string
    effectKind: string
    desiredState: string
    status: string
    leaseToken: string | null
    payload: string
    payloadSha256: string
    leaseExpiresAt: string | Date | null
  }>('pageMutationOutbox')
    .where({
      id: fence.effectId, pageId, sourceRevision: fence.sourceRevision, effectKind: 'render',
      desiredState: 'present', status: 'running', leaseToken: fence.leaseToken
    }).forUpdate().first('payload', 'payloadSha256', 'leaseExpiresAt')
  if (!effect || effect.leaseExpiresAt === null) return undefined
  const expiresAt = effect.leaseExpiresAt instanceof Date ? effect.leaseExpiresAt.valueOf() : Date.parse(effect.leaseExpiresAt)
  if (!(expiresAt > Date.now())) return undefined
  if (sourceHash(effect.payload) !== effect.payloadSha256) throw new Error('Render effect immutable payload hash does not match')
  const payload = PageProjectionPayloadSchema.parse(JSON.parse(effect.payload) as unknown)
  if (
    payload.effectKind !== 'render' || payload.desiredState !== 'present' || payload.pageId !== pageId ||
    payload.sourceRevision !== fence.sourceRevision || payload.sourceSha256 !== fence.sourceSha256 ||
    String(current.sourceRevision) !== fence.sourceRevision || sourceSha256 !== fence.sourceSha256 ||
    payload.location === null || current.localeCode !== payload.location.locale || current.path !== payload.location.path ||
    current.visibility !== payload.location.visibility || current.ownerId !== payload.location.ownerId
  ) {
    throw new Error('Render effect immutable intent does not match the current page source')
  }
  return current
}

export default async function renderPage(input: RenderPageJobInput): Promise<void> {
  const fence = typeof input === 'object' && input !== null ? input : undefined
  const normalizedPageId = Number(fence ? fence.pageId : input)
  if (!Number.isSafeInteger(normalizedPageId) || normalizedPageId < 1) throw new TypeError('Page ID must be a positive integer')
  if (fence && (
    typeof fence.effectId !== 'string' || !fence.effectId || typeof fence.leaseToken !== 'string' || !fence.leaseToken ||
    typeof fence.sourceRevision !== 'string' || !/^[1-9][0-9]*$/.test(fence.sourceRevision) ||
    typeof fence.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fence.sourceSha256)
  )) throw new TypeError('Render publication fence is invalid')
  wiki.logger.info(`Rendering page ID ${normalizedPageId}...`)
  let models: Models | undefined
  try {
    models = (await database.init()) as unknown as Models
    wiki.models = models
    await wiki.configSvc.loadFromDb()
    await wiki.configSvc.applyFlags()
    const page = await models.pages.getPageFromDb(normalizedPageId)
    if (!page) throw new Error('Invalid Page Id')
    const sourceRevision = String(page.sourceRevision)
    const sourceSha256 = sourceHash(page.content)
    if (fence && (sourceRevision !== fence.sourceRevision || sourceSha256 !== fence.sourceSha256)) {
      wiki.logger.info(`Skipped rendering page ID ${normalizedPageId} because its admitted source is no longer current. [ SKIPPED ]`)
      return
    }

    if (_.isEmpty(page.content)) {
      wiki.logger.warn(`Skipped rendering page ID ${normalizedPageId} because content was empty. [ SKIPPED ]`)
      return
    }

    await models.renderers.fetchDefinitions()
    const pipeline = await models.renderers.getRenderingPipeline(page.contentType)
    if (!pipeline.length) throw new Error(`No enabled rendering pipeline for ${page.contentType}. Existing output was preserved.`)
    let output = page.content
    for (const core of pipeline) {
      // Renderer implementations are selected from the enabled filesystem registry at runtime.
      const rendererModule = (await import(`../modules/rendering/${_.kebabCase(core.key)}/renderer.ts`)) as unknown as { default: Renderer }
      output = await rendererModule.default.render.call({
        config: core.config,
        children: core.children,
        page,
        input: output
      })
    }
    const toc = buildTocFromHtml(output)
    const renderModels = models
    const published = await renderModels.knex.transaction(async transaction => {
      const current = await readPublishablePage(transaction, normalizedPageId, sourceRevision, sourceSha256, fence)
      if (!current) return false
      // Derived writes bypass editorial hooks and publish only while the exact render lease is live.
      const updatedRows = await transaction('pages')
        .where({ id: normalizedPageId, sourceRevision })
        .update({ render: output, toc: JSON.stringify(toc), renderedSourceRevision: sourceRevision })
      return updatedRows === 1
    })
    if (!published) {
      wiki.logger.info(`Skipped rendering page ID ${normalizedPageId} because its source or render lease changed. [ SKIPPED ]`)
      return
    }
    // Cache I/O follows committed publication. This transaction only locks/reads,
    // so a cache write never represents a render rolled back with this transaction.
    const cached = await renderModels.knex.transaction(async transaction => {
      const current = await readPublishablePage(transaction, normalizedPageId, sourceRevision, sourceSha256, fence)
      if (!current || current.render !== output || String(current.renderedSourceRevision) !== sourceRevision) return false
      await renderModels.pages.savePageToCache({ ...page, ...current })
      return true
    })
    if (!cached) {
      wiki.logger.info(`Skipped caching page ID ${normalizedPageId} because its render publication changed. [ SKIPPED ]`)
      return
    }
    wiki.logger.info(`Rendering page ID ${normalizedPageId}: [ COMPLETED ]`)
  } catch (error) {
    wiki.logger.error(`Rendering page ID ${normalizedPageId}: [ FAILED ]`)
    wiki.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    throw error
  } finally {
    await models?.knex.destroy()
  }
}
