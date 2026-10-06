import { describe, expect, it } from '../bun-test.mts'
import { paginateSearch } from '../../helpers/search-pagination.ts'

const row = (id: number) => ({ id, locale: 'en', path: `page-${id}`, visibility: 'public', title: `Page ${id}` })
const window = (ids: number[]) => ({ results: ids.map(row), suggestions: [], totalHits: ids.length, windowTruncated: false })
describe('authorized search continuation', () => {
  it('preserves ranking across pages and drops revoked results without disclosing them or skipping accessible rows', async () => {
    const ids = Array.from({ length: 45 }, (_, index) => index + 1)
    const first = await paginateSearch({
      owner: 'alice',
      queryKey: 'docs',
      search: async retainedPageIds => {
        expect(retainedPageIds).toBeUndefined()
        return window(ids)
      }
    })
    expect(first.results.map(row => row.id)).toEqual(ids.slice(0, 20))
    const second = await paginateSearch({
      owner: 'alice',
      queryKey: 'docs',
      cursor: first.nextCursor!,
      search: async retainedPageIds => {
        expect(retainedPageIds).toEqual(ids)
        const current = window([99, ...ids.filter(id => id !== 21).reverse()])
        current.results = current.results.map(result => ({ ...result, title: `Current page ${result.id}` }))
        return current
      }
    })
    expect(second.results.map(row => row.id)).toEqual(ids.slice(21, 41))
    expect(second.totalHits).toBe(44)
    expect(second.results.some(row => row.id === 99)).toBe(false)
    expect(second.results[0]?.title).toBe('Current page 22')
    const third = await paginateSearch({
      owner: 'alice',
      queryKey: 'docs',
      cursor: second.nextCursor!,
      search: async retainedPageIds => {
        expect(retainedPageIds).toEqual(ids)
        return window(ids)
      }
    })
    expect(third.results.map(row => row.id)).toEqual([42, 43, 44, 45])
    expect(third.nextCursor).toBeNull()
  })
  it('binds opaque cursors to the owner, query, and short lifetime', async () => {
    const input = { owner: 'alice', queryKey: 'docs', now: 1000, search: async () => window(Array.from({ length: 21 }, (_, index) => index + 1)) }
    const first = await paginateSearch(input)
    for (const patch of [{ owner: 'bob' }, { queryKey: 'secrets' }, { now: 301001 }]) {
      await expect(paginateSearch({ ...input, ...patch, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 })
    }
  })
})
