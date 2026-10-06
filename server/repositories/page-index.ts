import type { Knex } from 'knex'
import { publicationTimestampSql } from '../helpers/search-contract.ts'

export const PAGE_INDEX_CANDIDATE_LIMIT = 5_001

export interface PageIndexCandidate {
  id: number
  sourceRevision: string
  path: string
  localeCode: string
  title: string
  description: string | null
  visibility: 'public' | 'private'
  isSearchable: boolean
  ownerId: number | null
  updatedAt: Date | string
  tags: Array<{ tag: string }>
}

type PageIndexRow = Omit<PageIndexCandidate, 'tags'>
interface PageTagRow {
  pageId: number
  tag: string
}

export const listPageIndexCandidates = async (
  knex: Knex,
  input: {
    locale: string
    path: string
    limit?: number
    scope: (query: Knex.QueryBuilder) => void
    accept?: (page: PageIndexCandidate) => boolean
  }
): Promise<PageIndexCandidate[]> => {
  const limit = input.limit ?? PAGE_INDEX_CANDIDATE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_INDEX_CANDIDATE_LIMIT) {
    throw new TypeError(`Page index candidate limit must be between 1 and ${PAGE_INDEX_CANDIDATE_LIMIT}`)
  }

  const query = knex<PageIndexRow>('pages')
    .select('id', 'sourceRevision', 'path', 'localeCode', 'title', 'description', 'visibility', 'ownerId', 'updatedAt', 'isSearchable')
    .where('localeCode', input.locale)
    .where('pages.isSearchable', true)
    .where(visibility => {
      visibility.where('pages.visibility', 'private').orWhere(publicPages => {
        publicPages.where('pages.visibility', 'public').where('pages.isPublished', true)
        publicPages.whereRaw(
          `(NULLIF("pages"."publishStartDate", '') IS NULL OR ${publicationTimestampSql('"pages"."publishStartDate"')} <= CURRENT_TIMESTAMP)`
        )
        publicPages.whereRaw(`(NULLIF("pages"."publishEndDate", '') IS NULL OR ${publicationTimestampSql('"pages"."publishEndDate"')} >= CURRENT_TIMESTAMP)`)
      })
    })
  if (input.path.length > 0) {
    query.whereRaw('starts_with(??, ?)', ['pages.path', `${input.path}/`])
  }
  input.scope(query)
  query.orderBy('path', 'asc').orderBy('id', 'asc')
  const batchSize = input.accept ? Math.min(limit, 500) : limit
  const candidates: PageIndexCandidate[] = []
  let cursor: Pick<PageIndexRow, 'path' | 'id'> | undefined
  while (candidates.length < limit) {
    const batch = query.clone().limit(batchSize)
    if (cursor) {
      const after = cursor
      batch.where(next => {
        next.where('pages.path', '>', after.path).orWhere(tie => {
          tie.where('pages.path', after.path).where('pages.id', '>', after.id)
        })
      })
    }
    const pages = await batch
    if (pages.length === 0) return candidates

    const tagRows = await knex<PageTagRow>('pageTags')
      .select('pageTags.pageId', 'tags.tag')
      .innerJoin('tags', 'tags.id', 'pageTags.tagId')
      .whereIn(
        'pageTags.pageId',
        pages.map(page => page.id)
      )
      .orderBy('pageTags.pageId', 'asc')
      .orderBy('tags.tag', 'asc')
    const tagsByPage = new Map<number, Array<{ tag: string }>>()
    for (const row of tagRows) {
      const tags = tagsByPage.get(row.pageId) ?? []
      tags.push({ tag: row.tag })
      tagsByPage.set(row.pageId, tags)
    }
    for (const page of pages) {
      const candidate = { ...page, tags: tagsByPage.get(page.id) ?? [] }
      if (!input.accept || input.accept(candidate)) candidates.push(candidate)
      if (candidates.length === limit) return candidates
    }
    if (pages.length < batchSize) return candidates
    cursor = pages[pages.length - 1]
  }
  return candidates
}
