import type { Knex } from 'knex'
import { parseMarkdownCodeFences } from '../../shared/markdown-code-fence.ts'

interface ExtensionPage {
  id: number
  hash: string
  content: string
}

interface SearchableExtensionPage extends ExtensionPage {
  visibility: string
  isPublished: boolean | number
  safeContent: string
}

export interface ContentExtensionRerenderContext {
  data: {
    searchEngine: {
      deleted(page: SearchableExtensionPage): Promise<unknown>
      updated(page: SearchableExtensionPage): Promise<unknown>
    }
  }
  events: { outbound: { emit(event: string, value: unknown): void } }
  models: {
    pages: {
      deletePageFromCache(hash: string): Promise<unknown>
      getPageFromDb(pageId: number): Promise<SearchableExtensionPage | undefined>
      prepareSearchDocument(page: SearchableExtensionPage): Promise<SearchableExtensionPage>
      renderPage(page: ExtensionPage): Promise<unknown>
    }
  }
}

const rerenderBatchSize = 250

const isPublishedPublicPage = (page: SearchableExtensionPage): boolean => page.visibility === 'public' && (page.isPublished === true || page.isPublished === 1)

const pageContainsExtension = (content: string, key: string): boolean => {
  for (const fence of parseMarkdownCodeFences(content)) {
    if (fence.info.trim() !== 'wiki-extension') continue
    try {
      const parsed: unknown = JSON.parse(fence.content)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Reflect.get(parsed, 'key') === key) {
        return true
      }
    } catch {
      // Invalid extension fences already render as escaped source and cannot leave active output behind.
    }
  }
  return false
}

export const rerenderPagesForContentExtension = async (
  knex: Knex,
  wiki: ContentExtensionRerenderContext,
  key: string,
  signal: AbortSignal
): Promise<number> => {
  let afterId = 0
  let rerendered = 0
  while (true) {
    signal.throwIfAborted()
    const candidates = await knex<ExtensionPage>('pages')
      .select('id', 'hash', 'content')
      .where('id', '>', afterId)
      .where('content', 'like', '%wiki-extension%')
      .orderBy('id', 'asc')
      .limit(rerenderBatchSize)
    signal.throwIfAborted()
    if (candidates.length === 0) break
    afterId = candidates.at(-1)?.id ?? afterId
    const pages = candidates.filter(page => pageContainsExtension(page.content, key))
    for (const page of pages) {
      signal.throwIfAborted()
      await wiki.models.pages.deletePageFromCache(page.hash)
      signal.throwIfAborted()
      wiki.events.outbound.emit('deletePageFromCache', page.hash)
      signal.throwIfAborted()
      const indexedPage = await wiki.models.pages.getPageFromDb(page.id)
      if (!indexedPage) continue
      if (isPublishedPublicPage(indexedPage)) {
        signal.throwIfAborted()
        await wiki.data.searchEngine.deleted(indexedPage)
      }
      signal.throwIfAborted()
      await wiki.models.pages.renderPage(page)
      rerendered += 1
      signal.throwIfAborted()
      const renderedPage = await wiki.models.pages.getPageFromDb(page.id)
      if (renderedPage && isPublishedPublicPage(renderedPage)) {
        signal.throwIfAborted()
        const searchDocument = await wiki.models.pages.prepareSearchDocument(renderedPage)
        signal.throwIfAborted()
        await wiki.data.searchEngine.updated(searchDocument)
      }
    }
    signal.throwIfAborted()
    if (candidates.length < rerenderBatchSize) break
  }
  return rerendered
}
