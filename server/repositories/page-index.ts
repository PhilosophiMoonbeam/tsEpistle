import type { Knex } from 'knex'

export const PAGE_INDEX_CANDIDATE_LIMIT = 5_001

export interface PageIndexCandidate {
  id: number
  path: string
  localeCode: string
  title: string
  description: string | null
  visibility: 'public' | 'private'
  ownerId: number | null
  updatedAt: Date | string
  tags: Array<{ tag: string }>
}

type PageIndexRow = Omit<PageIndexCandidate, 'tags'>
interface PageTagRow { pageId: number, tag: string }

export const listPageIndexCandidates = async (
  knex: Knex,
  input: {
    locale: string
    path: string
    limit?: number
    scope: (query: Knex.QueryBuilder) => void
  }
): Promise<PageIndexCandidate[]> => {
  const limit = input.limit ?? PAGE_INDEX_CANDIDATE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_INDEX_CANDIDATE_LIMIT) {
    throw new TypeError(`Page index candidate limit must be between 1 and ${PAGE_INDEX_CANDIDATE_LIMIT}`)
  }

  const query = knex<PageIndexRow>('pages')
    .select('id', 'path', 'localeCode', 'title', 'description', 'visibility', 'ownerId', 'updatedAt')
    .where('localeCode', input.locale)
  if (input.path.length > 0) {
    query.whereRaw('starts_with(??, ?)', ['pages.path', `${input.path}/`])
  }
  input.scope(query)
  const pages = await query.orderBy('path', 'asc').limit(limit)
  if (pages.length === 0 || pages.length >= limit) {
    return pages.map(page => ({ ...page, tags: [] }))
  }

  const tagRows = await knex<PageTagRow>('pageTags')
    .select('pageTags.pageId', 'tags.tag')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .whereIn('pageTags.pageId', pages.map(page => page.id))
    .orderBy('pageTags.pageId', 'asc')
    .orderBy('tags.tag', 'asc')
  const tagsByPage = new Map<number, Array<{ tag: string }>>()
  for (const row of tagRows) {
    const tags = tagsByPage.get(row.pageId) ?? []
    tags.push({ tag: row.tag })
    tagsByPage.set(row.pageId, tags)
  }
  return pages.map(page => ({ ...page, tags: tagsByPage.get(page.id) ?? [] }))
}
