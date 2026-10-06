import { randomUUID } from 'node:crypto'

interface SearchRow {
  id?: unknown
  locale: string
  path: string
  visibility?: unknown
}
interface SearchWindow<Row extends SearchRow> {
  results: Row[]
  suggestions: string[]
  totalHits: number
  windowTruncated?: boolean
  windowLimit?: number
}
interface Snapshot {
  owner: string
  queryKey: string
  identities: string[]
  pageIds: readonly number[]
  expiresAt: number
}
const snapshots = new Map<string, Snapshot>()
const PAGE_SIZE = 20
const MAX_SNAPSHOTS = 128
const identity = (row: SearchRow): string => JSON.stringify([row.id, row.locale, row.path, row.visibility])
export class SearchCursorError extends Error {
  readonly status = 409
}

/** Retain ordered identities only. Every continuation retrieves and authorizes current results again. */
export const paginateSearch = async <Row extends SearchRow>(input: {
  owner: string
  queryKey: string
  cursor?: string
  search: (retainedPageIds?: readonly number[]) => Promise<SearchWindow<Row>>
  now?: number
}): Promise<SearchWindow<Row> & { nextCursor: string | null; snapshotCount: number }> => {
  const now = input.now ?? Date.now()
  for (const [key, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(key)
  let token = randomUUID() as string
  let offset = 0
  let snapshot: Snapshot | undefined
  if (input.cursor) {
    const match = /^([0-9a-f-]{36}):(\d{1,5})$/.exec(input.cursor)
    snapshot = match ? snapshots.get(match[1]!) : undefined
    if (!match || !snapshot || snapshot.owner !== input.owner || snapshot.queryKey !== input.queryKey)
      throw new SearchCursorError('This search has expired. Search again for current results.')
    token = match[1]!
    offset = Number(match[2])
    if (offset > snapshot.identities.length) throw new SearchCursorError('This search cursor is invalid. Search again.')
  }
  const response = await input.search(snapshot?.pageIds)
  if (!snapshot) {
    const canonicalIds = new Set<number>()
    for (const row of response.results) if (typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0) canonicalIds.add(row.id)
    const pageIds = [...canonicalIds]
    snapshot = { owner: input.owner, queryKey: input.queryKey, identities: [...new Set(response.results.map(identity))], pageIds, expiresAt: now + 5 * 60_000 }
    while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
    snapshots.set(token, snapshot)
  }
  const current = new Map(response.results.map(row => [identity(row), row]))
  const visible = snapshot.identities.filter(key => current.has(key))
  // Advance against the original snapshot, so revoked or deleted rows never shift earlier pages.
  const selected: Row[] = []
  while (offset < snapshot.identities.length && selected.length < PAGE_SIZE) {
    const row = current.get(snapshot.identities[offset++]!)
    if (row) selected.push(row)
  }
  const hasMore = snapshot.identities.slice(offset).some(key => current.has(key))
  return { ...response, results: selected, totalHits: visible.length, snapshotCount: visible.length, nextCursor: hasMore ? `${token}:${offset}` : null }
}
