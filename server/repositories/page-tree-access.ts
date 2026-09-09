import type { Knex } from 'knex'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { canReadPage, canWritePage, scopePageQuery, type PagePrincipal, type PageVisibility } from '../helpers/page-access.ts'
interface TreePage {
  id: number
  pageId: number
  ancestors: string | number[]
  path: string
  localeCode: string
  visibility: PageVisibility
  ownerId: number | null
  isPublished: boolean
  publishStartDate: string | null
  publishEndDate: string | null
}

export const treeAncestorIds = (value: unknown): number[] => {
  let ids = value
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids) } catch { return [] }
  }
  return Array.isArray(ids) ? ids.filter(id => Number.isSafeInteger(id) && id > 0) : []
}

/** Evaluate current page rules against lightweight, bounded batches; never fetch page content. */
export const pageTreeAccess = async (db: Knex, requester: PagePrincipal, locale: string, authority: PageRuleAuthority) => {
  const readable = new Set<number>(), editable = new Set<number>(), reachable = new Set<number>()
  const now = Date.now(), batchSize = 1000
  let cursor = 0
  while (true) {
    const query = db<TreePage>('pageTree as tree')
      .innerJoin('pages as page', 'page.id', 'tree.pageId')
      .select('tree.id', 'tree.pageId', 'tree.ancestors', 'page.path', 'page.localeCode', 'page.visibility', 'page.ownerId', 'page.isPublished', 'page.publishStartDate', 'page.publishEndDate')
      .where('tree.localeCode', locale)
      .whereRaw('?? = ??', ['tree.path', 'page.path'])
      .whereRaw('?? = ??', ['tree.localeCode', 'page.localeCode'])
      .whereRaw('?? = ??', ['tree.visibility', 'page.visibility'])
      .whereRaw('?? IS NOT DISTINCT FROM ??', ['tree.ownerId', 'page.ownerId'])
      .where('tree.id', '>', cursor)
      .orderBy('tree.id').limit(batchSize)
    scopePageQuery(query, requester, { table: 'page' })
    const rows = await query
    if (!rows.length) break
    const tagRows = await db<{ pageId: number; tag: string }>('pageTags')
      .innerJoin('tags', 'tags.id', 'pageTags.tagId')
      .select('pageTags.pageId', 'tags.tag')
      .whereIn('pageTags.pageId', rows.map(row => row.pageId))
    const tags = new Map<number, string[]>()
    for (const row of tagRows) {
      const values = tags.get(row.pageId) ?? []
      values.push(row.tag)
      tags.set(row.pageId, values)
    }
    for (const row of rows) {
      const page = { ...row, tags: tags.get(row.pageId) ?? [] }
      if (!canReadPage(requester, page, authority)) continue
      const canEdit = canWritePage(requester, page, authority)
      const published = page.isPublished &&
        (!page.publishStartDate || new Date(page.publishStartDate).valueOf() <= now) &&
        (!page.publishEndDate || new Date(page.publishEndDate).valueOf() >= now)
      if (page.visibility === 'public' && !published && !canEdit) continue
      readable.add(row.id)
      if (canEdit) editable.add(row.id)
      for (const id of treeAncestorIds(row.ancestors)) reachable.add(id)
    }
    cursor = rows.at(-1)!.id
    if (rows.length < batchSize) break
  }
  return { readable, editable, reachable }
}
