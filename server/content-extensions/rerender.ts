import type { Knex } from 'knex'

interface ExtensionPage {
  id: number
  hash: string
  content: string
}

export interface ContentExtensionRerenderContext {
  events: { outbound: { emit(event: string, value: unknown): void } }
  models: {
    pages: {
      deletePageFromCache(hash: string): Promise<unknown>
      renderPage(page: ExtensionPage): Promise<unknown>
    }
  }
}

const rerenderBatchSize = 250

const pageContainsExtension = (content: string, key: string): boolean => {
  const fences = /^```wiki-extension[ \t]*\r?\n([^\r\n]*)\r?\n```[ \t]*$/gm
  for (const match of content.matchAll(fences)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? '')
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
  key: string
): Promise<number> => {
  let afterId = 0
  let rerendered = 0
  while (true) {
    const candidates = await knex<ExtensionPage>('pages')
      .select('id', 'hash', 'content')
      .where('id', '>', afterId)
      .where('content', 'like', '%```wiki-extension%')
      .orderBy('id', 'asc')
      .limit(rerenderBatchSize)
    if (candidates.length === 0) break
    afterId = candidates.at(-1)?.id ?? afterId
    const pages = candidates.filter(page => pageContainsExtension(page.content, key))
    for (const page of pages) {
      await wiki.models.pages.deletePageFromCache(page.hash)
      wiki.events.outbound.emit('deletePageFromCache', page.hash)
    }
    for (const page of pages) await wiki.models.pages.renderPage(page)
    rerendered += pages.length
    if (candidates.length < rerenderBatchSize) break
  }
  return rerendered
}
