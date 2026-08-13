import _ from 'lodash'
import database from '../core/db.ts'
import { buildTocFromHtml } from './render-page-toc.ts'

interface PageRecord {
  content: string
  contentType: string
  [key: string]: unknown
}
interface PipelineCore { key: string, config: unknown, children: unknown }
interface PageQuery extends PromiseLike<unknown> {
  patch(data: Record<string, unknown>): PageQuery
  where(column: string, value: unknown): PageQuery
}
interface Models {
  renderers: { fetchDefinitions(): Promise<void>, getRenderingPipeline(contentType: string): Promise<PipelineCore[]> }
  pages: {
    getPageFromDb(pageId: number): Promise<PageRecord | null>
    query(): PageQuery
    savePageToCache(page: PageRecord): Promise<void>
  }
  knex: { destroy(): Promise<void> }
}
interface WikiContext {
  models: Models
  configSvc: { loadFromDb(): Promise<void>, applyFlags(): Promise<void> }
  logger: { info(message: string): void, warn(message: string): void, error(message: string): void }
}
interface Renderer {
  render(this: { config: unknown, children: unknown, page: PageRecord, input: string }): Promise<string> | string
}
const wiki = WIKI as unknown as WikiContext

export default async function renderPage (pageId: number | string): Promise<void> {
  const normalizedPageId = Number(pageId)
  if (!Number.isSafeInteger(normalizedPageId) || normalizedPageId < 1) throw new TypeError('Page ID must be a positive integer')
  wiki.logger.info(`Rendering page ID ${normalizedPageId}...`)
  try {
    wiki.models = await database.init() as unknown as Models
    await wiki.configSvc.loadFromDb()
    await wiki.configSvc.applyFlags()
    const page = await wiki.models.pages.getPageFromDb(normalizedPageId)
    if (!page) throw new Error('Invalid Page Id')

    await wiki.models.renderers.fetchDefinitions()
    const pipeline = await wiki.models.renderers.getRenderingPipeline(page.contentType)
    let output = page.content
    if (_.isEmpty(page.content)) {
      await wiki.models.knex.destroy()
      wiki.logger.warn(`Failed to render page ID ${pageId} because content was empty: [ FAILED ]`)
    }
    for (const core of pipeline) {
      const rendererModule = await import(`../modules/rendering/${_.kebabCase(core.key)}/renderer.ts`) as unknown as { default: Renderer }
      output = await rendererModule.default.render.call({
        config: core.config,
        children: core.children,
        page,
        input: output
      })
    }
    const toc = buildTocFromHtml(output)
    await wiki.models.pages.query().patch({ render: output, toc: JSON.stringify(toc) }).where('id', normalizedPageId)
    await wiki.models.pages.savePageToCache({ ...page, render: output, toc: JSON.stringify(toc) })
    await wiki.models.knex.destroy()
    wiki.logger.info(`Rendering page ID ${normalizedPageId}: [ COMPLETED ]`)
  } catch (error) {
    wiki.logger.error(`Rendering page ID ${normalizedPageId}: [ FAILED ]`)
    wiki.logger.error(error instanceof Error ? error.stack ?? error.message : String(error))
    throw error
  }
}
