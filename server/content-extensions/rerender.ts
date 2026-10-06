import type { Knex } from 'knex'
import { parseMarkdownCodeFences } from '../../shared/markdown-code-fence.ts'
import { admitPageRenderEffect } from '../core/page-mutation-outbox.ts'
import { lockSearchIndex, lockSearchPage } from '../helpers/search-contract.ts'

interface ExtensionPage {
  id: number
  hash: string
  content: string
}

interface CanonicalExtensionPage extends ExtensionPage {
  sourceRevision: string | number
  localeCode: string
  path: string
  visibility: 'public' | 'private'
  ownerId: number | null
}

export interface ContentExtensionRerenderContext {
  events: { outbound: { emit(event: string, value: unknown): void } }
  models: {
    pages: {
      deletePageFromCache(hash: string): Promise<unknown>
    }
  }
}

const rerenderBatchSize = 250

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
      const admittedPage = await knex.transaction(async transaction => {
        await lockSearchIndex(transaction, false)
        signal.throwIfAborted()
        await lockSearchPage(transaction, page.id)
        signal.throwIfAborted()
        const currentPage = await transaction<CanonicalExtensionPage>('pages')
          .select('id', 'hash', 'content', 'sourceRevision', 'localeCode', 'path', 'visibility', 'ownerId')
          .where({ id: page.id })
          .forUpdate()
          .first()
        signal.throwIfAborted()
        if (!currentPage || !pageContainsExtension(currentPage.content, key)) return undefined
        await admitPageRenderEffect(transaction, {
          pageId: currentPage.id,
          sourceRevision: currentPage.sourceRevision,
          source: currentPage.content,
          location: {
            locale: currentPage.localeCode,
            path: currentPage.path,
            visibility: currentPage.visibility,
            ownerId: currentPage.ownerId
          }
        })
        signal.throwIfAborted()
        return currentPage
      })
      if (!admittedPage) continue
      rerendered += 1
      signal.throwIfAborted()
      await wiki.models.pages.deletePageFromCache(admittedPage.hash)
      signal.throwIfAborted()
      wiki.events.outbound.emit('deletePageFromCache', admittedPage.hash)
    }
    signal.throwIfAborted()
    if (candidates.length < rerenderBatchSize) break
  }
  return rerendered
}
